//! Typed request/response structures exchanged with the frontend.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
}

impl ChatRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

/// A chat turn sent from the UI. `messages` is the full ordered history,
/// ending with the new user message.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    /// Client-generated id used to cancel this request.
    pub request_id: String,
    pub conversation_id: String,
    pub messages: Vec<ChatMessage>,
    /// Falls back to `OPENAI_MODEL`, then the built-in default.
    pub model: Option<String>,
    pub system_prompt: Option<String>,
}

/// Events streamed to the UI over a Tauri channel, in order.
///
/// Future tool calling will add variants here (e.g. `ToolUse`, `ToolResult`)
/// without changing the transport.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    /// The model that is actually serving the response (may differ after a fallback).
    Start { model: String },
    /// A chunk of assistant text.
    Delta { text: String },
    /// The response finished normally.
    Done { stop_reason: Option<String>, output_tokens: Option<u64> },
}

/// Result of a completed stream, used for logging and the final `Done` event.
#[derive(Debug, Clone)]
pub struct StreamSummary {
    pub model: String,
    pub stop_reason: Option<String>,
    pub output_tokens: Option<u64>,
}
