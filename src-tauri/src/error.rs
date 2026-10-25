//! Error type shared by every command. Serialized as `{ kind, message, retryable, status? }`
//! so the frontend can branch on `kind` instead of parsing messages.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    MissingApiKey,
    Authentication,
    PermissionDenied,
    InvalidRequest,
    NotFound,
    RateLimited,
    Overloaded,
    Server,
    Network,
    Refusal,
    Cancelled,
    Storage,
    Internal,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{kind:?}: {message}")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    /// Whether retrying the same request may succeed.
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        let retryable = matches!(
            kind,
            ErrorKind::RateLimited | ErrorKind::Overloaded | ErrorKind::Server | ErrorKind::Network
        );
        Self { kind, message: message.into(), retryable, status: None }
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn missing_api_key() -> Self {
        Self::new(
            ErrorKind::MissingApiKey,
            "No API key is configured. Add one in Settings → AI model, or set OPENAI_API_KEY.",
        )
    }

    pub fn cancelled() -> Self {
        Self::new(ErrorKind::Cancelled, "Request cancelled")
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidRequest, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        // keyring errors never contain the secret itself.
        AppError::new(ErrorKind::Storage, format!("Credential store error: {e}"))
    }
}
