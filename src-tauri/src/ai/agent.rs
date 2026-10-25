//! The tool-calling loop: stream a completion, execute any requested tools,
//! return their real results to the model, repeat until it answers in text.

use std::sync::Arc;

use futures_util::future::join_all;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::history;
use super::openai::ToolCallRequest;
use super::types::{ChatRequest, PermissionLevel, StreamEvent, StreamSummary, ToolCallStatus, ToolPermissions};
use crate::config::ApiKey;
use crate::error::{AppError, ErrorKind};
use crate::state::AppState;
use crate::tools::paths::PathGuard;
use crate::tools::{self, FileChange, ToolError, ToolKind, ToolSpec, TOOL_TIMEOUT};

pub type Emit<'a> = &'a (dyn Fn(StreamEvent) + Send + Sync);

const DEFAULT_MAX_ROUNDS: u32 = 10;
/// Tool output shown in the UI is capped; the model still gets the full result.
const UI_OUTPUT_LIMIT: usize = 20_000;
const UI_ARG_LIMIT: usize = 2_000;

fn level(perms: ToolPermissions, kind: ToolKind) -> PermissionLevel {
    match kind {
        ToolKind::Read => perms.read,
        ToolKind::Write => perms.write,
    }
}

pub async fn run(
    state: &AppState,
    key: &ApiKey,
    req: &ChatRequest,
    cancel: &CancellationToken,
    emit: Emit<'_>,
) -> Result<StreamSummary, AppError> {
    let history = history::normalize(&req.messages)?;
    let model = state.ai.resolve_model(req.model.as_deref());
    let guard = Arc::new(PathGuard::new(&state.allowed_dirs.snapshot()));
    let perms = req.permissions;

    // Tools are offered only when a folder is permitted and the user hasn't disabled them.
    let offered: Vec<&'static ToolSpec> = if guard.has_roots() {
        tools::TOOLS.iter().filter(|t| level(perms, t.kind) != PermissionLevel::Deny).collect()
    } else {
        Vec::new()
    };
    let tool_defs = (!offered.is_empty()).then(|| tools::openai_definitions(offered.iter().copied()));

    let mut messages = vec![json!({ "role": "system", "content": system_prompt(req, &guard, perms) })];
    messages.extend(history.iter().map(|m| json!({ "role": m.role.as_str(), "content": m.content })));

    let max_rounds = req.max_tool_rounds.unwrap_or(DEFAULT_MAX_ROUNDS).clamp(1, 50);
    log::info!(
        "chat request {} started: model={model} messages={} tools={} conversation={}",
        req.request_id,
        history.len(),
        offered.len(),
        req.conversation_id
    );
    emit(StreamEvent::Start { model: model.clone() });

    let started = std::time::Instant::now();
    let mut wrote_text = false;
    let mut output_tokens: u64 = 0;

    for round in 0..=max_rounds {
        // Separate text from different rounds with a paragraph break.
        let mut needs_break = wrote_text;
        let mut on_text = |t: &str| {
            if needs_break {
                emit(StreamEvent::Delta { text: "\n\n".into() });
                needs_break = false;
            }
            emit(StreamEvent::Delta { text: t.to_owned() });
        };
        // The final round withholds tools so the model must answer.
        let tools_for_round = if round < max_rounds { tool_defs.as_ref() } else { None };
        let r = state
            .ai
            .stream_round(key, &model, &messages, tools_for_round, &req.request_id, cancel, &mut on_text)
            .await?;
        wrote_text |= !r.text.is_empty();
        output_tokens += r.output_tokens.unwrap_or(0);

        if r.tool_calls.is_empty() {
            log::info!(
                "chat request {} finished in {:?}: model={} rounds={} finish_reason={:?} output_tokens={output_tokens}",
                req.request_id,
                started.elapsed(),
                r.model,
                round + 1,
                r.finish_reason
            );
            return Ok(StreamSummary { stop_reason: r.finish_reason, output_tokens: Some(output_tokens) });
        }

        log::info!("chat request {}: round {} requested {} tool call(s)", req.request_id, round + 1, r.tool_calls.len());
        messages.push(json!({
            "role": "assistant",
            "content": if r.text.is_empty() { Value::Null } else { Value::String(r.text.clone()) },
            "tool_calls": r.tool_calls.iter().map(|c| json!({
                "id": c.id,
                "type": "function",
                "function": { "name": c.name, "arguments": c.arguments }
            })).collect::<Vec<_>>(),
        }));

        let results = execute_calls(state, req, &guard, perms, &r.tool_calls, cancel, emit).await?;
        for (call, content) in r.tool_calls.iter().zip(results) {
            messages.push(json!({ "role": "tool", "tool_call_id": call.id, "content": content }));
        }
    }

    Err(AppError::new(ErrorKind::Internal, format!("Stopped after {max_rounds} tool rounds without a final answer.")))
}

fn system_prompt(req: &ChatRequest, guard: &PathGuard, perms: ToolPermissions) -> String {
    let mut s = req.system_prompt.as_deref().map(str::trim).unwrap_or_default().to_owned();
    if !s.is_empty() {
        s.push_str("\n\n");
    }
    if !guard.has_roots() {
        s.push_str(
            "File tools are currently unavailable because the user hasn't permitted any folders. \
             If asked to work with files, explain that they can add a folder in Settings → Tool permissions.",
        );
        return s;
    }
    s.push_str("You can work with files on the user's computer using tools, limited to these permitted folders:\n");
    for r in guard.root_list() {
        s.push_str(&format!("- {r}\n"));
    }
    s.push_str(
        "\nRules: use only paths inside these folders (prefer absolute paths). Look before you change things. \
         Never claim a file was created, changed or read unless the tool result confirms it. \
         If a tool fails or the user declines it, say so plainly.",
    );
    if perms.write == PermissionLevel::Deny {
        s.push_str(" Creating or changing files is disabled in the user's settings.");
    } else if perms.write == PermissionLevel::Ask {
        s.push_str(
            " When the user asks you to create or change files, call the tool directly: the app shows \
             them an approval prompt before anything runs. Don't ask for permission in your reply.",
        );
    }
    s
}

struct Prepared {
    call: ToolCallRequest,
    spec: Option<&'static ToolSpec>,
    args: Result<Value, ToolError>,
    level: PermissionLevel,
}

impl Prepared {
    /// Read-only, auto-allowed and valid: safe to run alongside its neighbours.
    fn concurrent_safe(&self) -> bool {
        self.spec.is_some_and(|s| s.kind == ToolKind::Read)
            && self.level == PermissionLevel::Allow
            && self.args.is_ok()
    }
}

/// Runs a round's tool calls. Consecutive read-only calls run concurrently;
/// anything that writes runs alone, in the order the model requested.
/// Returns one result string per call, in order.
async fn execute_calls(
    state: &AppState,
    req: &ChatRequest,
    guard: &Arc<PathGuard>,
    perms: ToolPermissions,
    calls: &[ToolCallRequest],
    cancel: &CancellationToken,
    emit: Emit<'_>,
) -> Result<Vec<String>, AppError> {
    let prepared: Vec<Prepared> = calls
        .iter()
        .map(|c| {
            let spec = tools::find(&c.name);
            let raw = if c.arguments.trim().is_empty() { "{}" } else { c.arguments.as_str() };
            let args = serde_json::from_str::<Value>(raw)
                .map_err(|e| ToolError::invalid(format!("Arguments are not valid JSON: {e}")))
                .and_then(|v| if v.is_object() { Ok(v) } else { Err(ToolError::invalid("Arguments must be a JSON object.")) });
            let level = spec.map(|s| level(perms, s.kind)).unwrap_or(PermissionLevel::Deny);
            Prepared { call: c.clone(), spec, args, level }
        })
        .collect();

    // Show every requested call up front so the UI lists the whole plan.
    for p in &prepared {
        emit(StreamEvent::ToolCall {
            call_id: p.call.id.clone(),
            name: p.call.name.clone(),
            title: p.spec.map(|s| s.title).unwrap_or("Unknown tool").to_owned(),
            arguments: p.args.as_ref().map(display_args).unwrap_or_else(|_| Value::String(p.call.arguments.clone())),
            requires_approval: p.spec.is_some() && p.level == PermissionLevel::Ask,
            read_only: p.spec.is_some_and(|s| s.kind == ToolKind::Read),
        });
    }

    let mut results: Vec<String> = Vec::with_capacity(prepared.len());
    let mut i = 0;
    while i < prepared.len() {
        if prepared[i].concurrent_safe() {
            let mut j = i;
            while j < prepared.len() && prepared[j].concurrent_safe() {
                j += 1;
            }
            let batch = join_all(prepared[i..j].iter().map(|p| run_one(state, req, guard, p, cancel, emit))).await;
            for r in batch {
                results.push(r?);
            }
            i = j;
        } else {
            results.push(run_one(state, req, guard, &prepared[i], cancel, emit).await?);
            i += 1;
        }
    }
    Ok(results)
}

fn status(emit: Emit<'_>, call_id: &str, status: ToolCallStatus) {
    emit(StreamEvent::ToolStatus { call_id: call_id.to_owned(), status, summary: None, output: None, error: None, file: None });
}

fn fail(emit: Emit<'_>, call_id: &str, err: &ToolError, status: ToolCallStatus) -> String {
    emit(StreamEvent::ToolStatus {
        call_id: call_id.to_owned(),
        status,
        summary: None,
        output: None,
        error: Some(err.message.clone()),
        file: None,
    });
    err.to_json().to_string()
}

async fn run_one(
    state: &AppState,
    req: &ChatRequest,
    guard: &Arc<PathGuard>,
    p: &Prepared,
    cancel: &CancellationToken,
    emit: Emit<'_>,
) -> Result<String, AppError> {
    let id = p.call.id.as_str();
    let Some(spec) = p.spec else {
        log::warn!("request {}: model requested unknown tool `{}`", req.request_id, p.call.name);
        return Ok(fail(emit, id, &ToolError::invalid(format!("Unknown tool `{}`.", p.call.name)), ToolCallStatus::Failed));
    };
    let args = match &p.args {
        Ok(a) => a.clone(),
        Err(e) => return Ok(fail(emit, id, e, ToolCallStatus::Failed)),
    };
    if p.level == PermissionLevel::Deny {
        return Ok(fail(emit, id, &ToolError::denied("This tool is disabled in the user's settings."), ToolCallStatus::Failed));
    }

    if p.level == PermissionLevel::Ask {
        status(emit, id, ToolCallStatus::AwaitingApproval);
        let rx = state.await_approval(&req.request_id, id);
        let approved = tokio::select! {
            _ = cancel.cancelled() => {
                state.drop_approval(&req.request_id, id);
                status(emit, id, ToolCallStatus::Cancelled);
                return Err(AppError::cancelled());
            }
            r = rx => r.unwrap_or(false),
        };
        if !approved {
            log::info!("request {}: user declined {} ({id})", req.request_id, spec.name);
            let err = ToolError { code: "declined_by_user", message: "The user declined this action.".into() };
            return Ok(fail(emit, id, &err, ToolCallStatus::Skipped));
        }
    }

    status(emit, id, ToolCallStatus::Running);
    log::info!("request {}: running {} ({id})", req.request_id, spec.name);
    let started = std::time::Instant::now();
    let g = Arc::clone(guard);
    let task = tauri::async_runtime::spawn_blocking(move || tools::execute(spec, &args, &g));
    let outcome = tokio::select! {
        _ = cancel.cancelled() => {
            status(emit, id, ToolCallStatus::Cancelled);
            return Err(AppError::cancelled());
        }
        r = tokio::time::timeout(TOOL_TIMEOUT, task) => r,
    };

    let result = match outcome {
        Err(_) => Err(ToolError::timeout()),
        Ok(Err(join)) => Err(ToolError { code: "internal_error", message: format!("Tool crashed: {join}") }),
        Ok(Ok(r)) => r,
    };
    match result {
        Ok(out) => {
            log::info!("request {}: {} ({id}) completed in {:?}: {}", req.request_id, spec.name, started.elapsed(), out.summary);
            emit(StreamEvent::ToolStatus {
                call_id: id.to_owned(),
                status: ToolCallStatus::Completed,
                summary: Some(out.summary),
                output: Some(truncate(&serde_json::to_string_pretty(&out.content).unwrap_or_default(), UI_OUTPUT_LIMIT)),
                error: None,
                file: out.file.map(|f: FileChange| f),
            });
            Ok(out.content.to_string())
        }
        Err(e) => {
            log::warn!("request {}: {} ({id}) failed: {} {}", req.request_id, spec.name, e.code, e.message);
            Ok(fail(emit, id, &e, ToolCallStatus::Failed))
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_owned();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… ({} more characters)", &s[..end], s.len() - end)
}

/// Arguments for display: long `content` values are shortened.
fn display_args(args: &Value) -> Value {
    let mut v = args.clone();
    if let Some(Value::String(c)) = v.get_mut("content") {
        if c.len() > UI_ARG_LIMIT {
            *c = truncate(c, UI_ARG_LIMIT);
        }
    }
    v
}
