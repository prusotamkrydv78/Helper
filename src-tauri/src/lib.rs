mod ai;
mod commands;
mod config;
mod error;
mod state;
mod tools;

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
            app.manage(state::AppState::new(&config_dir));
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
