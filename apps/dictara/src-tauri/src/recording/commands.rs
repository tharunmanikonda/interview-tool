use super::RecordingEvent;

/// Commands for controlling audio recording
/// These are sent through channels (NOT Tauri events) for zero-overhead internal communication
#[derive(Debug, Clone)]
pub enum RecordingCommand {
    /// Start a new recording session
    StartRecording,
    /// Stop the current recording and begin transcription
    StopRecording,
    /// Stop/transcribe the current rolling chunk, then immediately begin the next one
    StopAndRestartRecording,
    /// Stop/transcribe the current rolling chunk and mark it as the final chunk
    FinalizeRollingRecording,
    /// Lock the recording (Fn release will be ignored, press Fn again to stop)
    LockRecording,
    /// Cancel the current recording without transcribing
    Cancel,
    /// Retry transcription of the last failed recording
    RetryTranscription,
}

impl From<RecordingCommand> for RecordingEvent {
    fn from(command: RecordingCommand) -> Self {
        match command {
            RecordingCommand::StartRecording => RecordingEvent::Start,
            RecordingCommand::StopRecording => RecordingEvent::Stop,
            RecordingCommand::StopAndRestartRecording => RecordingEvent::RollingRestart,
            RecordingCommand::FinalizeRollingRecording => RecordingEvent::RollingFinalize,
            RecordingCommand::LockRecording => RecordingEvent::Lock,
            RecordingCommand::Cancel => RecordingEvent::Cancel,
            RecordingCommand::RetryTranscription => RecordingEvent::Retry,
        }
    }
}
