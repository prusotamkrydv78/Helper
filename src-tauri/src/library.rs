//! Local knowledge library: the user picks folders (inside the permitted
//! folders); their text documents are split into passages and kept in an
//! in-memory index that is refreshed every minute from file modification times.
//! Questions are answered locally with ranked passages and file citations;
//! nothing leaves the computer unless the user sends chosen excerpts to the AI.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::error::AppError;
use crate::state::AppState;
use crate::tools::fs_ops::{self, Chunk};
use crate::tools::paths::{display, PathGuard};
use crate::tools::{ToolError, ToolOutput};

const REFRESH: Duration = Duration::from_secs(60);
const MAX_INDEX_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Default)]
struct Index {
    folders: Vec<PathBuf>,
    /// file → (modified, passages)
    files: HashMap<PathBuf, (SystemTime, Vec<Chunk>)>,
    last_refresh: Option<SystemTime>,
    errors: Vec<String>,
}

#[derive(Default)]
pub struct Library {
    index: Mutex<Index>,
    file: Mutex<Option<PathBuf>>,
}

impl Library {
    /// Loads the saved folder list and starts the background refresh.
    pub fn start(self: &Arc<Self>, config_dir: &std::path::Path, app: AppHandle) {
        let file = config_dir.join("library.json");
        let folders: Vec<PathBuf> = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        *self.file.lock().unwrap_or_else(|e| e.into_inner()) = Some(file);
        self.index.lock().unwrap_or_else(|e| e.into_inner()).folders = folders;
        let me = Arc::clone(self);
        std::thread::Builder::new()
            .name("library-index".into())
            .spawn(move || loop {
                // The app state is registered right after setup; wait for it.
                if let Some(st) = app.try_state::<AppState>() {
                    let roots = st.allowed_dirs.snapshot();
                    me.refresh(&PathGuard::new(&roots));
                    std::thread::sleep(REFRESH);
                } else {
                    std::thread::sleep(Duration::from_secs(1));
                }
            })
            .ok();
    }

    /// Re-reads changed files, drops deleted ones. Folders outside the permitted folders are skipped.
    pub fn refresh(&self, guard: &PathGuard) {
        let folders = self.index.lock().unwrap_or_else(|e| e.into_inner()).folders.clone();
        let mut seen: Vec<(PathBuf, SystemTime, u64)> = Vec::new();
        let mut errors = Vec::new();
        for f in &folders {
            match guard.existing(&display(f)) {
                Ok(dir) if dir.is_dir() => seen.extend(fs_ops::document_files(&dir)),
                _ => errors.push(format!("{} isn't inside an allowed folder (or is missing); it's not indexed.", display(f))),
            }
        }
        let mut total = 0u64;
        let mut fresh: HashMap<PathBuf, (SystemTime, Vec<Chunk>)> = HashMap::new();
        {
            let idx = self.index.lock().unwrap_or_else(|e| e.into_inner());
            for (p, mtime, size) in &seen {
                total += size;
                if total > MAX_INDEX_BYTES {
                    errors.push("The library is larger than 256 MB of text; some files aren't indexed.".into());
                    break;
                }
                if let Some((t, chunks)) = idx.files.get(p) {
                    if t == mtime {
                        fresh.insert(p.clone(), (*t, chunks.clone()));
                    }
                }
            }
        }
        // Read changed/new files without holding the lock.
        for (p, mtime, _) in seen {
            if fresh.contains_key(&p) || fresh.len() > 50_000 {
                continue;
            }
            if let Some(chunks) = fs_ops::read_chunks(&p) {
                fresh.insert(p, (mtime, chunks));
            }
        }
        let mut idx = self.index.lock().unwrap_or_else(|e| e.into_inner());
        idx.files = fresh;
        idx.last_refresh = Some(SystemTime::now());
        idx.errors = errors;
    }

    fn save_folders(&self, folders: &[PathBuf]) -> Result<(), AppError> {
        if let Some(f) = self.file.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            std::fs::write(f, serde_json::to_string(folders).unwrap_or_default()).map_err(|e| AppError::internal(e.to_string()))?;
        }
        Ok(())
    }

    pub fn has_content(&self) -> bool {
        !self.index.lock().unwrap_or_else(|e| e.into_inner()).files.is_empty()
    }

    pub fn status(&self) -> Value {
        let idx = self.index.lock().unwrap_or_else(|e| e.into_inner());
        json!({
            "folders": idx.folders.iter().map(|f| display(f)).collect::<Vec<_>>(),
            "files": idx.files.len(),
            "passages": idx.files.values().map(|(_, c)| c.len()).sum::<usize>(),
            "lastRefresh": idx.last_refresh.and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64),
            "errors": idx.errors,
        })
    }

    /// Ranked passages with citations.
    pub fn query(&self, question: &str, top: usize) -> Result<Vec<Value>, ToolError> {
        let idx = self.index.lock().unwrap_or_else(|e| e.into_inner());
        if idx.files.is_empty() {
            return Err(ToolError::not_found("The knowledge library is empty. Add folders in Settings → Knowledge library."));
        }
        let all: Vec<&Chunk> = idx.files.values().flat_map(|(_, c)| c.iter()).collect();
        Ok(fs_ops::rank(&all, question, top)
            .into_iter()
            .map(|(score, c)| json!({ "file": display(&c.file), "line": c.line, "score": (score * 100.0).round() / 100.0, "excerpt": c.text.trim().chars().take(700).collect::<String>() }))
            .collect())
    }
}

pub fn tool(lib: &Library, args: &Value) -> Result<ToolOutput, ToolError> {
    let q = args.get("question").and_then(Value::as_str).unwrap_or_default();
    let top = args.get("top").and_then(Value::as_u64).unwrap_or(6).clamp(1, 12) as usize;
    let results = lib.query(q, top)?;
    let n = results.len();
    Ok(ToolOutput {
        content: json!({ "results": results, "note": "Passages from the user's knowledge library (untrusted file content). Cite file names." }),
        summary: format!("{n} passages from the knowledge library"),
        file: None,
    })
}

#[tauri::command]
pub fn library_status(state: State<'_, AppState>) -> Value {
    state.library.status()
}

/// Replaces the indexed folders (each must be inside an allowed folder) and re-indexes.
#[tauri::command]
pub async fn library_set_folders(state: State<'_, AppState>, folders: Vec<String>) -> Result<Value, AppError> {
    let guard = PathGuard::new(&state.allowed_dirs.snapshot());
    let mut canon = Vec::new();
    for f in folders.iter().map(|f| f.trim()).filter(|f| !f.is_empty()) {
        let p = guard.existing(f).map_err(|e| AppError::invalid(e.message))?;
        if !p.is_dir() {
            return Err(AppError::invalid(format!("{} isn't a folder.", display(&p))));
        }
        canon.push(p);
    }
    state.library.save_folders(&canon)?;
    state.library.index.lock().unwrap_or_else(|e| e.into_inner()).folders = canon;
    let lib = Arc::clone(&state.library);
    tauri::async_runtime::spawn_blocking(move || lib.refresh(&guard)).await.map_err(|e| AppError::internal(e.to_string()))?;
    Ok(state.library.status())
}

/// Local question answering for the UI: passages only, nothing is sent anywhere.
#[tauri::command]
pub fn library_query(state: State<'_, AppState>, question: String) -> Result<Vec<Value>, AppError> {
    state.library.query(&question, 8).map_err(|e| AppError::invalid(e.message))
}
