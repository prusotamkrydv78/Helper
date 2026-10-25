mod ai;
mod browser;
mod commands;
mod config;
mod desktop;
mod error;
mod state;
mod tools;
mod workflows;

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
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let state = state::AppState::new(&config_dir);
            // Close the browser session after a period of inactivity.
            let browser = std::sync::Arc::clone(&state.browser);
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    browser.shutdown_if_idle().await;
                }
            });
            app.manage(state);
            Ok(())
        })
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
