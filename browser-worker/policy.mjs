// Network destination policy for the managed browser. Every request the
// browser makes (navigations, redirects, subresources, websockets) is checked
// here. Mirrors src-tauri/src/browser/url_policy.rs.

import dnsCallback from "node:dns";
import dns from "node:dns/promises";
import net from "node:net";

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata"]);

function v4ToInt(ip) {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([base, bits]) => [v4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

export function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return !V4_BLOCKED.some(([base, mask]) => ((n & mask) >>> 0) === base);
  }
  if (net.isIPv6(ip)) {
    const s = v6Segments(ip);
    if (!s) return false;
    const v4 = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    const zero5 = s.slice(0, 5).every((x) => x === 0);
    // IPv4-mapped (::ffff:a.b.c.d, which URL parsing rewrites to ::ffff:7f00:1) and
    // IPv4-compatible (::a.b.c.d) addresses carry the v4 rules; this also covers :: and ::1.
    if (zero5 && (s[5] === 0xffff || s[5] === 0)) return isPublicIp(v4(s[6], s[7]));
    if (s[0] === 0x2002) return isPublicIp(v4(s[1], s[2])); // 6to4 embeds a v4 address
    if (s[0] === 0x2001 && s[1] === 0) return false; // Teredo
    if ((s[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((s[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
    if ((s[0] & 0xff00) === 0xff00) return false; // multicast
    if (s[0] === 0x64 && s[1] === 0xff9b) return false; // NAT64 can reach v4 private space
    if (s[0] === 0x2001 && s[1] === 0x0db8) return false; // documentation
    return true;
  }
  return false;
}

/** The eight 16-bit groups of an IPv6 address (zone id and embedded dotted v4 handled). */
function v6Segments(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = v4ToInt(dotted[1]);
    s = s.slice(0, -dotted[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = s.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8) return null;
  const out = groups.map((g) => parseInt(g, 16));
  return out.some((g) => !(g >= 0 && g <= 0xffff)) ? null : out;
}

/**
 * @param {{ allowHosts?: string[] }} opts  allowHosts: "host:port" entries that bypass
 *   the private-address rules. Only set by the automated tests.
 */
export function createPolicy({ allowHosts = [] } = {}) {
  const allow = new Set(allowHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
  const cache = new Map(); // hostname -> { ok, reason, at }

  async function check(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return { ok: false, reason: "Invalid URL." };
    }
    if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return { ok: true };
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ws:" && u.protocol !== "wss:") {
      return { ok: false, reason: `The ${u.protocol} scheme is not allowed.` };
    }
    if (u.username || u.password) return { ok: false, reason: "URLs with embedded credentials are not allowed." };
    // A trailing dot ("printer.local.") is the same host; normalize before matching.
    const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    const port = u.port || (u.protocol === "https:" || u.protocol === "wss:" ? "443" : "80");
    if (allow.has(`${host}:${port}`)) return { ok: true };

    if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes(".") && !net.isIP(host)) {
      return { ok: false, reason: `${host} is a local or internal address.` };
    }
    if (net.isIP(host)) {
      return isPublicIp(host) ? { ok: true } : { ok: false, reason: `${host} is a private or reserved address.` };
    }
    const hit = cache.get(host);
    if (hit && Date.now() - hit.at < 60_000) return hit;
    let result;
    try {
      const addrs = await dns.lookup(host, { all: true });
      const bad = addrs.find((a) => !isPublicIp(a.address));
      result = bad
        ? { ok: false, reason: `${host} resolves to a private address (${bad.address}).` }
        : { ok: true };
    } catch {
      result = { ok: false, reason: `Couldn't resolve ${host}.` };
    }
    cache.set(host, { ...result, at: Date.now() });
    return result;
  }

  /** True when `host` (any port) is on the test allow-list. */
  function hostAllowed(host) {
    const h = String(host).replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    return [...allow].some((a) => a.slice(0, a.lastIndexOf(":")) === h);
  }

  /**
   * Enforces the address rules at connect time: replaces dns.lookup for this
   * process so a host can't pass the check with a public address and then
   * resolve to a private one when Playwright fetches it (DNS rebinding).
   */
  function guardDnsLookup() {
    const original = dnsCallback.lookup;
    const guarded = function (hostname, options, callback) {
      if (typeof options === "function") [callback, options] = [options, {}];
      const opts = typeof options === "number" ? { family: options } : { ...(options || {}) };
      original.call(dnsCallback, hostname, { ...opts, all: true }, (err, addrs) => {
        if (err) return callback(err);
        const ok = hostAllowed(hostname) ? addrs : addrs.filter((a) => isPublicIp(a.address));
        if (!ok.length) {
          const e = new Error(`${hostname} resolves to a private address.`);
          e.code = "EAI_FAIL";
          return callback(e);
        }
        if (opts.all) return callback(null, ok);
        callback(null, ok[0].address, ok[0].family);
      });
    };
    dnsCallback.lookup = guarded;
  }

  return { check, guardDnsLookup };
}
