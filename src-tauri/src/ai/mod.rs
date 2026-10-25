//! AI provider layer. `commands` calls `agent::run`, which drives the tool-calling
//! loop over `openai` (streaming completions) and `crate::tools` (execution).

pub mod agent;
pub mod history;
pub mod openai;
pub mod sse;
pub mod types;
