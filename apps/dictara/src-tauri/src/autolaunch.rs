use crate::config::{self, AppConfig, ConfigKey, ConfigStore};
use log::{error, info, warn};
use tauri_plugin_autostart::ManagerExt;

/// Setup autolaunch on first launch if not already done
///
/// This function:
/// - Checks if autolaunch has been set up before
/// - If not, enables autolaunch and marks it as done
/// - Logs appropriate messages for success/failure
pub fn setup_autolaunch_if_needed(
    app: &tauri::AppHandle,
    config_store: &config::Config,
    app_config: &mut AppConfig,
) {
    // Skip if already set up
    if app_config.autostart_initial_setup_done {
        return;
    }

    info!("First launch detected - enabling autostart");
    let autostart_manager = app.autolaunch();

    if let Err(e) = autostart_manager.enable() {
        warn!("Failed to enable autostart on first launch: {}", e);
    } else {
        info!("Autostart enabled successfully");
        app_config.autostart_initial_setup_done = true;
        if let Err(e) = config_store.set(&ConfigKey::APP, app_config.clone()) {
            error!("Failed to save autostart setup flag: {}", e);
        }
    }
}
