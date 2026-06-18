mod autolaunch;
mod clients;
mod commands;
mod config;
mod error;
mod globe_key;
mod keyboard_listener;
mod keychain;
mod log;
mod models;
mod recording;
mod setup;
mod shortcuts;
mod specta;
mod telemetry;
mod text_paster;
mod ui;
mod updater;

pub fn run() {
    tauri::Builder::default()
        .plugin(log::create_plugin().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(setup::setup_app)
        .invoke_handler(with_commands!(tauri::generate_handler))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
