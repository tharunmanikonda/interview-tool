// ===== ACCESSIBILITY PERMISSION COMMANDS =====

#[tauri::command]
#[specta::specta]
pub fn check_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_accessibility_client::accessibility::application_is_trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true // Other platforms don't need this permission
    }
}

#[tauri::command]
#[specta::specta]
pub fn request_accessibility_permission() {
    #[cfg(target_os = "macos")]
    {
        // This will show macOS system dialog and open System Settings
        macos_accessibility_client::accessibility::application_is_trusted_with_prompt();
    }
}
