//! Background operation: a system-tray icon (Show / Quit), optional
//! close-to-tray so schedules keep running, desktop notifications, and
//! launch-at-sign-in (started hidden in the tray).

use std::sync::atomic::Ordering;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, State, Window, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;

use crate::error::AppError;
use crate::state::AppState;

/// Passed by the autostart entry so the app starts hidden in the tray.
pub const MINIMIZED_ARG: &str = "--minimized";

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show AI Automation", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("AI Automation")
        .menu(&menu)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    if std::env::args().any(|a| a == MINIMIZED_ARG) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
    }
    Ok(())
}

/// With "keep running in the tray" on, closing the window hides it instead of quitting.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.state::<AppState>().keep_in_tray.load(Ordering::Relaxed) {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

#[tauri::command]
pub fn set_keep_in_tray(state: State<'_, AppState>, enabled: bool) {
    state.keep_in_tray.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) -> Result<(), AppError> {
    app.notification()
        .builder()
        .title(title.chars().take(100).collect::<String>())
        .body(body.chars().take(300).collect::<String>())
        .show()
        .map_err(|e| AppError::internal(format!("Notification failed: {e}")))
}

#[tauri::command]
pub fn autostart_get(app: AppHandle) -> Result<bool, AppError> {
    app.autolaunch().is_enabled().map_err(|e| AppError::internal(format!("Couldn't read the startup setting: {e}")))
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, AppError> {
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| AppError::internal(format!("Couldn't change the startup setting: {e}")))?;
    al.is_enabled().map_err(|e| AppError::internal(e.to_string()))
}
