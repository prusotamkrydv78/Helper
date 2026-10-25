//! AI provider layer. The UI talks to `commands`, which talk to a provider here.
//! Tool calling will plug in at `openai::stream_chat` (tool definitions in the
//! request, `tool_calls` deltas surfaced as new `StreamEvent` variants).

pub mod openai;
pub mod history;
pub mod sse;
pub mod types;
