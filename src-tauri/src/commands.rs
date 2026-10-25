//! Tauri commands exposed to the frontend.

use tauri::ipc::Channel;
use tauri::State;

use crate::ai::types::{ChatRequest, StreamEvent};
use crate::config::{self, AiStatus};
use crate::error::{AppError, ErrorKind};
use crate::state::AppState;

/// Runs blocking credential-store work off the async runtime.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::internal(format!("background task failed: {e}")))?
}

/// Streams an assistant reply over `on_event`. Resolves when the stream ends.
/// Cancellation (via `chat_cancel`) resolves successfully without a `done` event.
#[tauri::command]
pub async fn chat_stream(
    state: State<'_, AppState>,
    request: ChatRequest,
    on_event: Channel<StreamEvent>,
) -> Result<(), AppError> {
    let token = state.register(&request.request_id);
    let result = async {
        let (key, _) = blocking(config::resolve).await?.ok_or_else(AppError::missing_api_key)?;
        state
            .ai
            .stream_chat(&key, &request, &token, |ev| {
                if let Err(e) = on_event.send(ev) {
                    log::warn!("failed to deliver stream event: {e}");
                }
            })
            .await
    }
    .await;
    state.unregister(&request.request_id);

    match result {
        Ok(summary) => {
            let _ = on_event.send(StreamEvent::Done {
                stop_reason: summary.stop_reason,
                output_tokens: summary.output_tokens,
            });
            Ok(())
        }
        Err(e) if e.kind == ErrorKind::Cancelled => {
            log::info!("chat request {} cancelled", request.request_id);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub fn chat_cancel(state: State<'_, AppState>, request_id: String) -> bool {
    state.cancel(&request_id)
}

#[tauri::command]
pub async fn ai_status() -> Result<AiStatus, AppError> {
    blocking(config::status).await
}

#[tauri::command]
pub async fn set_api_key(api_key: String) -> Result<AiStatus, AppError> {
    blocking(move || {
        config::store(&api_key)?;
        config::status()
    })
    .await
}

#[tauri::command]
pub async fn clear_api_key() -> Result<AiStatus, AppError> {
    blocking(|| {
        config::clear()?;
        config::status()
    })
    .await
}
