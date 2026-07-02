use crate::recording::{LastRecordingState, RecordingCommand};
use crate::setup::{AudioLevelChannel, RecordingCommandSender};
use tauri::ipc::Channel;
use tauri::State;

// ===== RECORDING CONTROL COMMANDS =====

#[tauri::command]
#[specta::specta]
pub fn stop_recording(sender: State<RecordingCommandSender>) -> Result<(), String> {
    sender
        .sender
        .blocking_send(RecordingCommand::StopRecording)
        .map_err(|e| format!("Failed to send StopRecording command: {}", e))?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn cancel_recording(sender: State<RecordingCommandSender>) -> Result<(), String> {
    sender
        .sender
        .blocking_send(RecordingCommand::Cancel)
        .map_err(|e| format!("Failed to send Cancel command: {}", e))?;

    Ok(())
}

// ===== AUDIO MONITORING =====

#[tauri::command]
#[specta::specta]
pub fn register_audio_level_channel(
    channel: Channel<f32>,
    state: State<AudioLevelChannel>,
) -> Result<(), String> {
    let mut channel_lock = state.channel.lock().unwrap();
    *channel_lock = Some(channel);
    Ok(())
}

// ===== ERROR HANDLING =====

#[tauri::command]
#[specta::specta]
pub fn retry_transcription(sender: State<RecordingCommandSender>) -> Result<(), String> {
    sender
        .sender
        .blocking_send(RecordingCommand::RetryTranscription)
        .map_err(|e| format!("Failed to send RetryTranscription command: {}", e))?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn dismiss_error(
    app: tauri::AppHandle,
    last_recording_state: State<LastRecordingState>,
) -> Result<(), String> {
    // Delete audio file if exists
    if let Ok(mut last_recording) = last_recording_state.lock() {
        if let Some(path) = last_recording.audio_file_path.take() {
            crate::recording::cleanup_recording_file(&path);
        }
        last_recording.audio_file_path = None;
    }

    // Close popup
    crate::ui::window::close_recording_popup(&app)
        .map_err(|e| format!("Failed to close popup: {}", e))
}

#[tauri::command]
#[specta::specta]
pub fn resize_popup_for_error(app: tauri::AppHandle) -> Result<(), String> {
    crate::ui::window::resize_recording_popup_for_error(&app)
        .map_err(|e| format!("Failed to resize popup: {}", e))
}
