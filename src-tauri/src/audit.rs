//! Audit history: one JSON line per tool call outcome in `audit.log` (app config
//! folder), rotated at 5 MB. Records tool, arguments (long values clipped) and
//! result status — never API keys, message text or file contents.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::State;

use crate::state::AppState;

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const ARG_CHARS: usize = 200;

pub struct AuditLog {
    file: PathBuf,
    lock: Mutex<()>,
}

/// Arguments with long strings clipped and bulky fields (`content`, `text`) summarized.
fn redact(args: &Value) -> Value {
    match args {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| {
                    let v = match (k.as_str(), v) {
                        ("content" | "text" | "body", Value::String(s)) => json!(format!("<{} characters>", s.chars().count())),
                        (_, Value::String(s)) if s.chars().count() > ARG_CHARS => {
                            json!(format!("{}…", s.chars().take(ARG_CHARS).collect::<String>()))
                        }
                        _ => v.clone(),
                    };
                    (k.clone(), v)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

impl AuditLog {
    pub fn new(config_dir: &Path) -> Self {
        Self { file: config_dir.join("audit.log"), lock: Mutex::new(()) }
    }

    /// Best effort: audit failures are logged, never block the tool.
    pub fn record(&self, request_id: &str, tool: &str, args: &Value, status: &str, detail: Option<&str>, duration_ms: u128) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let line = json!({
            "ts": ts as u64,
            "requestId": request_id,
            "tool": tool,
            "args": redact(args),
            "status": status,
            "detail": detail.map(|d| d.chars().take(300).collect::<String>()),
            "durationMs": duration_ms as u64,
        })
        .to_string();
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let result = (|| -> std::io::Result<()> {
            if let Some(dir) = self.file.parent() {
                std::fs::create_dir_all(dir)?;
            }
            if std::fs::metadata(&self.file).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
                std::fs::rename(&self.file, self.file.with_extension("log.1"))?;
            }
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&self.file)?;
            writeln!(f, "{line}")
        })();
        if let Err(e) = result {
            log::warn!("audit log write failed: {e}");
        }
    }

    /// The newest `limit` entries, newest first.
    pub fn recent(&self, limit: usize) -> Vec<Value> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let text = std::fs::read_to_string(&self.file).unwrap_or_default();
        text.lines().rev().take(limit).filter_map(|l| serde_json::from_str(l).ok()).collect()
    }

    pub fn clear(&self) -> std::io::Result<()> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        for f in [self.file.clone(), self.file.with_extension("log.1")] {
            match std::fs::remove_file(&f) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub fn audit_recent(state: State<'_, AppState>, limit: Option<usize>) -> Vec<Value> {
    state.audit.recent(limit.unwrap_or(200).min(1000))
}

#[tauri::command]
pub fn audit_clear(state: State<'_, AppState>) -> Result<(), crate::error::AppError> {
    state.audit.clear().map_err(|e| crate::error::AppError::new(crate::error::ErrorKind::Storage, e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bulky_and_long_values() {
        let v = redact(&json!({ "content": "secret body", "path": "a".repeat(500), "n": 3 }));
        assert_eq!(v["content"], "<11 characters>");
        assert!(v["path"].as_str().unwrap().chars().count() <= ARG_CHARS + 1);
        assert_eq!(v["n"], 3);
    }
}
