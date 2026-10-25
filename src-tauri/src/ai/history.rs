//! Turns UI history into a valid Messages API conversation: starts with a user
//! turn, ends with a user turn, no empty messages, consecutive roles merged.
//! Order is always preserved.

use super::types::{ChatMessage, ChatRole};
use crate::error::AppError;

/// Hard cap so an oversized history fails loudly instead of being truncated.
const MAX_TOTAL_CHARS: usize = 3_000_000;

pub fn normalize(messages: &[ChatMessage]) -> Result<Vec<ChatMessage>, AppError> {
    let mut out: Vec<ChatMessage> = Vec::with_capacity(messages.len());
    let mut total = 0usize;

    for m in messages {
        let text = m.content.trim();
        if text.is_empty() {
            continue;
        }
        // The conversation must start with the user.
        if out.is_empty() && m.role == ChatRole::Assistant {
            continue;
        }
        total += text.len();
        match out.last_mut() {
            Some(prev) if prev.role == m.role => {
                prev.content.push_str("\n\n");
                prev.content.push_str(text);
            }
            _ => out.push(ChatMessage { role: m.role, content: text.to_owned() }),
        }
    }

    if total > MAX_TOTAL_CHARS {
        return Err(AppError::invalid(
            "This conversation is too long to send. Start a new chat to continue.",
        ));
    }
    match out.last() {
        None => Err(AppError::invalid("There is no message to send.")),
        Some(m) if m.role != ChatRole::User => {
            Err(AppError::invalid("The conversation must end with a user message."))
        }
        Some(_) => Ok(out),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: ChatRole, c: &str) -> ChatMessage {
        ChatMessage { role, content: c.into() }
    }

    #[test]
    fn keeps_order_and_merges_consecutive_roles() {
        let out = normalize(&[
            msg(ChatRole::User, "a"),
            msg(ChatRole::User, "b"),
            msg(ChatRole::Assistant, "c"),
            msg(ChatRole::User, "d"),
        ])
        .unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].content, "a\n\nb");
        assert_eq!(out[1].role, ChatRole::Assistant);
        assert_eq!(out[2].content, "d");
    }

    #[test]
    fn drops_leading_assistant_and_empty_messages() {
        let out = normalize(&[
            msg(ChatRole::Assistant, "hi"),
            msg(ChatRole::User, "q"),
            msg(ChatRole::Assistant, "   "),
            msg(ChatRole::User, "q2"),
        ])
        .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].content, "q\n\nq2");
    }

    #[test]
    fn rejects_trailing_assistant_and_empty_history() {
        assert!(normalize(&[msg(ChatRole::User, "q"), msg(ChatRole::Assistant, "a")]).is_err());
        assert!(normalize(&[]).is_err());
    }
}
