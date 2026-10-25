// Network destination policy for the managed browser. Every request the
// browser makes (navigations, redirects, subresources, websockets) is checked
// here. Mirrors src-tauri/src/browser/url_policy.rs.

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
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    if (lower === "::" || lower === "::1") return false;
    const first = parseInt(lower.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (lower.startsWith("64:ff9b:")) return false; // NAT64 can reach v4 private space
    if (lower.startsWith("2001:db8:")) return false; // documentation
    return true;
  }
  return false;
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

  return { check };
}
