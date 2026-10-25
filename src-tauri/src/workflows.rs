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
    let messages = vec![
        json!({ "role": "system", "content": format!(
            "You plan desktop automation workflows. Split the user's goal into 1-{MAX_STEPS} ordered, concrete steps. \
             Each step is one instruction an assistant with file, browser and desktop-app tools can carry out on its own, \
             using results of earlier steps. Don't add steps the goal doesn't need. \
             Reply with JSON only: {{\"steps\": [\"...\", \"...\"]}}"
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
