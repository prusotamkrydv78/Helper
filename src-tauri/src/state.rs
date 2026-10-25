use std::collections::HashMap;
use std::sync::Mutex;

use tokio_util::sync::CancellationToken;

use crate::ai::openai::OpenAiClient;

pub struct AppState {
    pub ai: OpenAiClient,
    /// In-flight chat requests by request id, so they can be cancelled.
    inflight: Mutex<HashMap<String, CancellationToken>>,
}

impl AppState {
    pub fn new() -> Self {
        Self { ai: OpenAiClient::new(), inflight: Mutex::new(HashMap::new()) }
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
}
