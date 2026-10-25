mod ai;
mod audit;
mod background;
mod clipboard;
mod memory;
mod system;
mod browser;
mod commands;
mod config;
mod diagnostics;
mod desktop;
mod error;
mod google;
mod graph;
mod library;
mod state;
mod tools;
mod voice;
mod workflows;

use std::sync::Arc;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    config::load_dotenv();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(background::shortcut_plugin())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![background::MINIMIZED_ARG]),
        ))
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            tools::fs_ops::set_journal_dir(&config_dir);
            desktop::set_layout_dir(&config_dir);
            workflows::set_skills_dir(&config_dir);
            let state = state::AppState::new(&config_dir);
            // Close the browser session after a period of inactivity.
            let browser = std::sync::Arc::clone(&state.browser);
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    browser.shutdown_if_idle().await;
                }
            });
            Arc::clone(&state.clipboard).watch();
            state.library.start(&config_dir, app.handle().clone());
            app.manage(state);
            background::setup(app)?;
            Ok(())
        })
        .on_window_event(background::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::chat_stream,
            commands::chat_cancel,
            commands::ai_status,
            commands::set_api_key,
            commands::clear_api_key,
            commands::resolve_tool_approval,
            commands::list_allowed_dirs,
            commands::add_allowed_dir,
            commands::remove_allowed_dir,
            workflows::workflows_load,
            workflows::workflows_save,
            workflows::schedules_load,
            workflows::schedules_save,
            workflows::workflow_plan,
            workflows::rules_load,
            workflows::triggers_load,
            workflows::triggers_save,
            workflows::layouts_load,
            workflows::layouts_save,
            workflows::layout_capture,
            workflows::layout_preview,
            workflows::layout_apply,
            workflows::documents_search,
            system::trigger_state,
            memory::memory_update,
            workflows::rules_save,
            workflows::organize_rule_preview,
            workflows::organize_rule_apply,
            workflows::file_undo_list,
            workflows::file_undo_preview,
            workflows::file_undo_apply,
            memory::memory_list,
            memory::memory_add,
            memory::memory_delete,
            memory::memory_clear,
            audit::audit_recent,
            audit::audit_clear,
            background::notify,
            background::shortcuts_set,
            voice::voice_listen,
            voice::voice_cancel,
            voice::voice_wait_for_phrase,
            library::library_status,
            library::library_set_folders,
            library::library_query,
            workflows::skills_load,
            workflows::skills_save,
            workflows::stop_all,
            workflows::browser_set_persistent,
            desktop::screen_analyze,
            desktop::screen_windows,
            diagnostics::diagnostics,
            diagnostics::diagnose_browser,
            diagnostics::briefing_calendar,
            clipboard::clipboard_history_get,
            clipboard::clipboard_history_set_enabled,
            clipboard::clipboard_history_pin,
            clipboard::clipboard_history_delete,
            clipboard::clipboard_history_clear,
            clipboard::clipboard_history_restore,
            background::set_keep_in_tray,
            background::autostart_get,
            background::autostart_set,
            graph::graph_status,
            graph::graph_set_config,
            graph::graph_connect,
            graph::graph_cancel_connect,
            graph::graph_disconnect,
            google::google_status,
            google::google_set_config,
            google::google_connect,
            google::google_cancel_connect,
            google::google_disconnect,
            system::system_status_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
