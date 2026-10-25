use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::ai::openai::OpenAiClient;
use crate::tools::allowed_dirs::AllowedDirs;

pub struct AppState {
    pub ai: OpenAiClient,
    pub allowed_dirs: AllowedDirs,
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
