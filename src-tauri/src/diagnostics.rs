//! Diagnostics and the daily briefing's calendar data.
//!
//! `diagnostics` only *reads* configuration and state (files, settings, whether
//! things are installed or connected); it never starts the browser, the
//! microphone or a network call. Checks that need to actually run something are
//! separate commands the user triggers explicitly (`diagnose_browser`), and their
//! results are reported as "tested now".

use std::path::Path;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::error::AppError;
use crate::state::AppState;

fn check(id: &str, label: &str, ok: Option<bool>, detail: impl Into<String>) -> Value {
    // ok: Some(true) ready, Some(false) problem, None informational / not determinable without running it.
    json!({ "id": id, "label": label, "status": match ok { Some(true) => "ok", Some(false) => "problem", None => "info" }, "detail": detail.into() })
}

fn size_of(p: &Path) -> Option<u64> {
    std::fs::metadata(p).ok().map(|m| m.len())
}

#[tauri::command]
pub async fn diagnostics(app: AppHandle, state: State<'_, AppState>) -> Result<Value, AppError> {
    let mut checks = Vec::new();
    let config_dir = app.path().app_config_dir().map_err(|e| AppError::internal(e.to_string()))?;

    checks.push(check("platform", "Operating system", Some(cfg!(windows)), if cfg!(windows) { "Windows: desktop, system, clipboard and voice features are available." } else { "Not Windows: Windows-only features are disabled." }));

    let ai = tauri::async_runtime::spawn_blocking(crate::config::status).await.map_err(|e| AppError::internal(e.to_string()))?;
    match ai {
        Ok(s) => checks.push(check("ai_key", "AI model API key", Some(s.configured), if s.configured { "Configured (not tested: sending a request costs tokens)." } else { "Not set: chat uses the demo mode. Add a key in Settings → AI model." })),
        Err(e) => checks.push(check("ai_key", "AI model API key", Some(false), format!("Credential store error: {}", e.message))),
    }

    let b = state.browser.diagnostics();
    checks.push(check("browser_worker", "Browser worker script", Some(b["script"].is_string()), b["script"].as_str().map(|s| format!("Found: {s}")).unwrap_or_else(|| "Not found: browser tools are disabled (run npm install / reinstall).".into())));
    checks.push(check("node", "Node.js runtime for the browser", Some(b["nodeFound"] == true), format!("{} ({})", b["node"].as_str().unwrap_or("node"), if b["nodeFound"] == true { "found" } else { "looked up on PATH at start; not verified" })));
    let edge = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].iter().any(|p| Path::new(p).exists());
    checks.push(check("edge", "Microsoft Edge", Some(edge), if edge { "Installed (not launched)." } else { "Not found in the usual folders; set AA_BROWSER_CHANNEL=chrome if you use Chrome." }));
    checks.push(check("browser_profile", "Browser logins kept", None, if b["profile"].is_string() { "Persistent profile in use." } else { "Off: each session starts clean." }));

    let dirs = state.allowed_dirs.list();
    let missing: Vec<&String> = dirs.iter().filter(|d| !Path::new(d).is_dir()).collect();
    checks.push(check(
        "folders",
        "Allowed folders",
        Some(!dirs.is_empty() && missing.is_empty()),
        if dirs.is_empty() { "None: file tools are off.".to_owned() } else if missing.is_empty() { format!("{} folder(s), all present.", dirs.len()) } else { format!("Missing: {}", missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")) },
    ));

    let g = state.graph.status();
    checks.push(check("microsoft", "Microsoft 365", g.configured.then_some(g.connected), if g.connected { format!("Connected as {} (token refresh not tested).", g.account_email.unwrap_or_default()) } else if g.configured { "Configured, not connected.".into() } else { "Not configured (optional).".into() }));
    let go = state.google.status();
    checks.push(check("google", "Google Workspace", go.configured.then_some(go.connected), if go.connected { format!("Connected as {} (token refresh not tested).", go.account_email.unwrap_or_default()) } else if go.configured { "Configured, not connected.".into() } else { "Not configured (optional).".into() }));

    checks.push(check("speech_in", "Speech recognition", None, "Can only be checked by listening: use “Test voice input” (needs a microphone and Windows online speech recognition)."));
    checks.push(check("clipboard", "Clipboard history", None, if state.clipboard.enabled() { "On (memory only)." } else { "Off." }));
    let shortcuts = crate::background::registered_shortcuts();
    checks.push(check("shortcuts", "Global shortcuts", None, if shortcuts == 0 { "None registered.".to_owned() } else { format!("{shortcuts} registered.") }));
    checks.push(check("library", "Knowledge library", None, {
        let s = state.library.status();
        format!("{} files, {} passages indexed{}", s["files"], s["passages"], if s["errors"].as_array().is_some_and(|e| !e.is_empty()) { " (with warnings)" } else { "" })
    }));

    let storage_ok = config_dir.is_dir();
    let files: Vec<String> = ["workflows.json", "schedules.json", "triggers.json", "skills.json", "memory.json", "audit.log", "file_undo.json", "layouts.json"]
        .iter()
        .filter_map(|f| size_of(&config_dir.join(f)).map(|n| format!("{f} ({} KB)", n / 1024)))
        .collect();
    checks.push(check("storage", "App data folder", Some(storage_ok), format!("{} — {}", config_dir.display(), if files.is_empty() { "no data files yet".to_owned() } else { files.join(", ") })));
    let corrupt: Vec<String> = std::fs::read_dir(&config_dir).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".corrupt")).collect();
    if !corrupt.is_empty() {
        checks.push(check("corrupt", "Unreadable data files", Some(false), format!("Set aside: {} (data in them wasn't loaded).", corrupt.join(", "))));
    }
    checks.push(check("stuck", "Desktop actions waiting on apps", Some(crate::desktop::stuck_calls() == 0), format!("{} in progress.", crate::desktop::stuck_calls())));

    Ok(json!({ "checks": checks, "note": "Configuration checks only: nothing was started, launched or sent." }))
}

/// Explicit, user-requested test: starts the browser session and lists its tabs.
#[tauri::command]
pub async fn diagnose_browser(state: State<'_, AppState>) -> Result<Value, AppError> {
    if !state.browser.available() {
        return Err(AppError::invalid("The browser worker isn't installed."));
    }
    let cancel = tokio_util::sync::CancellationToken::new();
    let started = std::time::Instant::now();
    state
        .browser
        .call("tabs", json!({}), std::time::Duration::from_secs(60), &cancel)
        .await
        .map(|r| json!({ "ok": true, "tabs": r["tabs"].as_array().map_or(0, Vec::len), "ms": started.elapsed().as_millis() as u64 }))
        .map_err(|e| AppError::invalid(e.message))
}

/// "YYYY-MM-DDTHH:MM:SS" in UTC for Unix seconds.
fn utc(secs: i64) -> String {
    let (y, m, d) = crate::tools::fs_ops::civil_from_days(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}", t / 3600, (t / 60) % 60, t % 60)
}

/// Calendar events for the next `hours` from each connected account, read directly (no AI involved).
/// Each account reports ok, not_connected or error, so the briefing never invents or hides gaps.
#[tauri::command]
pub async fn briefing_calendar(state: State<'_, AppState>, hours: Option<i64>) -> Result<Value, AppError> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let args = json!({ "start": utc(now), "end": utc(now + hours.unwrap_or(24).clamp(1, 168) * 3600) });
    let mut accounts = Vec::new();
    let ms = state.graph.status();
    accounts.push(if !ms.connected {
        json!({ "service": "Microsoft 365", "status": if ms.configured { "not_connected" } else { "not_configured" } })
    } else {
        let spec = crate::tools::find("calendar_list").ok_or_else(|| AppError::internal("calendar tool missing"))?;
        match crate::graph::execute(&state.graph, spec, &args).await {
            Ok(o) => json!({ "service": "Microsoft 365", "status": "ok", "events": o.content["events"], "times": "UTC" }),
            Err(e) => json!({ "service": "Microsoft 365", "status": "error", "error": e.message }),
        }
    });
    let gs = state.google.status();
    accounts.push(if !gs.connected {
        json!({ "service": "Google Calendar", "status": if gs.configured { "not_connected" } else { "not_configured" } })
    } else {
        let spec = crate::tools::find("gcal_list").ok_or_else(|| AppError::internal("calendar tool missing"))?;
        match crate::google::execute(&state.google, spec, &args).await {
            Ok(o) => json!({ "service": "Google Calendar", "status": "ok", "events": o.content["events"] }),
            Err(e) => json!({ "service": "Google Calendar", "status": "error", "error": e.message }),
        }
    });
    state.audit.record("briefing", "briefing_calendar", &args, "completed", None, 0);
    Ok(json!({ "accounts": accounts, "from": args["start"], "to": args["end"] }))
}
