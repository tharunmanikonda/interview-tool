use crate::config::{self, ConfigKey, ConfigStore, OnboardingConfig, OnboardingStep};
use crate::ui::window;
use log::error;
use tauri::State;

// ===== ONBOARDING FLOW COMMANDS =====

#[tauri::command]
#[specta::specta]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
#[specta::specta]
pub fn load_onboarding_config(
    config_store: State<config::Config>,
) -> Result<OnboardingConfig, String> {
    Ok(config_store.get(&ConfigKey::ONBOARDING).unwrap_or_default())
}

#[tauri::command]
#[specta::specta]
pub fn save_onboarding_step(
    config_store: State<config::Config>,
    step: OnboardingStep,
) -> Result<(), String> {
    let mut onboarding_config = config_store.get(&ConfigKey::ONBOARDING).unwrap_or_default();
    onboarding_config.current_step = step;
    config_store.set(&ConfigKey::ONBOARDING, onboarding_config)
}

#[tauri::command]
#[specta::specta]
pub fn finish_onboarding(
    app: tauri::AppHandle,
    config_store: State<config::Config>,
) -> Result<(), String> {
    let mut onboarding_config = config_store.get(&ConfigKey::ONBOARDING).unwrap_or_default();
    onboarding_config.finished = true;
    onboarding_config.current_step = OnboardingStep::Complete;
    onboarding_config.pending_restart = false;
    config_store.set(&ConfigKey::ONBOARDING, onboarding_config)?;

    // Close the onboarding window
    window::close_onboarding_window(&app).map_err(|e| {
        error!("Failed to close onboarding window: {}", e);
        format!("Failed to close onboarding window: {}", e)
    })
}

#[tauri::command]
#[specta::specta]
pub fn skip_onboarding(
    app: tauri::AppHandle,
    config_store: State<config::Config>,
) -> Result<(), String> {
    let mut onboarding_config = config_store.get(&ConfigKey::ONBOARDING).unwrap_or_default();
    onboarding_config.finished = true;
    config_store.set(&ConfigKey::ONBOARDING, onboarding_config)?;

    // Close the onboarding window
    window::close_onboarding_window(&app).map_err(|e| {
        error!("Failed to close onboarding window: {}", e);
        format!("Failed to close onboarding window: {}", e)
    })
}

#[tauri::command]
#[specta::specta]
pub fn set_pending_restart(
    config_store: State<config::Config>,
    pending: bool,
) -> Result<(), String> {
    let mut onboarding_config = config_store.get(&ConfigKey::ONBOARDING).unwrap_or_default();
    onboarding_config.pending_restart = pending;
    config_store.set(&ConfigKey::ONBOARDING, onboarding_config)
}

#[tauri::command]
#[specta::specta]
pub fn restart_onboarding(
    app: tauri::AppHandle,
    config_store: State<config::Config>,
) -> Result<(), String> {
    // Reset onboarding config to initial state
    let onboarding_config = config::OnboardingConfig::default();
    config_store.set(&ConfigKey::ONBOARDING, onboarding_config)?;

    // Open the onboarding window
    crate::ui::window::open_onboarding_window(&app).map_err(|e| {
        error!("Failed to open onboarding window: {}", e);
        format!("Failed to open onboarding window: {}", e)
    })
}
