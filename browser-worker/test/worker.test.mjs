// End-to-end tests for the browser worker against controlled local pages.
// Uses the real worker process and the real browser (Microsoft Edge by default).
// Run with: npm run test:browser

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, sitePages, startWorker, attachEchoWebSocket } from "./fixtures.mjs";
import { createPolicy, isPublicIp } from "../policy.mjs";

let site, other, worker, base, downloadDir;
const wsReceived = [];

before(async () => {
  other = await startServer({ "/img-hit": hit, "/fetch-hit": hit, "/redirect-hit": hit, "/ws": hit });
  site = await startServer(sitePages(other.port));
  attachEchoWebSocket(site.server, wsReceived);
  base = `http://127.0.0.1:${site.port}`;
  downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-dl-"));
  worker = await startWorker({
    // Only the test site is exempt from the private-address policy — not `other`.
    AA_BROWSER_TEST_ALLOW_HOSTS: `127.0.0.1:${site.port}`,
    AA_SEARCH_URL: `${base}/search?q=`,
    AA_BROWSER_HEADLESS: "1",
  });
});

after(async () => {
  await worker?.stop();
  site?.server.close();
  other?.server.close();
  fs.rmSync(downloadDir, { recursive: true, force: true });
});

function hit(req, res) {
  res.writeHead(200);
  res.end("hit");
}

test("policy classifies addresses", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1",
    "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::7f00:1", "::127.0.0.1", "2002:c0a8:101::1", "2001:0:4136:e378::1", "[::ffff:127.0.0.1]"])
    assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.equal(isPublicIp(ip), true, ip);
  const p = createPolicy();
  for (const url of ["http://localhost/", "http://printer.local/", "http://db.internal/", "file:///C:/x", "ftp://example.com/", "http://user:pw@example.com/", "http://intranet/"])
    assert.equal((await p.check(url)).ok, false, url);
});

test("open + content returns real page text, links and element refs", async () => {
  const open = await worker.call("open", { url: `${base}/index.html` });
  assert.ok(open.ok, JSON.stringify(open));
  assert.equal(open.result.title, "Test Shop");
  assert.equal(open.result.status, 200);

  const c = await worker.call("content", {});
  assert.ok(c.ok);
  assert.match(c.result.text, /Welcome to the controlled test page/);
  assert.ok(c.result.links.some((l) => l.url.endsWith("/page2.html")));
  const names = c.result.elements.map((e) => e.label || e.text);
  assert.ok(names.includes("Name") && names.includes("Send form") && names.includes("Plain button"), names.join(","));
});

test("describe flags form submits and password fields", async () => {
  const c = await worker.call("content", {});
  const byName = (n) => c.result.elements.find((e) => (e.label || e.text) === n).ref;
  const submit = await worker.call("describe", { ref: byName("Send form") });
  assert.equal(submit.result.submitsForm, true);
  const pw = await worker.call("describe", { ref: byName("Password") });
  assert.equal(pw.result.isSensitiveInput, true);
  const plain = await worker.call("describe", { ref: byName("Plain button") });
  assert.equal(plain.result.submitsForm, false);
});

test("click, type and submit act on the real page", async () => {
  let c = await worker.call("content", {});
  const ref = (n) => c.result.elements.find((e) => (e.label || e.text) === n).ref;

  const click = await worker.call("click", { ref: ref("Plain button") });
  assert.ok(click.ok);
  assert.equal(click.result.navigated, false);

  const typed = await worker.call("type", { ref: ref("Name"), text: "Ada", submit: true });
  assert.ok(typed.ok, JSON.stringify(typed));
  assert.equal(typed.result.navigated, true);
  assert.match(typed.result.url, /\/submit\?q=Ada/);

  c = await worker.call("content", {});
  assert.match(c.result.text, /Got name=Ada/);
});

test("stale refs are rejected after navigation", async () => {
  await worker.call("open", { url: `${base}/index.html` });
  const c = await worker.call("content", {});
  const link = c.result.elements.find((e) => e.text === "Second page").ref;
  const click = await worker.call("click", { ref: link });
  assert.equal(click.result.title, "Second page");
  const again = await worker.call("click", { ref: c.result.elements.at(-1).ref });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, "stale_ref");
});

test("search returns parsed results with unwrapped URLs", async () => {
  const s = await worker.call("search", { query: "tauri" });
  assert.ok(s.ok, JSON.stringify(s));
  assert.equal(s.result.results.length, 2);
  assert.equal(s.result.results[0].url, "https://example.com/a");
  assert.match(s.result.results[0].title, /Result A for tauri/);
});

test("download saves inside the given folder with a sanitized name", async () => {
  await worker.call("open", { url: `${base}/index.html` });
  const d = await worker.call("download", { url: `${base}/file.txt`, dir: downloadDir });
  assert.ok(d.ok, JSON.stringify(d));
  assert.equal(path.dirname(d.result.path), downloadDir);
  assert.ok(!d.result.filename.includes("..") && !d.result.filename.includes("/"), d.result.filename);
  assert.equal(fs.readFileSync(d.result.path, "utf8"), "downloaded contents");

  const second = await worker.call("download", { url: `${base}/file.txt`, dir: downloadDir });
  assert.notEqual(second.result.path, d.result.path, "existing files are never overwritten");
});

test("pages can't reach local/private addresses (subresources, fetch, websocket, navigation, redirects)", async () => {
  const before = other.hits.length;
  await worker.call("open", { url: `${base}/leak.html` });
  await new Promise((r) => setTimeout(r, 1500));
  const redirect = await worker.call("open", { url: `${base}/redirect` });
  assert.equal(redirect.ok, false, "redirect to a private address must fail");
  assert.equal(other.hits.length, before, `blocked server was reached: ${other.hits.slice(before).join(", ")}`);

  const direct = await worker.call("open", { url: `http://127.0.0.1:${other.port}/img-hit` });
  assert.equal(direct.ok, false);
  assert.equal(direct.error.code, "blocked_url");
  const meta = await worker.call("open", { url: "http://169.254.169.254/latest/meta-data/" });
  assert.equal(meta.ok, false);
});

test("file inputs and bad refs are refused", async () => {
  const bad = await worker.call("click", { ref: "div.foo" });
  assert.equal(bad.error.code, "invalid_arguments");
});

test("redirects to allowed pages still work", async () => {
  const r = await worker.call("open", { url: `${base}/hop` });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.result.title, "Second page");
});

test("search parses Bing markup and reports blocked/empty result pages", async () => {
  const bing = await startWorker({ AA_BROWSER_TEST_ALLOW_HOSTS: `127.0.0.1:${site.port}`, AA_SEARCH_URL: `${base}/bing?q=`, AA_BROWSER_HEADLESS: "1" });
  const b = await bing.call("search", { query: "x" });
  assert.ok(b.ok, JSON.stringify(b));
  assert.equal(b.result.results[0].url, "https://example.net/bing-result");
  await bing.stop();

  const cap = await startWorker({ AA_BROWSER_TEST_ALLOW_HOSTS: `127.0.0.1:${site.port}`, AA_SEARCH_URL: `${base}/captcha?q=`, AA_BROWSER_HEADLESS: "1" });
  const c = await cap.call("search", { query: "x" });
  assert.equal(c.ok, false);
  assert.equal(c.error.code, "no_results");
  assert.match(c.error.message, /confirm you are human/);
  await cap.stop();
});

test("connect-time DNS guard rejects private answers (DNS rebinding)", async () => {
  const dnsMod = (await import("node:dns")).default;
  const saved = { p: dnsMod.promises.lookup, c: dnsMod.lookup };
  let calls = 0;
  // First answer public (passes validation), later answers private (rebinding).
  dnsMod.promises.lookup = async () => (calls++ === 0 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
  dnsMod.lookup = (_h, _o, cb) => cb(null, [{ address: "10.0.0.5", family: 4 }]);
  try {
    createPolicy({}).guardDnsLookup();
    assert.equal((await dnsMod.promises.lookup("rebind.test", { all: true }))[0].address, "93.184.216.34");
    await assert.rejects(dnsMod.promises.lookup("rebind.test", { all: true }), /private address/);
    await new Promise((resolve) =>
      dnsMod.lookup("rebind.test", {}, (err) => {
        assert.match(String(err?.message), /private address/);
        resolve();
      }),
    );
  } finally {
    dnsMod.promises.lookup = saved.p;
    dnsMod.lookup = saved.c;
  }
});

test("allowed WebSockets work in both directions through the worker", async () => {
  const r = await worker.call("open", { url: `${base}/ws.html` });
  assert.ok(r.ok, JSON.stringify(r));
  let title = "";
  for (let i = 0; i < 30 && !title.startsWith("ws"); i++) {
    await new Promise((res) => setTimeout(res, 100));
    title = (await worker.call("content", { maxChars: 500 })).result?.title ?? "";
  }
  assert.deepEqual(wsReceived, ["ping"], "server got the page's message");
  assert.equal(title, "ws:echo:ping", "page got the server's reply");
});

test("service workers are blocked", async () => {
  const r = await worker.call("open", { url: `${base}/sw.html` });
  assert.ok(r.ok, JSON.stringify(r));
  await new Promise((res) => setTimeout(res, 1500));
  const title = (await worker.call("content", { maxChars: 500 })).result?.title;
  assert.notEqual(title, "sw-registered");
});
