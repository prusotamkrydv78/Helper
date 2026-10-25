//! Push-to-talk speech-to-text with the Windows speech recognizer
//! (Windows.Media.SpeechRecognition, dictation). One utterance per call; the
//! audio is processed by Windows and never stored by this app. Text-to-speech
//! happens in the UI with the system voices (Web Speech synthesis in WebView2).

use std::sync::Mutex;

use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

/// Cancels the recognition in progress, if any.
#[derive(Default)]
pub struct VoiceState {
    cancel: Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
}

#[tauri::command]
pub async fn voice_listen(state: State<'_, AppState>) -> Result<String, AppError> {
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    *state.voice.cancel.lock().unwrap_or_else(|e| e.into_inner()) = Some(flag.clone());
    let r = tauri::async_runtime::spawn_blocking(move || imp::listen(&flag))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?;
    state.voice.cancel.lock().unwrap_or_else(|e| e.into_inner()).take();
    r
}

/// Hands-free: listens repeatedly until an utterance starts with (or contains) `phrase`, then
/// returns what was said after it (possibly empty). Cancel with voice_cancel / mute.
#[tauri::command]
pub async fn voice_wait_for_phrase(state: State<'_, AppState>, phrase: String) -> Result<String, AppError> {
    let phrase = phrase.trim().to_lowercase();
    if phrase.chars().count() < 3 {
        return Err(AppError::invalid("The wake phrase needs at least 3 characters."));
    }
    loop {
        let heard = match voice_listen(state.clone()).await {
            Ok(t) => t,
            // Silence is normal while waiting; keep listening.
            Err(e) if e.message.contains("Didn't hear") || e.message.contains("wasn't recognized") => continue,
            Err(e) => return Err(e),
        };
        let lower = heard.to_lowercase();
        if let Some(pos) = lower.find(&phrase) {
            // Lower-casing can change byte lengths; fall back to the whole utterance if the slice isn't valid.
            let rest = heard.get(pos + phrase.len()..).unwrap_or("");
            return Ok(rest.trim_start_matches([',', '.', '!', ' ']).trim().to_owned());
        }
    }
}

#[tauri::command]
pub fn voice_cancel(state: State<'_, AppState>) {
    if let Some(f) = state.voice.cancel.lock().unwrap_or_else(|e| e.into_inner()).take() {
        f.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn listen(_: &std::sync::atomic::AtomicBool) -> Result<String, AppError> {
        Err(AppError::invalid("Voice input is only available on Windows."))
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use windows::Foundation::AsyncStatus;
    use windows::Media::SpeechRecognition::{SpeechRecognitionResultStatus, SpeechRecognizer};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    use crate::error::AppError;

    /// Windows reports this when online speech recognition is turned off in privacy settings.
    const PRIVACY_DECLINED: i32 = 0x8004_5509_u32 as i32;

    fn map(e: windows::core::Error) -> AppError {
        if e.code().0 == PRIVACY_DECLINED {
            AppError::invalid(
                "Windows speech recognition is off. Turn on Settings → Privacy & security → Speech → Online speech recognition, then try again.",
            )
        } else {
            AppError::internal(format!("Speech recognition failed: {}", e.message()))
        }
    }

    pub fn listen(cancel: &AtomicBool) -> Result<String, AppError> {
        let inited = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        let result = (|| -> Result<String, AppError> {
            let rec = SpeechRecognizer::new().map_err(map)?;
            // Voice activity detection: stop after ~1.2 s of silence; give up if nothing is said for 8 s.
            if let Ok(t) = rec.Timeouts() {
                let _ = t.SetEndSilenceTimeout(windows::Foundation::TimeSpan { Duration: 12_000_000 });
                let _ = t.SetInitialSilenceTimeout(windows::Foundation::TimeSpan { Duration: 80_000_000 });
            }
            let compiled = rec.CompileConstraintsAsync().map_err(map)?.get().map_err(map)?;
            if compiled.Status().map_err(map)? != SpeechRecognitionResultStatus::Success {
                return Err(AppError::invalid("Windows couldn't prepare speech recognition (no speech language installed?)."));
            }
            let op = rec.RecognizeAsync().map_err(map)?;
            // Poll so Stop / releasing the key can cancel.
            loop {
                match op.Status().map_err(map)? {
                    AsyncStatus::Started => {
                        if cancel.load(Ordering::Relaxed) {
                            let _ = op.Cancel();
                            return Err(AppError::cancelled());
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    _ => break,
                }
            }
            let res = op.GetResults().map_err(map)?;
            match res.Status().map_err(map)? {
                SpeechRecognitionResultStatus::Success => Ok(res.Text().map_err(map)?.to_string()),
                SpeechRecognitionResultStatus::MicrophoneUnavailable => Err(AppError::invalid("No microphone is available (or microphone access is off in Windows privacy settings).")),
                SpeechRecognitionResultStatus::TimeoutExceeded => Err(AppError::invalid("Didn't hear anything. Try again.")),
                s => Err(AppError::invalid(format!("Speech wasn't recognized ({s:?})."))),
            }
        })();
        if inited {
            unsafe { CoUninitialize() };
        }
        result
    }
}
