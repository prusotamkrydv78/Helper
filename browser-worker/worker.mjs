// Managed browser worker for AI Automation.
//
// Started by the Rust backend (src-tauri/src/browser/worker.rs). Protocol:
// one JSON object per line on stdin: { id, method, params }; one per line on
// stdout: { id, ok: true, result } | { id, ok: false, error: { code, message } }.
// Logs go to stderr. The process exits when stdin closes.
//
// Environment:
//   AA_BROWSER_CHANNEL   msedge (default) | chrome | chromium
//   AA_BROWSER_HEADLESS  0 (default: visible window) | 1 to hide it. Search engines
//                        tend to block headless browsers, so visible is the default.
//   AA_SEARCH_URL        search results URL prefix (default DuckDuckGo HTML)
//   AA_BROWSER_TEST_ALLOW_HOSTS  comma-separated host:port allowed despite the
//                        private-address policy — automated tests only

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { chromium } from "playwright-core";
import { createPolicy } from "./policy.mjs";

const NAV_TIMEOUT = 20_000;
const ACTION_TIMEOUT = 10_000;
const MAX_CONTENT_CHARS = 12_000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const SEARCH_URL = process.env.AA_SEARCH_URL || "https://html.duckduckgo.com/html/?q=";

const policy = createPolicy({ allowHosts: (process.env.AA_BROWSER_TEST_ALLOW_HOSTS || "").split(",") });
// Requests are fetched by this process (route.fetch); re-check addresses when it connects.
policy.guardDnsLookup();
const log = (...a) => process.stderr.write(`[browser-worker] ${a.join(" ")}\n`);

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let browser = null;
let context = null;
let page = null;
let blocked = []; // destinations blocked since the last action

async function launch() {
  const channel = process.env.AA_BROWSER_CHANNEL || "msedge";
  const headless = process.env.AA_BROWSER_HEADLESS === "1";
  try {
    return await chromium.launch({
      channel: channel === "chromium" ? undefined : channel,
      headless,
      // WebRTC traffic doesn't pass the request router; keep it off local addresses.
      args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
  } catch (e) {
    throw new ToolError(
      "browser_unavailable",
      `Couldn't start the browser (${channel}). Install Microsoft Edge or set AA_BROWSER_CHANNEL. ${String(e.message).split("\n")[0]}`,
    );
  }
}

async function ensurePage() {
  if (page && !page.isClosed()) return page;
  browser ??= await launch();
  // Service workers could fetch outside the request router, so they're blocked.
  context = await browser.newContext({ acceptDownloads: true, serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(ACTION_TIMEOUT);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT);
  // Every HTTP(S) request — navigations, scripts, fetch/XHR — passes the policy.
  // Requests are fetched here with redirects disabled so each redirect hop is
  // checked too (the browser would otherwise follow redirects unseen).
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    const mainFrameNav = req.isNavigationRequest() && page && req.frame() === page.mainFrame();
    const deny = (target, reason) => {
      blocked.push({ url: target.slice(0, 200), reason, navigation: mainFrameNav });
      log("blocked", target.slice(0, 200), "-", reason);
      return route.abort("blockedbyclient");
    };
    const verdict = await policy.check(url);
    if (!verdict.ok) return deny(url, verdict.reason);
    if (!/^https?:/.test(url)) return route.continue();

    let response;
    let current = url;
    try {
      response = await route.fetch({ maxRedirects: 0, timeout: NAV_TIMEOUT });
      for (let hop = 0; ; hop++) {
        const status = response.status();
        const location = response.headers()["location"];
        if (!(status >= 300 && status < 400 && location)) break;
        const next = new URL(location, current).href;
        const v = await policy.check(next);
        if (!v.ok) return deny(next, `Redirect blocked: ${v.reason}`);
        if (hop >= 10) return route.abort("failed");
        if (req.isNavigationRequest()) {
          // The browser can't take a fulfilled 3xx for a navigation; hand it a
          // page that navigates on, so the next hop is intercepted and checked.
          return route.fulfill({
            status: 200,
            contentType: "text/html",
            body: `<!doctype html><title>${REDIRECT_TITLE}</title><script>location.replace(${JSON.stringify(next)})</script>`,
          });
        }
        current = next;
        response = await route.fetch({ url: next, maxRedirects: 0, timeout: NAV_TIMEOUT });
      }
    } catch (e) {
      log("request failed", url.slice(0, 200), "-", String(e.message).split("\n")[0]);
      return route.abort("failed");
    }
    return route.fulfill({ response });
  });
  await context.routeWebSocket(/.*/, async (ws) => {
    const verdict = await policy.check(ws.url());
    if (verdict.ok) return ws.connectToServer();
    blocked.push({ url: ws.url().slice(0, 200), reason: verdict.reason });
    ws.close({ code: 1008, reason: "blocked" });
  });
  page = await context.newPage();
  log("session started");
  return page;
}

function takeBlocked() {
  const b = blocked;
  blocked = [];
  return b.length ? b.slice(0, 10) : undefined;
}

async function pageSummary(p, extra = {}) {
  return { url: p.url(), title: await p.title().catch(() => ""), ...extra, blocked: takeBlocked() };
}

// ---------------------------------------------------------------------------
// Page reading: readable text, links, and interactive elements with stable refs
// ---------------------------------------------------------------------------

function extractInPage(maxChars) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const clean = (t, n) => (t || "").replace(/\s+/g, " ").trim().slice(0, n);
  document.querySelectorAll("[data-aa-ref]").forEach((el) => el.removeAttribute("data-aa-ref"));

  const root = document.querySelector("main, article, [role=main]") || document.body;
  const text = clean(root ? root.innerText : "", maxChars + 1);

  const links = [];
  const seen = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    if (links.length >= 40) break;
    const href = a.href;
    if (!/^https?:/.test(href) || seen.has(href) || !visible(a)) continue;
    seen.add(href);
    links.push({ text: clean(a.innerText || a.getAttribute("aria-label"), 80), url: href });
  }

  const elements = [];
  const selector = "a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [contenteditable=true]";
  let n = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (elements.length >= 60) break;
    if (!visible(el)) continue;
    const ref = `e${++n}`;
    el.setAttribute("data-aa-ref", ref);
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const label =
      el.getAttribute("aria-label") ||
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      el.getAttribute("title") ||
      "";
    elements.push({
      ref,
      tag,
      type: type || undefined,
      text: clean(el.innerText || el.value || "", 80) || undefined,
      label: clean(label, 80) || undefined,
      href: tag === "a" ? el.href : undefined,
    });
  }
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars, links, elements };
}

function describeInPage(ref) {
  const el = document.querySelector(`[data-aa-ref="${ref}"]`);
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || (tag === "button" ? "submit" : "")).toLowerCase();
  const form = el.form || el.closest("form");
  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
  return {
    tag,
    type,
    text: (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80),
    inForm: Boolean(form),
    formAction: form ? form.action : null,
    formMethod: form ? (form.getAttribute("method") || "get").toLowerCase() : null,
    submitsForm: Boolean(form) && ((tag === "button" && type === "submit") || (tag === "input" && (type === "submit" || type === "image"))),
    isFileInput: tag === "input" && type === "file",
    isSensitiveInput:
      (tag === "input" && type === "password") || /cc-|password|one-time-code/.test(autocomplete),
    href: tag === "a" ? el.href : null,
  };
}

async function locate(p, ref) {
  if (typeof ref !== "string" || !/^e\d+$/.test(ref)) throw new ToolError("invalid_arguments", "`ref` must look like e12.");
  const loc = p.locator(`[data-aa-ref="${ref}"]`);
  const count = await loc.count();
  if (count !== 1) {
    throw new ToolError("stale_ref", `Element ${ref} isn't on the page anymore. Call browser_get_page_content to get fresh refs.`);
  }
  return loc;
}

const REDIRECT_TITLE = "__aa_redirect__";

/** Follows checked redirect hops (see the route handler). Returns the last response, if any. */
async function followRedirects(p, response) {
  for (let i = 0; i < 11; i++) {
    const title = await p.title().catch(() => "");
    if (title !== REDIRECT_TITLE) return response;
    const nav = await p.waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => null);
    if (!nav && (await p.title().catch(() => "")) === REDIRECT_TITLE) break;
    response = nav ?? response;
  }
  return response;
}

// After an action, wait briefly for any navigation it started.
async function settle(p, before) {
  await p.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  await p.waitForTimeout(300);
  await followRedirects(p, null);
  return p.url() !== before;
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

const methods = {
  async open({ url }) {
    const verdict = await policy.check(url);
    if (!verdict.ok) throw new ToolError("blocked_url", verdict.reason);
    // Each open gets a fresh tab in the same session (cookies are kept), so
    // leftover navigations from the previous page can't interfere.
    await ensurePage();
    const old = page;
    page = await context.newPage();
    await old.close().catch(() => {});
    const p = page;
    blocked = [];
    let response;
    try {
      response = await p.goto(url, { waitUntil: "domcontentloaded" });
      response = await followRedirects(p, response);
    } catch (e) {
      const b = takeBlocked();
      if (b) throw new ToolError("blocked_url", b[0].reason);
      throw new ToolError("navigation_failed", String(e.message).split("\n")[0]);
    }
    // A redirect to a blocked destination is aborted by the route handler; report it as a failure.
    const navBlock = blocked.find((b) => b.navigation);
    if (navBlock) {
      takeBlocked();
      throw new ToolError("blocked_url", `Redirect blocked: ${navBlock.reason}`);
    }
    return pageSummary(p, { status: response ? response.status() : null });
  },

  async content({ maxChars }) {
    const p = await ensurePage();
    if (p.url() === "about:blank") throw new ToolError("no_page", "No page is open. Call browser_open first.");
    const limit = Math.min(Math.max(Number(maxChars) || MAX_CONTENT_CHARS, 500), MAX_CONTENT_CHARS);
    const data = await p.evaluate(extractInPage, limit);
    return pageSummary(p, data);
  },

  async describe({ ref }) {
    const p = await ensurePage();
    await locate(p, ref);
    return p.evaluate(describeInPage, ref);
  },

  async click({ ref }) {
    const p = await ensurePage();
    const loc = await locate(p, ref);
    const info = await p.evaluate(describeInPage, ref);
    if (info?.isFileInput) throw new ToolError("not_supported", "File uploads are not supported.");
    const before = p.url();
    await loc.click();
    const navigated = await settle(p, before);
    return pageSummary(p, { clicked: info?.text || ref, navigated });
  },

  async type({ ref, text, submit }) {
    if (typeof text !== "string") throw new ToolError("invalid_arguments", "`text` must be a string.");
    const p = await ensurePage();
    const loc = await locate(p, ref);
    const info = await p.evaluate(describeInPage, ref);
    if (info?.isFileInput) throw new ToolError("not_supported", "File uploads are not supported.");
    if (!["input", "textarea"].includes(info?.tag) && info?.tag !== "div") {
      throw new ToolError("invalid_arguments", `Element ${ref} is a <${info?.tag}>, not a text field.`);
    }
    await loc.fill(text);
    let navigated = false;
    if (submit) {
      const before = p.url();
      await loc.press("Enter");
      navigated = await settle(p, before);
    }
    return pageSummary(p, { typed: text.length, submitted: Boolean(submit), navigated });
  },

  async search({ query }) {
    if (typeof query !== "string" || !query.trim()) throw new ToolError("invalid_arguments", "`query` is required.");
    const p = await ensurePage();
    const url = SEARCH_URL + encodeURIComponent(query.trim());
    try {
      await p.goto(url, { waitUntil: "domcontentloaded" });
    } catch (e) {
      throw new ToolError("navigation_failed", String(e.message).split("\n")[0]);
    }
    const results = await p.evaluate(() => {
      const unwrap = (href) => {
        try {
          const u = new URL(href, location.href);
          return u.searchParams.get("uddg") || u.href; // DuckDuckGo redirect links
        } catch {
          return href;
        }
      };
      const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
      // DuckDuckGo HTML markup
      let items = [...document.querySelectorAll(".result")].map((r) => {
        const a = r.querySelector(".result__a, a[href]");
        return { title: text(a), url: a ? unwrap(a.getAttribute("href")) : "", snippet: text(r.querySelector(".result__snippet")) };
      });
      // Bing markup (AA_SEARCH_URL=https://www.bing.com/search?q=)
      if (!items.length) {
        items = [...document.querySelectorAll("li.b_algo")].map((r) => {
          const a = r.querySelector("h2 a");
          let url = a?.href || "";
          const u = url ? new URL(url).searchParams.get("u") : null;
          if (u && u.startsWith("a1")) {
            try {
              url = atob(u.slice(2).replace(/-/g, "+").replace(/_/g, "/")); // Bing click-tracking link
            } catch {}
          }
          return { title: text(r.querySelector("h2")), url, snippet: text(r.querySelector("p")) };
        });
      }
      return items
        .filter((i) => i.title && /^https?:/.test(i.url))
        .slice(0, 10)
        .map((i) => ({ ...i, snippet: i.snippet.slice(0, 300) }));
    });
    if (!results.length) {
      // Usually a bot check or an unexpected layout — say so rather than returning nothing.
      const glimpse = await p.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 160)).catch(() => "");
      throw new ToolError(
        "no_results",
        `The search page returned no readable results (title: "${await p.title()}"; page says: "${glimpse}"). Try browser_open on a likely site instead.`,
      );
    }
    return pageSummary(p, { query, results });
  },

  async download({ ref, url, dir, filename }) {
    if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new ToolError("invalid_arguments", "Invalid download directory.");
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ToolError("not_found", "The download directory doesn't exist.");
    const p = await ensurePage();
    const wait = p.waitForEvent("download", { timeout: NAV_TIMEOUT });
    if (ref) {
      const loc = await locate(p, ref);
      await loc.click();
    } else if (url) {
      const verdict = await policy.check(url);
      if (!verdict.ok) throw new ToolError("blocked_url", verdict.reason);
      // Trigger through the page so the request passes the same network policy.
      await p.evaluate((href) => {
        const a = document.createElement("a");
        a.href = href;
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, url);
    } else {
      throw new ToolError("invalid_arguments", "Provide either `ref` or `url`.");
    }
    let download;
    try {
      download = await wait;
    } catch {
      throw new ToolError("no_download", takeBlocked()?.[0]?.reason || "No download started.");
    }
    const failure = await download.failure();
    if (failure) throw new ToolError("download_failed", failure);
    const tmp = await download.path();
    const size = fs.statSync(tmp).size;
    if (size > MAX_DOWNLOAD_BYTES) {
      await download.delete();
      throw new ToolError("too_large", `The file is ${Math.round(size / 1e6)} MB; the limit is 50 MB.`);
    }
    const name = safeFileName(filename || download.suggestedFilename());
    const target = uniquePath(dir, name);
    await download.saveAs(target);
    return { path: target, filename: path.basename(target), bytes: size, sourceUrl: download.url() };
  },

  async close() {
    await shutdown();
    return { closed: true };
  },
};

function safeFileName(raw) {
  let name = path.basename(String(raw || "download")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  name = name.replace(/\.{2,}/g, ".").replace(/^[._\s]+/, "").slice(0, 150);
  if (!name || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = `download_${name || "file"}`;
  return name;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

async function shutdown() {
  const b = browser;
  browser = context = page = null;
  if (b) await b.close().catch(() => {});
}

// ---------------------------------------------------------------------------
// Line protocol
// ---------------------------------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let queue = Promise.resolve(); // one browser action at a time, in order

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, ok: false, error: { code: "bad_request", message: "Invalid JSON." } });
  }
  queue = queue.then(async () => {
    const fn = methods[msg.method];
    if (!fn) return send({ id: msg.id, ok: false, error: { code: "unknown_method", message: `Unknown method ${msg.method}` } });
    try {
      const result = await fn(msg.params || {});
      send({ id: msg.id, ok: true, result });
    } catch (e) {
      const code = e instanceof ToolError ? e.code : "browser_error";
      send({ id: msg.id, ok: false, error: { code, message: String(e.message || e).split("\n")[0].slice(0, 500) } });
    }
  });
});
rl.on("close", async () => {
  await queue.catch(() => {});
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
send({ id: 0, ok: true, result: { ready: true } });
log("ready");
