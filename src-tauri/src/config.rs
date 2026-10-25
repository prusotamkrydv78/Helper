//! API key configuration.
//!
//! Resolution order:
//! 1. `OPENAI_API_KEY` environment variable (in debug builds, `.env` files are loaded first)
//! 2. The OS credential store (Windows Credential Manager / macOS Keychain), written from Settings
//!
//! The key is only ever read here and passed to the HTTP client. It is never
//! returned to the frontend, logged, or written to disk by this app.

use std::fmt;

use serde::Serialize;

use crate::error::{AppError, ErrorKind};

const ENV_VAR: &str = "OPENAI_API_KEY";
const KEYRING_SERVICE: &str = "com.helper.app";
const KEYRING_ACCOUNT: &str = "openai-api-key";

/// Wrapper that keeps the key out of `Debug` output and logs.
#[derive(Clone)]
pub struct ApiKey(String);

impl ApiKey {
    pub fn expose(&self) -> &str {
        &self.0
    }

    fn hint(&self) -> String {
        let tail: String = self.0.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
        format!("…{tail}")
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiKey(<redacted>)")
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KeySource {
    Environment,
    Keychain,
}

/// What the frontend is allowed to know about the configuration.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub provider: &'static str,
    pub configured: bool,
    pub source: Option<KeySource>,
    /// Last four characters only, e.g. "…a1B2".
    pub key_hint: Option<String>,
}

/// Loads `.env` files in development builds only. Existing env vars win.
pub fn load_dotenv() {
    #[cfg(debug_assertions)]
    {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        for path in [manifest.join(".env"), manifest.join("../.env")] {
            if dotenvy::from_path(&path).is_ok() {
                log::info!("loaded environment from {}", path.display());
            }
        }
    }
}

fn entry() -> Result<keyring::Entry, AppError> {
    Ok(keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)?)
}

/// Finds the API key, or `None` if nothing is configured.
pub fn resolve() -> Result<Option<(ApiKey, KeySource)>, AppError> {
    if let Ok(v) = std::env::var(ENV_VAR) {
        let v = v.trim();
        if !v.is_empty() {
            return Ok(Some((ApiKey(v.to_owned()), KeySource::Environment)));
        }
    }
    match entry()?.get_password() {
        Ok(v) if !v.trim().is_empty() => Ok(Some((ApiKey(v), KeySource::Keychain))),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn status() -> Result<AiStatus, AppError> {
    let resolved = resolve()?;
    Ok(AiStatus {
        provider: "openai",
        configured: resolved.is_some(),
        source: resolved.as_ref().map(|(_, s)| *s),
        key_hint: resolved.as_ref().map(|(k, _)| k.hint()),
    })
}

/// Validates and stores a key in the OS credential store.
pub fn store(raw: &str) -> Result<(), AppError> {
    let key = raw.trim();
    if key.is_empty() {
        return Err(AppError::invalid("The API key is empty."));
    }
    if !key.starts_with("sk-") || key.len() < 20 || key.chars().any(char::is_whitespace) {
        return Err(AppError::invalid(
            "That doesn't look like an OpenAI API key (they start with \"sk-\").",
        ));
    }
    entry()?.set_password(key)?;
    log::info!("API key saved to the OS credential store");
    Ok(())
}

/// Removes the stored key. Environment variables are not affected.
pub fn clear() -> Result<(), AppError> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            log::info!("API key removed from the OS credential store");
            Ok(())
        }
        Err(e) => Err(AppError::new(ErrorKind::Storage, format!("Couldn't remove the key: {e}"))),
    }
}
