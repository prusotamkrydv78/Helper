//! OpenAI Chat Completions client (raw HTTP + SSE streaming).
//!
//! Configuration (environment, optional):
//! - `OPENAI_MODEL`    default model when the UI doesn't specify one
//! - `OPENAI_BASE_URL` alternative API base, e.g. a proxy (default `https://api.openai.com/v1`)

use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::history;
use super::sse::SseParser;
use super::types::{ChatRequest, StreamEvent, StreamSummary};
use crate::config::ApiKey;
use crate::error::{AppError, ErrorKind};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
/// Placeholder default — override in Settings or with `OPENAI_MODEL`.
pub const FALLBACK_MODEL: &str = "gpt-4o-mini";
/// Automatic retries for transient failures before any output is streamed.
const MAX_RETRIES: u32 = 2;

#[derive(Serialize)]
struct WireMessage<'a> {
    role: &'static str,
    content: &'a str,
}

#[derive(Serialize)]
struct StreamOptions {
    include_usage: bool,
}

#[derive(Serialize)]
struct CompletionBody<'a> {
    model: &'a str,
    messages: Vec<WireMessage<'a>>,
    stream: bool,
    stream_options: StreamOptions,
}

pub struct OpenAiClient {
    http: reqwest::Client,
    url: String,
    default_model: String,
}

impl OpenAiClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            // Silence this long mid-stream means a dead connection.
            .read_timeout(Duration::from_secs(120))
            .user_agent(concat!("ai-automation/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("failed to build HTTP client");
        let base = std::env::var("OPENAI_BASE_URL")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        let default_model = std::env::var("OPENAI_MODEL")
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| FALLBACK_MODEL.to_owned());
        log::info!("OpenAI client ready: base={base} default_model={default_model}");
        Self { http, url: format!("{base}/chat/completions"), default_model }
    }

    /// Streams one assistant reply, calling `emit` for each event in order.
    pub async fn stream_chat(
        &self,
        key: &ApiKey,
        req: &ChatRequest,
        cancel: &CancellationToken,
        mut emit: impl FnMut(StreamEvent),
    ) -> Result<StreamSummary, AppError> {
        let history = history::normalize(&req.messages)?;
        let model = req
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .unwrap_or(&self.default_model);

        let system = req.system_prompt.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let mut messages = Vec::with_capacity(history.len() + 1);
        if let Some(s) = system {
            messages.push(WireMessage { role: "system", content: s });
        }
        messages.extend(history.iter().map(|m| WireMessage { role: m.role.as_str(), content: &m.content }));

        let body = CompletionBody {
            model,
            messages,
            stream: true,
            stream_options: StreamOptions { include_usage: true },
        };

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let mut auth = HeaderValue::from_str(&format!("Bearer {}", key.expose()))
            .map_err(|_| AppError::new(ErrorKind::Authentication, "The API key contains invalid characters."))?;
        auth.set_sensitive(true);
        headers.insert(AUTHORIZATION, auth);

        log::info!(
            "chat request {} started: model={model} messages={} conversation={}",
            req.request_id,
            history.len(),
            req.conversation_id
        );
        let started = Instant::now();
        let response = self.send_with_retries(&headers, &body, &req.request_id, cancel).await?;
        let summary = read_stream(response, model, cancel, &mut emit).await?;
        log::info!(
            "chat request {} finished in {:?}: model={} finish_reason={:?} output_tokens={:?}",
            req.request_id,
            started.elapsed(),
            summary.model,
            summary.stop_reason,
            summary.output_tokens
        );
        Ok(summary)
    }

    async fn send_with_retries(
        &self,
        headers: &HeaderMap,
        body: &CompletionBody<'_>,
        request_id: &str,
        cancel: &CancellationToken,
    ) -> Result<reqwest::Response, AppError> {
        let mut attempt = 0;
        loop {
            let send = self.http.post(&self.url).headers(headers.clone()).json(body).send();
            let result = tokio::select! {
                _ = cancel.cancelled() => return Err(AppError::cancelled()),
                r = send => r,
            };

            let (err, retry_after) = match result {
                Ok(resp) if resp.status().is_success() => return Ok(resp),
                Ok(resp) => {
                    let retry_after = resp
                        .headers()
                        .get(RETRY_AFTER)
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok())
                        .map(Duration::from_secs);
                    let status = resp.status().as_u16();
                    let text = resp.text().await.unwrap_or_default();
                    (http_error(status, &text), retry_after)
                }
                Err(e) => (network_error(&e), None),
            };

            if !err.retryable || attempt >= MAX_RETRIES {
                log::warn!("chat request {request_id} failed: {:?} {}", err.kind, err.message);
                return Err(err);
            }
            attempt += 1;
            let delay = retry_after.unwrap_or(Duration::from_millis(800 * 2u64.pow(attempt)));
            log::warn!(
                "chat request {request_id}: {:?}, retrying in {delay:?} (attempt {attempt}/{MAX_RETRIES})",
                err.kind
            );
            tokio::select! {
                _ = cancel.cancelled() => return Err(AppError::cancelled()),
                _ = tokio::time::sleep(delay.min(Duration::from_secs(20))) => {}
            }
        }
    }
}

async fn read_stream(
    response: reqwest::Response,
    requested_model: &str,
    cancel: &CancellationToken,
    emit: &mut impl FnMut(StreamEvent),
) -> Result<StreamSummary, AppError> {
    let mut stream = response.bytes_stream();
    let mut parser = SseParser::default();
    let mut model = requested_model.to_owned();
    let mut started = false;
    let mut finish_reason: Option<String> = None;
    let mut output_tokens: Option<u64> = None;
    let mut refusal = String::new();
    let mut done = false;

    while !done {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Err(AppError::cancelled()),
            c = stream.next() => c,
        };
        let bytes = match chunk {
            None => break,
            Some(Ok(b)) => b,
            Some(Err(e)) => return Err(network_error(&e)),
        };

        for ev in parser.push(&bytes) {
            if ev.data.trim() == "[DONE]" {
                done = true;
                break;
            }
            let data: Value = match serde_json::from_str(&ev.data) {
                Ok(v) => v,
                Err(_) => {
                    log::debug!("skipping non-JSON SSE payload");
                    continue;
                }
            };
            if data.get("error").is_some_and(|e| !e.is_null()) {
                return Err(api_error(&data["error"], None));
            }
            if !started {
                if let Some(m) = data["model"].as_str() {
                    model = m.to_owned();
                }
                emit(StreamEvent::Start { model: model.clone() });
                started = true;
            }
            if let Some(n) = data["usage"]["completion_tokens"].as_u64() {
                output_tokens = Some(n);
            }
            let Some(choice) = data["choices"].get(0) else { continue };
            if let Some(t) = choice["delta"]["content"].as_str() {
                if !t.is_empty() {
                    emit(StreamEvent::Delta { text: t.to_owned() });
                }
            }
            if let Some(r) = choice["delta"]["refusal"].as_str() {
                refusal.push_str(r);
            }
            if let Some(r) = choice["finish_reason"].as_str() {
                finish_reason = Some(r.to_owned());
            }
        }
    }

    if !done && finish_reason.is_none() {
        return Err(AppError::new(ErrorKind::Network, "The connection closed before the response finished."));
    }
    if !refusal.is_empty() || finish_reason.as_deref() == Some("content_filter") {
        let msg = if refusal.is_empty() {
            "The response was blocked by the content filter. Try rephrasing your request.".to_owned()
        } else {
            refusal
        };
        return Err(AppError::new(ErrorKind::Refusal, msg));
    }
    Ok(StreamSummary { model, stop_reason: finish_reason, output_tokens })
}

fn network_error(e: &reqwest::Error) -> AppError {
    let msg = if e.is_timeout() {
        "The request timed out. Check your connection and try again."
    } else if e.is_connect() {
        "Couldn't reach the AI service. Check your internet connection."
    } else {
        "A network error interrupted the response."
    };
    log::warn!("network error: {e}");
    AppError::new(ErrorKind::Network, msg)
}

/// Maps an HTTP error response (status + JSON body) to an `AppError`.
fn http_error(status: u16, body: &str) -> AppError {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    api_error(&parsed["error"], Some(status)).with_status(status)
}

/// Maps an OpenAI `error` object (and HTTP status, when known) to an `AppError`.
fn api_error(error: &Value, status: Option<u16>) -> AppError {
    let code = error["code"].as_str().unwrap_or("");
    let kind = error["type"].as_str().unwrap_or("");
    let message = error["message"].as_str().unwrap_or("").to_owned();
    let detail = |fallback: &str| if message.is_empty() { fallback.to_owned() } else { message.clone() };

    if code == "insufficient_quota" || kind == "insufficient_quota" {
        return AppError::new(
            ErrorKind::PermissionDenied,
            "Your OpenAI account has no remaining quota. Check your plan and billing.",
        );
    }
    if code == "model_not_found" {
        return AppError::new(ErrorKind::NotFound, detail("The selected model isn't available to your account."));
    }
    match status {
        Some(401) => AppError::new(ErrorKind::Authentication, "The API key was rejected. Check it in Settings → AI model."),
        Some(403) => AppError::new(ErrorKind::PermissionDenied, detail("This API key isn't allowed to make this request.")),
        Some(404) => AppError::new(ErrorKind::NotFound, detail("The selected model isn't available to your account.")),
        Some(429) => AppError::new(ErrorKind::RateLimited, "Rate limit reached. Wait a moment and try again."),
        Some(503) => AppError::new(ErrorKind::Overloaded, "The AI service is overloaded right now. Try again shortly."),
        Some(500..=599) => AppError::new(ErrorKind::Server, "The AI service had an internal error. Try again."),
        Some(_) => AppError::invalid(detail("The request was invalid.")),
        // Error object delivered mid-stream (no HTTP status).
        None => AppError::new(ErrorKind::Server, detail("The AI service reported an error.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_http_errors() {
        let e = http_error(429, r#"{"error":{"message":"slow down","type":"requests","code":"rate_limit_exceeded"}}"#);
        assert_eq!(e.kind, ErrorKind::RateLimited);
        assert!(e.retryable);
        assert_eq!(e.status, Some(429));

        let e = http_error(429, r#"{"error":{"message":"quota","type":"insufficient_quota","code":"insufficient_quota"}}"#);
        assert_eq!(e.kind, ErrorKind::PermissionDenied);
        assert!(!e.retryable);

        let e = http_error(401, "");
        assert_eq!(e.kind, ErrorKind::Authentication);

        let e = http_error(404, r#"{"error":{"message":"no such model","code":"model_not_found"}}"#);
        assert_eq!(e.kind, ErrorKind::NotFound);

        let e = http_error(502, "<html>bad gateway</html>");
        assert_eq!(e.kind, ErrorKind::Server);
        assert!(e.retryable);
    }

    #[test]
    fn request_body_shape() {
        let body = CompletionBody {
            model: "m",
            messages: vec![
                WireMessage { role: "system", content: "s" },
                WireMessage { role: "user", content: "hi" },
            ],
            stream: true,
            stream_options: StreamOptions { include_usage: true },
        };
        let v: Value = serde_json::to_value(&body).unwrap();
        assert_eq!(v["stream"], true);
        assert_eq!(v["stream_options"]["include_usage"], true);
        assert_eq!(v["messages"][0]["role"], "system");
        assert_eq!(v["messages"][1]["content"], "hi");
    }
}
