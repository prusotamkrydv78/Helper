//! Persistent workflows and schedules: storage (app config dir, `workflows.json`
//! and `schedules.json`) and step planning. Execution happens in the frontend, one chat turn per step, so every
//! step goes through the normal agent loop, permissions and approvals.

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::config;
use crate::error::{AppError, ErrorKind};
use crate::state::AppState;

const WORKFLOWS_FILE: &str = "workflows.json";
const SCHEDULES_FILE: &str = "schedules.json";
const RULES_FILE: &str = "organize_rules.json";
const TRIGGERS_FILE: &str = "triggers.json";
const LAYOUTS_FILE: &str = "layouts.json";
const MAX_BYTES: usize = 5 * 1024 * 1024;
const MAX_STEPS: usize = 20;
const MAX_STEP_CHARS: usize = 500;

/// Serializes writes so concurrent saves can't interleave.
static WRITE: Mutex<()> = Mutex::new(());

fn storage(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::Storage, e.to_string())
}

fn path(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, AppError> {
    Ok(app.path().app_config_dir().map_err(storage)?.join(name))
}

#[tauri::command]
pub fn workflows_load(app: AppHandle) -> Result<Value, AppError> {
    load_list(&app, WORKFLOWS_FILE)
}

#[tauri::command]
pub fn workflows_save(app: AppHandle, workflows: Value) -> Result<(), AppError> {
    save_list(&app, WORKFLOWS_FILE, workflows)
}

#[tauri::command]
pub fn schedules_load(app: AppHandle) -> Result<Value, AppError> {
    load_list(&app, SCHEDULES_FILE)
}

#[tauri::command]
pub fn schedules_save(app: AppHandle, schedules: Value) -> Result<(), AppError> {
    save_list(&app, SCHEDULES_FILE, schedules)
}

#[tauri::command]
pub fn triggers_load(app: AppHandle) -> Result<Value, AppError> {
    load_list(&app, TRIGGERS_FILE)
}

#[tauri::command]
pub fn triggers_save(app: AppHandle, triggers: Value) -> Result<(), AppError> {
    save_list(&app, TRIGGERS_FILE, triggers)
}

#[tauri::command]
pub fn layouts_load(app: AppHandle) -> Result<Value, AppError> {
    load_list(&app, LAYOUTS_FILE)
}

#[tauri::command]
pub fn layouts_save(app: AppHandle, layouts: Value) -> Result<(), AppError> {
    save_list(&app, LAYOUTS_FILE, layouts)
}

fn desktop_err(e: crate::tools::ToolError) -> AppError {
    AppError::invalid(e.message)
}

/// Current open windows as a layout (to save under a name).
#[tauri::command]
pub async fn layout_capture() -> Result<Vec<crate::desktop::LayoutWindow>, AppError> {
    crate::desktop::run_isolated(crate::desktop::capture_layout).await.map_err(desktop_err)
}

#[tauri::command]
pub async fn layout_preview(windows: Vec<crate::desktop::LayoutWindow>) -> Result<Vec<Value>, AppError> {
    crate::desktop::run_isolated(move || crate::desktop::preview_layout(&windows)).await.map_err(desktop_err)
}

/// Applies a layout after the user confirmed the preview. Missing apps are launched only from the allow-list.
#[tauri::command]
pub async fn layout_apply(
    state: State<'_, AppState>,
    windows: Vec<crate::desktop::LayoutWindow>,
    launch_missing: bool,
    allowed_apps: Vec<String>,
) -> Result<Value, AppError> {
    let started = std::time::Instant::now();
    let n = windows.len();
    let v = crate::desktop::run_isolated(move || crate::desktop::restore_layout(&windows, launch_missing, &allowed_apps)).await.map_err(desktop_err)?;
    state.audit.record("settings", "workspace_layouts", &json!({ "windows": n, "launch_missing": launch_missing }), "completed", Some(&format!("arranged {}", v["arranged"])), started.elapsed().as_millis());
    Ok(v)
}

/// Local document search for the UI ("Ask your documents"); nothing is sent anywhere.
#[tauri::command]
pub async fn documents_search(state: State<'_, AppState>, path: String, query: String) -> Result<Value, AppError> {
    let g = guard_of(&state);
    tauri::async_runtime::spawn_blocking(move || {
        crate::tools::fs_ops::document_search(&g, crate::tools::fs_ops::DocSearchArgs { path, query, top: Some(8) }).map(|o| o.content).map_err(tool_err)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
pub fn rules_load(app: AppHandle) -> Result<Value, AppError> {
    load_list(&app, RULES_FILE)
}

#[tauri::command]
pub fn rules_save(app: AppHandle, rules: Value) -> Result<(), AppError> {
    save_list(&app, RULES_FILE, rules)
}

fn guard_of(state: &AppState) -> crate::tools::paths::PathGuard {
    crate::tools::paths::PathGuard::new(&state.allowed_dirs.snapshot())
}

fn tool_err(e: crate::tools::ToolError) -> AppError {
    AppError::invalid(e.message)
}

/// Preview of a file-organizing rule (nothing changes).
#[tauri::command]
pub async fn organize_rule_preview(state: State<'_, AppState>, rule: Value) -> Result<String, AppError> {
    let g = guard_of(&state);
    tauri::async_runtime::spawn_blocking(move || crate::tools::fs_ops::preview(&g, "organize_files", &rule).map_err(tool_err))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

/// Applies a rule after the user confirmed its preview in the UI. Recorded in the activity log and undo history.
#[tauri::command]
pub async fn organize_rule_apply(state: State<'_, AppState>, rule: Value) -> Result<Value, AppError> {
    let g = guard_of(&state);
    let args = rule.clone();
    let started = std::time::Instant::now();
    let out = tauri::async_runtime::spawn_blocking(move || {
        crate::tools::parse::<crate::tools::fs_ops::OrganizeArgs>(&args).and_then(|a| crate::tools::fs_ops::organize_files(&g, a)).map_err(tool_err)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))??;
    state.audit.record("settings", "organize_files", &rule, "completed", Some(&out.summary), started.elapsed().as_millis());
    Ok(out.content)
}

#[tauri::command]
pub fn file_undo_list() -> Vec<crate::tools::fs_ops::JournalEntry> {
    crate::tools::fs_ops::journal_list()
}

#[tauri::command]
pub async fn file_undo_preview(state: State<'_, AppState>, id: u64) -> Result<String, AppError> {
    let g = guard_of(&state);
    tauri::async_runtime::spawn_blocking(move || crate::tools::fs_ops::undo_preview(&g, id).map_err(tool_err))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
pub async fn file_undo_apply(state: State<'_, AppState>, id: u64) -> Result<Value, AppError> {
    let g = guard_of(&state);
    let started = std::time::Instant::now();
    let out = tauri::async_runtime::spawn_blocking(move || crate::tools::fs_ops::undo(&g, id).map_err(tool_err))
        .await
        .map_err(|e| AppError::internal(e.to_string()))??;
    state.audit.record("settings", "undo_file_changes", &json!({ "id": id }), "completed", Some(&out.summary), started.elapsed().as_millis());
    Ok(out.content)
}

fn load_list(app: &AppHandle, name: &str) -> Result<Value, AppError> {
    let file = path(app, name)?;
    match std::fs::read_to_string(&file) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(v) if v.is_array() => Ok(v),
            _ => {
                // Keep the unreadable file for inspection instead of overwriting it.
                let _ = std::fs::rename(&file, file.with_extension("json.corrupt"));
                log::warn!("{name} was unreadable; moved aside");
                Ok(json!([]))
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!([])),
        Err(e) => Err(storage(e)),
    }
}

/// Replaces the stored workflows. Written to a temp file and renamed, so a crash
/// mid-write leaves the previous version intact.
fn save_list(app: &AppHandle, name: &str, list: Value) -> Result<(), AppError> {
    if !list.is_array() {
        return Err(AppError::invalid("Expected a list."));
    }
    let text = serde_json::to_string(&list).map_err(storage)?;
    if text.len() > MAX_BYTES {
        return Err(AppError::invalid("Too much workflow data to save; delete old workflows."));
    }
    let file = path(app, name)?;
    let _guard = WRITE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(storage)?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(storage)?;
    std::fs::rename(&tmp, &file).map_err(storage)
}

/// Asks the model (without tools) to break a goal into ordered steps.
#[tauri::command]
pub async fn workflow_plan(state: State<'_, AppState>, goal: String, model: Option<String>) -> Result<Vec<String>, AppError> {
    let goal = goal.trim();
    if goal.is_empty() {
        return Err(AppError::invalid("Describe the goal first."));
    }
    let (key, _) = tauri::async_runtime::spawn_blocking(config::resolve)
        .await
        .map_err(|e| AppError::internal(format!("background task failed: {e}")))??
        .ok_or_else(AppError::missing_api_key)?;
    let model = state.ai.resolve_model(model.as_deref());
    let mut tools = vec!["files", "web browser", "desktop apps", "system status"];
    if state.graph.connected() {
        tools.push("Outlook mail and calendar");
    }
    if state.google.connected() {
        tools.push("Gmail and Google Calendar");
    }
    let memory = state.memory.prompt_section().unwrap_or_default();
    let messages = vec![
        json!({ "role": "system", "content": format!(
            "You plan desktop automation workflows. Split the user's goal into 1-{MAX_STEPS} ordered, concrete steps. \
             Each step is one instruction an assistant with these tools can carry out on its own: {}. \
             Steps may use results of earlier steps. Don't add steps the goal doesn't need. Put sending, \
             deleting or inviting into their own step so the user approves them separately. \
             Reply with JSON only: {{\"steps\": [\"...\", \"...\"]}}{memory}",
            tools.join(", ")
        ) }),
        json!({ "role": "user", "content": goal }),
    ];
    let request_id = format!("plan-{}", std::process::id() as u128 ^ std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let cancel = CancellationToken::new();
    let round = state.ai.stream_round(&key, &model, &messages, None, &request_id, &cancel, &mut |_| {}).await?;
    parse_steps(&round.text)
}

fn parse_steps(text: &str) -> Result<Vec<String>, AppError> {
    let bad = || AppError::new(ErrorKind::Internal, "The model didn't return a usable step list. Try again or enter steps yourself.");
    let start = text.find('{').ok_or_else(bad)?;
    let end = text.rfind('}').ok_or_else(bad)?;
    let v: Value = serde_json::from_str(text.get(start..=end).ok_or_else(bad)?).map_err(|_| bad())?;
    let steps: Vec<String> = v
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(bad)?
        .iter()
        .filter_map(Value::as_str)
        .map(|s| s.trim().chars().take(MAX_STEP_CHARS).collect::<String>())
        .filter(|s| !s.is_empty())
        .take(MAX_STEPS)
        .collect();
    if steps.is_empty() {
        return Err(bad());
    }
    Ok(steps)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fenced_json_and_limits_steps() {
        let s = parse_steps("```json\n{\"steps\": [\" a \", \"\", \"b\"]}\n```").unwrap();
        assert_eq!(s, vec!["a", "b"]);
        assert!(parse_steps("no json").is_err());
        assert!(parse_steps("{\"steps\": []}").is_err());
        let many = format!("{{\"steps\": [{}]}}", vec!["\"x\""; 30].join(","));
        assert_eq!(parse_steps(&many).unwrap().len(), MAX_STEPS);
    }
}
