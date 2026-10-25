use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::ai::openai::OpenAiClient;
use crate::browser::worker::BrowserWorker;
use crate::audit::AuditLog;
use crate::google::GoogleClient;
use crate::graph::GraphClient;
use crate::memory::MemoryStore;
use crate::tools::allowed_dirs::AllowedDirs;

pub struct AppState {
    pub ai: OpenAiClient,
    pub allowed_dirs: AllowedDirs,
    /// Managed browser session (Playwright worker), started on first use.
    pub browser: Arc<BrowserWorker>,
    pub memory: MemoryStore,
    pub audit: AuditLog,
    pub voice: crate::voice::VoiceState,
    /// Opt-in clipboard history (memory only).
    pub clipboard: Arc<crate::clipboard::ClipHistory>,
    /// Microsoft Graph (Outlook mail and calendar).
    pub graph: GraphClient,
    /// Google Workspace (Gmail and Google Calendar).
    pub google: GoogleClient,
    /// Hide to the tray instead of quitting when the window is closed.
    pub keep_in_tray: std::sync::atomic::AtomicBool,
    /// In-flight chat requests by request id, so they can be cancelled.
    inflight: Mutex<HashMap<String, CancellationToken>>,
    /// Tool calls waiting for the user, keyed by "request_id:call_id".
    approvals: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

fn approval_key(request_id: &str, call_id: &str) -> String {
    format!("{request_id}:{call_id}")
}

impl AppState {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            ai: OpenAiClient::new(),
            allowed_dirs: AllowedDirs::load(config_dir),
            browser: Arc::new(BrowserWorker::new()),
            memory: MemoryStore::load(config_dir),
            audit: AuditLog::new(config_dir),
            voice: Default::default(),
            clipboard: Arc::new(crate::clipboard::ClipHistory::default()),
            graph: GraphClient::load(config_dir),
            google: GoogleClient::load(config_dir),
            keep_in_tray: std::sync::atomic::AtomicBool::new(false),
            inflight: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
        }
    }

    pub fn register(&self, id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        let mut map = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
        // A reused id cancels the stale request rather than leaking it.
        if let Some(old) = map.insert(id.to_owned(), token.clone()) {
            old.cancel();
        }
        token
    }

    pub fn unregister(&self, id: &str) {
        self.inflight.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        let prefix = format!("{id}:");
        self.approvals.lock().unwrap_or_else(|e| e.into_inner()).retain(|k, _| !k.starts_with(&prefix));
    }

    /// Returns true if a matching in-flight request was found.
    /// Cancels every in-flight request (running tools and pending approvals). Returns how many.
    pub fn cancel_all(&self) -> usize {
        let map = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
        map.values().for_each(|t| t.cancel());
        map.len()
    }

    pub fn cancel(&self, id: &str) -> bool {
        match self.inflight.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            Some(t) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    pub fn await_approval(&self, request_id: &str, call_id: &str) -> oneshot::Receiver<bool> {
        let (tx, rx) = oneshot::channel();
        self.approvals.lock().unwrap_or_else(|e| e.into_inner()).insert(approval_key(request_id, call_id), tx);
        rx
    }

    pub fn drop_approval(&self, request_id: &str, call_id: &str) {
        self.approvals.lock().unwrap_or_else(|e| e.into_inner()).remove(&approval_key(request_id, call_id));
    }

    /// Returns false if nothing was waiting for this decision.
    pub fn resolve_approval(&self, request_id: &str, call_id: &str, approved: bool) -> bool {
        let tx = self.approvals.lock().unwrap_or_else(|e| e.into_inner()).remove(&approval_key(request_id, call_id));
        tx.is_some_and(|tx| tx.send(approved).is_ok())
    }
}
