/// Get the application version with -local suffix when running in debug mode
#[tauri::command]
#[specta::specta]
pub fn get_app_version() -> String {
    let version = env!("CARGO_PKG_VERSION");

    if cfg!(debug_assertions) {
        format!("{}-local", version)
    } else {
        version.to_string()
    }
}
