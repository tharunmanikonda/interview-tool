/// Creates and configures the logging plugin for the application
///
/// Logs are sent to:
/// - Stdout (console output)
/// - Log directory (persistent file storage)
/// - Webview (browser console)
///
/// Log level is Debug in development builds and Info in production builds
pub fn create_plugin() -> tauri_plugin_log::Builder {
    tauri_plugin_log::Builder::new()
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
        ])
        .level(log::LevelFilter::Info)
}
