//! Typesafe events for the recording module.
//!
//! These events are emitted from Rust and can be listened to in TypeScript
//! with full type safety via tauri-specta.

use serde::{Deserialize, Serialize};

/// Recording state change event - single event stream for all state transitions
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum RecordingStateChanged {
    /// Recording has started
    #[serde(rename = "started")]
    Started,
    /// Recording is being transcribed
    #[serde(rename = "transcribing")]
    Transcribing,
    /// Recording completed successfully
    #[serde(rename = "stopped")]
    Stopped {
        /// The transcribed text
        text: String,
    },
    /// Recording was cancelled by user
    #[serde(rename = "cancelled")]
    Cancelled,
    /// An error occurred during recording or transcription
    #[serde(rename = "error")]
    Error {
        /// Type of error: "recording" | "transcription"
        #[serde(rename = "errorType")]
        error_type: String,
        /// Technical error message for debugging
        #[serde(rename = "errorMessage")]
        error_message: String,
        /// User-friendly error message
        #[serde(rename = "userMessage")]
        user_message: String,
        /// Path to audio file (for retry functionality)
        #[serde(rename = "audioFilePath")]
        audio_file_path: Option<String>,
    },
}
