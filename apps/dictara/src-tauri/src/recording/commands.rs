use super::RecordingEvent;

/// Commands for controlling audio recording
/// These are sent through channels (NOT Tauri events) for zero-overhead internal communication
#[derive(Debug, Clone)]
pub enum RecordingCommand {
    /// Start a new recording session
    StartRecording,
    /// Start a Live Assist recording session, using realtime mode when enabled
    StartLiveAssistRecording,
    /// Stop the current recording and begin transcription
    StopRecording,
    /// Stop/transcribe the current rolling chunk, then immediately begin the next one
    StopAndRestartRecording,
    /// Stop/transcribe the current rolling chunk and mark it as the final chunk
    FinalizeRollingRecording,
    /// In realtime Live Assist mode, emit the current transcript as a final question and keep listening
    FinalizeRealtimeBuffer,
    /// In realtime Live Assist mode, clear the current transcript/audio buffer and keep listening
    ClearRealtimeBuffer,
    /// In realtime Live Assist mode, ask the extension to request a starter for the current buffer
    RequestRealtimeStarter,
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
            RecordingCommand::StartLiveAssistRecording => RecordingEvent::Start,
            RecordingCommand::StopRecording => RecordingEvent::Stop,
            RecordingCommand::StopAndRestartRecording => RecordingEvent::RollingRestart,
            RecordingCommand::FinalizeRollingRecording => RecordingEvent::RollingFinalize,
            RecordingCommand::FinalizeRealtimeBuffer => RecordingEvent::RollingFinalize,
            RecordingCommand::ClearRealtimeBuffer => RecordingEvent::Cancel,
            RecordingCommand::RequestRealtimeStarter => RecordingEvent::Lock,
            RecordingCommand::LockRecording => RecordingEvent::Lock,
            RecordingCommand::Cancel => RecordingEvent::Cancel,
            RecordingCommand::RetryTranscription => RecordingEvent::Retry,
        }
    }
}
