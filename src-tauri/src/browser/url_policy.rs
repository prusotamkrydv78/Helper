//! Validates URLs before the browser is asked to load them. The worker applies
//! the same rules to every request the page makes (browser-worker/policy.mjs);
//! this is the first line of defense for URLs chosen by the model.

use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use reqwest::Url;

use crate::tools::ToolError;

const BLOCKED_SUFFIXES: &[&str] = &[".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];
const BLOCKED_HOSTS: &[&str] = &["localhost", "metadata.google.internal", "metadata"];

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            // IPv4-mapped and IPv4-compatible forms (also :: and ::1) follow the v4 rules.
            if let Some(v4) = v6.to_ipv4() {
                return is_public_v4(v4);
            }
            let s = v6.segments();
            if s[0] == 0x2002 {
                // 6to4 embeds a v4 address.
                let [a, b] = s[1].to_be_bytes();
                let [c, d] = s[2].to_be_bytes();
                return is_public_v4(Ipv4Addr::new(a, b, c, d));
            }
            !(v6.is_unspecified()
                || v6.is_loopback()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link local
                || (s[0] & 0xff00) == 0xff00 // multicast
                || (s[0] == 0x64 && s[1] == 0xff9b) // NAT64
                || (s[0] == 0x2001 && s[1] == 0) // Teredo
                || (s[0] == 0x2001 && s[1] == 0x0db8)) // documentation
        }
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..128).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..32).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

/// `host:port` pairs exempt from the private-address rules. Debug builds only,
/// for the automated tests against local pages.
fn test_allowed(host: &str, port: u16) -> bool {
    #[cfg(debug_assertions)]
    {
        if let Ok(list) = std::env::var("AA_BROWSER_TEST_ALLOW_HOSTS") {
            let key = format!("{host}:{port}");
            return list.split(',').any(|h| h.trim().eq_ignore_ascii_case(&key));
        }
    }
    let _ = (host, port);
    false
}

/// Checks scheme, credentials and host shape without network access.
pub fn check_static(raw: &str) -> Result<Url, ToolError> {
    let url = Url::parse(raw.trim()).map_err(|_| ToolError::invalid("That is not a valid URL."))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(ToolError::denied(format!("The {}: scheme is not allowed.", url.scheme())));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ToolError::denied("URLs with embedded credentials are not allowed."));
    }
    let port = url.port_or_known_default().unwrap_or(80);
    match url.host() {
        None => Err(ToolError::invalid("The URL has no host.")),
        Some(url::Host::Ipv4(ip)) => {
            if is_public_ip(IpAddr::V4(ip)) || test_allowed(&ip.to_string(), port) {
                Ok(url)
            } else {
                Err(ToolError::denied(format!("{ip} is a private or reserved address.")))
            }
        }
        Some(url::Host::Ipv6(ip)) => {
            if is_public_ip(IpAddr::V6(ip)) {
                Ok(url)
            } else {
                Err(ToolError::denied(format!("{ip} is a private or reserved address.")))
            }
        }
        Some(url::Host::Domain(d)) => {
            // A trailing dot ("printer.local.") is the same host; normalize before matching.
            let host = d.trim_end_matches('.').to_ascii_lowercase();
            if test_allowed(&host, port) {
                return Ok(url);
            }
            if BLOCKED_HOSTS.contains(&host.as_str())
                || BLOCKED_SUFFIXES.iter().any(|s| host.ends_with(s))
                || !host.contains('.')
            {
                return Err(ToolError::denied(format!("{host} is a local or internal address.")));
            }
            Ok(url)
        }
    }
}

/// Full check: static rules plus DNS — every address the host resolves to must be public.
pub async fn validate(raw: &str) -> Result<Url, ToolError> {
    let url = check_static(raw)?;
    if let Some(url::Host::Domain(d)) = url.host() {
        let port = url.port_or_known_default().unwrap_or(80);
        if test_allowed(&d.to_ascii_lowercase(), port) {
            return Ok(url);
        }
        let lookup = tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((d, port))).await;
        let addrs: Vec<IpAddr> = match lookup {
            Ok(Ok(it)) => it.map(|a| a.ip()).collect(),
            _ => return Err(ToolError::not_found(format!("Couldn't resolve {d}."))),
        };
        if let Some(bad) = addrs.iter().find(|ip| !is_public_ip(**ip)) {
            return Err(ToolError::denied(format!("{d} resolves to a private address ({bad}).")));
        }
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv6Addr;

    #[test]
    fn classifies_ips() {
        for ip in ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.0.1", "169.254.169.254", "100.64.1.1", "0.0.0.0", "224.0.0.1"] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::", "::ffff:7f00:1", "::7f00:1", "2002:c0a8:101::1", "2001:0:4136:e378::1"] {
            assert!(!is_public_ip(ip.parse::<Ipv6Addr>().unwrap().into()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "93.184.216.34"] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn rejects_unsafe_urls() {
        for u in [
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "ftp://example.com/x",
            "http://localhost:8080/",
            "http://127.0.0.1/",
            "http://[::1]/",
            "http://192.168.1.10/admin",
            "http://169.254.169.254/latest/meta-data/",
            "http://printer.local/",
            "http://service.internal/",
            "http://intranet/",
            "http://user:pass@example.com/",
            "not a url",
        ] {
            assert!(check_static(u).is_err(), "{u}");
        }
        assert!(check_static("https://example.com/path?q=1").is_ok());
    }

    #[tokio::test]
    async fn dns_resolution_to_private_is_blocked() {
        // localhost-style names resolve to loopback; must be rejected even if they had dots.
        assert!(validate("http://localhost.").await.is_err());
    }
}
