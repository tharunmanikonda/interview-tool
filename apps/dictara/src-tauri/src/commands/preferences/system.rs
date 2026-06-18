use crate::config::{self, AppConfig, ConfigKey, ConfigStore};
use log::error;
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

// ===== SYSTEM CONFIGURATION COMMANDS =====

/// Enable autostart on system boot
#[tauri::command]
#[specta::specta]
pub fn enable_autostart(app: AppHandle) -> Result<(), String> {
    let autostart_manager = app.autolaunch();
    autostart_manager.enable().map_err(|e| {
        error!("Failed to enable autostart: {}", e);
        format!("Failed to enable autostart: {}", e)
    })
}

/// Disable autostart on system boot
#[tauri::command]
#[specta::specta]
pub fn disable_autostart(app: AppHandle) -> Result<(), String> {
    let autostart_manager = app.autolaunch();
    autostart_manager.disable().map_err(|e| {
        error!("Failed to disable autostart: {}", e);
        format!("Failed to disable autostart: {}", e)
    })
}

/// Check if autostart is enabled
#[tauri::command]
#[specta::specta]
pub fn is_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    let autostart_manager = app.autolaunch();
    autostart_manager.is_enabled().map_err(|e| {
        error!("Failed to check autostart status: {}", e);
        format!("Failed to check autostart status: {}", e)
    })
}

/// Mark that initial autostart setup has been completed
/// This is called after enabling autostart on first launch
#[tauri::command]
#[specta::specta]
pub fn mark_autostart_setup_done(config_store: State<config::Config>) -> Result<(), String> {
    let mut config: AppConfig = config_store.get(&ConfigKey::APP).unwrap_or_default();
    config.autostart_initial_setup_done = true;
    config_store.set(&ConfigKey::APP, config)
}

/// Check if initial autostart setup has been completed
#[tauri::command]
#[specta::specta]
pub fn is_autostart_setup_done(config_store: State<config::Config>) -> Result<bool, String> {
    let config: AppConfig = config_store.get(&ConfigKey::APP).unwrap_or_default();
    Ok(config.autostart_initial_setup_done)
}
