use crate::config::{self, ConfigKey, ConfigStore, LocalModelConfig};
use crate::models::{ModelInfo, ModelLoader, ModelManager};
use std::sync::Arc;
use tauri::State;

// ===== LOCAL MODEL COMMANDS =====

/// Get list of all available models with their current status
#[tauri::command]
#[specta::specta]
pub fn get_available_models(
    model_manager: State<Arc<ModelManager>>,
    model_loader: State<Arc<ModelLoader>>,
) -> Vec<ModelInfo> {
    model_manager.get_all_models(&model_loader)
}

/// Start downloading a model
#[tauri::command]
#[specta::specta]
pub async fn download_model(
    model_manager: State<'_, Arc<ModelManager>>,
    app: tauri::AppHandle,
    model_name: String,
) -> Result<(), String> {
    model_manager.download_model(&model_name, app).await
}

/// Cancel an ongoing model download
#[tauri::command]
#[specta::specta]
pub fn cancel_model_download(
    model_manager: State<Arc<ModelManager>>,
    model_name: String,
) -> Result<(), String> {
    model_manager.cancel_download(&model_name)
}

/// Delete a downloaded model
#[tauri::command]
#[specta::specta]
pub fn delete_model(
    model_manager: State<Arc<ModelManager>>,
    model_loader: State<Arc<ModelLoader>>,
    model_name: String,
) -> Result<(), String> {
    model_manager.delete_model(&model_name, &model_loader)
}

/// Load a model into memory for transcription
#[tauri::command]
#[specta::specta]
pub async fn load_model(
    model_loader: State<'_, Arc<ModelLoader>>,
    app: tauri::AppHandle,
    model_name: String,
) -> Result<(), String> {
    model_loader.load_model(&model_name, &app).await
}

/// Unload the currently loaded model (frees memory)
#[tauri::command]
#[specta::specta]
pub fn unload_model(model_loader: State<Arc<ModelLoader>>) {
    model_loader.unload_model()
}

/// Get the name of the currently loaded model
#[tauri::command]
#[specta::specta]
pub fn get_loaded_model(model_loader: State<Arc<ModelLoader>>) -> Option<String> {
    model_loader.get_loaded_model_name()
}

/// Load local model configuration
#[tauri::command]
#[specta::specta]
pub fn load_local_model_config(
    config_store: State<config::Config>,
) -> Result<Option<LocalModelConfig>, String> {
    Ok(config_store.get(&ConfigKey::LOCAL_MODEL))
}

/// Save local model configuration (selected model)
#[tauri::command]
#[specta::specta]
pub fn save_local_model_config(
    config_store: State<config::Config>,
    model_name: String,
) -> Result<(), String> {
    let config = LocalModelConfig {
        selected_model: Some(model_name),
    };

    config_store.set(&ConfigKey::LOCAL_MODEL, config)
}

/// Delete local model configuration
#[tauri::command]
#[specta::specta]
pub fn delete_local_model_config(config_store: State<config::Config>) -> Result<(), String> {
    config_store.delete(&ConfigKey::LOCAL_MODEL)
}
