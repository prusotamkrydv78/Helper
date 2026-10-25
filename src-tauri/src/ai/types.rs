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
    /// User's tool permission settings (enforced here, not just in the UI).
    #[serde(default)]
    pub permissions: ToolPermissions,
    /// Upper bound on tool-calling rounds for this request.
    pub max_tool_rounds: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionLevel {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPermissions {
    pub read: PermissionLevel,
    pub write: PermissionLevel,
}

impl Default for ToolPermissions {
    fn default() -> Self {
        Self { read: PermissionLevel::Allow, write: PermissionLevel::Ask }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Running,
    AwaitingApproval,
    Completed,
    Failed,
    Skipped,
    Cancelled,
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
    /// The model requested a tool call (emitted before it runs).
    ToolCall {
        call_id: String,
        name: String,
        title: String,
        /// Arguments as sent by the model (long `content` values shortened for display).
        arguments: serde_json::Value,
        requires_approval: bool,
        read_only: bool,
    },
    /// Progress or outcome of a tool call. `output` is the real tool result.
    ToolStatus {
        call_id: String,
        status: ToolCallStatus,
        summary: Option<String>,
        output: Option<String>,
        error: Option<String>,
        file: Option<crate::tools::FileChange>,
    },
    /// The response finished normally.
    Done { stop_reason: Option<String>, output_tokens: Option<u64> },
}

/// Result of a completed stream, used for logging and the final `Done` event.
#[derive(Debug, Clone)]
pub struct StreamSummary {
    pub stop_reason: Option<String>,
    pub output_tokens: Option<u64>,
}
