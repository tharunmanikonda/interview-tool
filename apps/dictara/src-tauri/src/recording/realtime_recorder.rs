use base64::{engine::general_purpose, Engine as _};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample};
use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use rubato::{FftFixedInOut, Resampler};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message;

use crate::config::OpenAIConfig;
use crate::keychain::{self, ProviderAccount};
use crate::live_assist_bridge;

const REALTIME_TRANSCRIPTION_MODEL: &str = "gpt-realtime-whisper";
const REALTIME_URL: &str = "wss://api.openai.com/v1/realtime?intent=transcription";
const REALTIME_SAMPLE_RATE: u32 = 24_000;
const FINAL_TRANSCRIPT_TIMEOUT_MS: u64 = 1_500;
const REALTIME_COMMIT_INTERVAL_MS: u64 = 900;
const REALTIME_FLUSH_WAIT_MS: u64 = 1_100;
const REALTIME_MIN_COMMIT_MS: u64 = 120;
const REALTIME_SESSION_ROTATE_SECS: u64 = 10 * 60;
const REALTIME_HEALTH_CHECK_MS: u64 = 5_000;
const REALTIME_SOCKET_IDLE_TIMEOUT_SECS: u64 = 45;

enum RealtimeControl {
    Finalize,
    FlushAndClear {
        response_tx: oneshot::Sender<String>,
    },
    ClearBuffer,
    Cancel,
}

enum RealtimeSessionEnd {
    Finalized(String),
    Cleared,
    Cancelled,
}

#[derive(Debug, thiserror::Error)]
pub enum RealtimeRecorderError {
    #[error("OpenAI API key missing")]
    ApiKeyMissing,
    #[error("No input device")]
    NoInputDevice,
    #[error("Device error")]
    DeviceError,
    #[error("Realtime connection failed: {0}")]
    Connection(String),
    #[error("Realtime stream failed: {0}")]
    Stream(String),
}

impl RealtimeRecorderError {
    pub fn user_message(&self) -> String {
        match self {
            Self::ApiKeyMissing => {
                "OpenAI API key missing. Falling back to normal transcription.".to_string()
            }
            Self::NoInputDevice | Self::DeviceError => {
                "No microphone found. Please connect one and try again.".to_string()
            }
            Self::Connection(_) => {
                "Realtime transcription could not connect. Falling back to normal transcription."
                    .to_string()
            }
            Self::Stream(_) => "Realtime transcription failed during capture.".to_string(),
        }
    }
}

pub struct RealtimeRecording {
    stream: cpal::Stream,
    control_tx: mpsc::UnboundedSender<RealtimeControl>,
    final_rx: Option<oneshot::Receiver<Result<String, RealtimeRecorderError>>>,
    latest_transcript: Arc<Mutex<String>>,
    started_at: Instant,
}

impl RealtimeRecording {
    pub fn start(level_channel: Option<Channel<f32>>) -> Result<Self, RealtimeRecorderError> {
        let config: OpenAIConfig = keychain::load_provider_config(ProviderAccount::OpenAI)
            .map_err(|_| RealtimeRecorderError::ApiKeyMissing)?
            .ok_or(RealtimeRecorderError::ApiKeyMissing)?;

        let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<i16>>();
        let (control_tx, control_rx) = mpsc::unbounded_channel::<RealtimeControl>();
        let (final_tx, final_rx) = oneshot::channel::<Result<String, RealtimeRecorderError>>();
        let latest_transcript = Arc::new(Mutex::new(String::new()));
        let task_transcript = latest_transcript.clone();

        tauri::async_runtime::spawn(async move {
            let result = run_supervised_realtime_session(
                config.api_key,
                audio_rx,
                control_rx,
                task_transcript,
            )
            .await;
            if let Err(error) = &result {
                live_assist_bridge::transcription_error(&error.user_message());
                live_assist_bridge::capture_stopped();
            }
            let _ = final_tx.send(result);
        });

        let stream = build_realtime_input_stream(audio_tx, level_channel)?;
        stream
            .play()
            .map_err(|error| RealtimeRecorderError::Stream(error.to_string()))?;

        info!("Live Assist realtime transcription started");

        Ok(Self {
            stream,
            control_tx,
            final_rx: Some(final_rx),
            latest_transcript,
            started_at: Instant::now(),
        })
    }

    pub fn stop(mut self) -> Result<String, RealtimeRecorderError> {
        self.stream.pause().ok();

        let _ = self.control_tx.send(RealtimeControl::Finalize);
        let elapsed_ms = self.started_at.elapsed().as_millis();
        info!(
            "Live Assist realtime recording stopped after {}ms",
            elapsed_ms
        );

        let Some(final_rx) = self.final_rx.take() else {
            return Ok(self.latest_text());
        };

        match tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_millis(FINAL_TRANSCRIPT_TIMEOUT_MS), final_rx).await
        }) {
            Ok(Ok(Ok(text))) => Ok(text),
            Ok(Ok(Err(error))) => {
                let latest = self.latest_text();
                if latest.trim().is_empty() {
                    Err(error)
                } else {
                    warn!(
                        "Using latest realtime transcript after final error: {}",
                        error
                    );
                    Ok(latest)
                }
            }
            Ok(Err(_)) | Err(_) => {
                let _ = self.control_tx.send(RealtimeControl::Cancel);
                let latest = self.latest_text();
                if latest.trim().is_empty() {
                    Err(RealtimeRecorderError::Stream(
                        "Timed out waiting for final transcript".to_string(),
                    ))
                } else {
                    warn!("Using latest realtime transcript after final timeout");
                    Ok(latest)
                }
            }
        }
    }

    pub fn cancel(self) {
        self.stream.pause().ok();
        let _ = self.control_tx.send(RealtimeControl::Cancel);
    }

    pub fn snapshot_and_clear(&self) -> String {
        let (response_tx, response_rx) = oneshot::channel();
        if self
            .control_tx
            .send(RealtimeControl::FlushAndClear { response_tx })
            .is_err()
        {
            return self.latest_text();
        }

        match tauri::async_runtime::block_on(async {
            tokio::time::timeout(
                Duration::from_millis(FINAL_TRANSCRIPT_TIMEOUT_MS),
                response_rx,
            )
            .await
        }) {
            Ok(Ok(text)) => text,
            Ok(Err(_)) | Err(_) => {
                warn!("Using latest realtime transcript after flush timeout");
                self.latest_text()
            }
        }
    }

    pub fn clear_buffer(&self) {
        update_latest_transcript(&self.latest_transcript, "");
        let _ = self.control_tx.send(RealtimeControl::ClearBuffer);
    }

    fn latest_text(&self) -> String {
        self.latest_transcript
            .lock()
            .map(|text| text.clone())
            .unwrap_or_default()
    }
}

async fn connect_realtime_socket(
    api_key: &str,
) -> Result<
    (
        futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
        futures_util::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        >,
    ),
    RealtimeRecorderError,
> {
    let mut request = REALTIME_URL
        .into_client_request()
        .map_err(|error| RealtimeRecorderError::Connection(error.to_string()))?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key))
            .map_err(|error| RealtimeRecorderError::Connection(error.to_string()))?,
    );
    let (socket, _) = connect_async(request)
        .await
        .map_err(|error| RealtimeRecorderError::Connection(error.to_string()))?;
    Ok(socket.split())
}

async fn run_supervised_realtime_session(
    api_key: String,
    mut audio_rx: mpsc::UnboundedReceiver<Vec<i16>>,
    mut control_rx: mpsc::UnboundedReceiver<RealtimeControl>,
    latest_transcript: Arc<Mutex<String>>,
) -> Result<String, RealtimeRecorderError> {
    let mut transcript = RealtimeTranscriptState::default();
    let mut ignored_item_ids_after_flush = HashSet::new();
    let mut reconnect_attempt = 0u32;

    loop {
        match connect_realtime_socket(&api_key).await {
            Ok((writer, reader)) => {
                if reconnect_attempt > 0 {
                    live_assist_bridge::realtime_reconnected();
                }
                reconnect_attempt = 0;
                let session_started_at = Instant::now();
                match run_realtime_session(
                    writer,
                    reader,
                    &mut audio_rx,
                    &mut control_rx,
                    &latest_transcript,
                    &mut transcript,
                    &mut ignored_item_ids_after_flush,
                    session_started_at,
                )
                .await
                {
                    Ok(RealtimeSessionEnd::Finalized(text)) => return Ok(text),
                    Ok(RealtimeSessionEnd::Cleared) => {
                        transcript.clear();
                        ignored_item_ids_after_flush.clear();
                        update_latest_transcript(&latest_transcript, "");
                        live_assist_bridge::realtime_reconnecting(
                            "Realtime buffer cleared. Starting a fresh transcription session.",
                        );
                    }
                    Ok(RealtimeSessionEnd::Cancelled) => return Ok(String::new()),
                    Err(error) => {
                        reconnect_attempt = reconnect_attempt.saturating_add(1);
                        let backoff_ms = reconnect_backoff_ms(reconnect_attempt);
                        warn!(
                            "Live Assist realtime session failed; reconnecting in {}ms: {}",
                            backoff_ms, error
                        );
                        if reconnect_attempt >= 4 {
                            live_assist_bridge::realtime_failed(&format!(
                                "Realtime transcription is unstable; still retrying: {}",
                                error
                            ));
                        }
                        live_assist_bridge::realtime_reconnecting(&format!(
                            "Realtime reconnecting after socket error: {}",
                            error
                        ));
                        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                    }
                }
            }
            Err(error) => {
                reconnect_attempt = reconnect_attempt.saturating_add(1);
                let backoff_ms = reconnect_backoff_ms(reconnect_attempt);
                warn!(
                    "Live Assist realtime connection failed; reconnecting in {}ms: {}",
                    backoff_ms, error
                );
                if reconnect_attempt >= 4 {
                    live_assist_bridge::realtime_failed(&format!(
                        "Realtime connection is unstable; still retrying: {}",
                        error
                    ));
                }
                live_assist_bridge::realtime_reconnecting(&format!(
                    "Realtime reconnecting after connection error: {}",
                    error
                ));
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            }
        }
    }
}

fn reconnect_backoff_ms(attempt: u32) -> u64 {
    match attempt {
        0 | 1 => 500,
        2 => 1_000,
        3 => 2_000,
        _ => 5_000,
    }
}

async fn run_realtime_session(
    mut writer: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    mut reader: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    audio_rx: &mut mpsc::UnboundedReceiver<Vec<i16>>,
    control_rx: &mut mpsc::UnboundedReceiver<RealtimeControl>,
    latest_transcript: &Arc<Mutex<String>>,
    transcript: &mut RealtimeTranscriptState,
    ignored_item_ids_after_flush: &mut HashSet<String>,
    session_started_at: Instant,
) -> Result<RealtimeSessionEnd, RealtimeRecorderError> {
    send_json(
        &mut writer,
        json!({
            "type": "session.update",
            "session": {
                "type": "transcription",
                "audio": {
                    "input": {
                        "format": {
                            "type": "audio/pcm",
                            "rate": REALTIME_SAMPLE_RATE
                        },
                        "transcription": {
                            "model": REALTIME_TRANSCRIPTION_MODEL,
                            "language": "en"
                        }
                    }
                }
            }
        }),
    )
    .await?;
    info!("Live Assist realtime transcription session configured");

    let mut has_uncommitted_audio = false;
    let mut pending_sample_count: usize = 0;
    let mut pending_flush: Option<oneshot::Sender<String>> = None;
    let mut flush_due_at: Option<Instant> = None;
    let mut last_audio_append_at: Option<Instant> = None;
    let mut last_commit_at: Option<Instant> = None;
    let mut last_transcript_event_at: Option<Instant> = None;
    let mut last_socket_event_at = Instant::now();
    let mut commit_interval =
        tokio::time::interval(Duration::from_millis(REALTIME_COMMIT_INTERVAL_MS));
    commit_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut flush_check_interval = tokio::time::interval(Duration::from_millis(50));
    flush_check_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut health_check_interval =
        tokio::time::interval(Duration::from_millis(REALTIME_HEALTH_CHECK_MS));
    health_check_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            Some(samples) = audio_rx.recv() => {
                let audio = pcm16_to_base64(&samples);
                send_json(&mut writer, json!({
                    "type": "input_audio_buffer.append",
                    "audio": audio
                })).await?;
                has_uncommitted_audio = true;
                pending_sample_count += samples.len();
                last_audio_append_at = Some(Instant::now());

                if pending_flush.is_some() && can_commit_audio(pending_sample_count) {
                    send_json(&mut writer, json!({ "type": "input_audio_buffer.commit" })).await?;
                    info!(
                        "Live Assist realtime committed {}ms of audio for pending flush",
                        pending_audio_ms(pending_sample_count)
                    );
                    has_uncommitted_audio = false;
                    pending_sample_count = 0;
                    last_commit_at = Some(Instant::now());
                }
            }
            _ = commit_interval.tick(), if has_uncommitted_audio && can_commit_audio(pending_sample_count) => {
                send_json(&mut writer, json!({ "type": "input_audio_buffer.commit" })).await?;
                info!(
                    "Live Assist realtime committed {}ms of audio",
                    pending_audio_ms(pending_sample_count)
                );
                has_uncommitted_audio = false;
                pending_sample_count = 0;
                last_commit_at = Some(Instant::now());
            }
            Some(control) = control_rx.recv() => {
                match control {
                    RealtimeControl::Finalize => {
                        if has_uncommitted_audio && can_commit_audio(pending_sample_count) {
                            send_json(&mut writer, json!({ "type": "input_audio_buffer.commit" })).await?;
                            info!(
                                "Live Assist realtime committed {}ms of audio for finalize",
                                pending_audio_ms(pending_sample_count)
                            );
                        } else if has_uncommitted_audio {
                            warn!(
                                "Skipping realtime finalize commit because only {}ms of audio is buffered",
                                pending_audio_ms(pending_sample_count)
                            );
                        }
                        return Ok(RealtimeSessionEnd::Finalized(transcript.text()));
                    }
                    RealtimeControl::FlushAndClear { response_tx } => {
                        if has_uncommitted_audio && can_commit_audio(pending_sample_count) {
                            send_json(&mut writer, json!({ "type": "input_audio_buffer.commit" })).await?;
                            info!(
                                "Live Assist realtime committed {}ms of audio for buffer flush",
                                pending_audio_ms(pending_sample_count)
                            );
                            has_uncommitted_audio = false;
                            pending_sample_count = 0;
                            last_commit_at = Some(Instant::now());
                        } else if has_uncommitted_audio {
                            info!(
                                "Deferring realtime buffer flush until at least {}ms of audio is buffered; currently {}ms",
                                REALTIME_MIN_COMMIT_MS,
                                pending_audio_ms(pending_sample_count)
                            );
                        }
                        if let Some(previous_tx) = pending_flush.take() {
                            let _ = previous_tx.send(transcript.text());
                        }
                        pending_flush = Some(response_tx);
                        flush_due_at =
                            Some(Instant::now() + Duration::from_millis(REALTIME_FLUSH_WAIT_MS));
                    }
                    RealtimeControl::ClearBuffer => {
                        if has_uncommitted_audio {
                            send_json(&mut writer, json!({ "type": "input_audio_buffer.clear" })).await?;
                        }
                        if let Some(previous_tx) = pending_flush.take() {
                            let _ = previous_tx.send(String::new());
                        }
                        ignored_item_ids_after_flush.extend(transcript.item_ids());
                        transcript.clear();
                        update_latest_transcript(latest_transcript, "");
                        let _ = writer.send(Message::Close(None)).await;
                        return Ok(RealtimeSessionEnd::Cleared);
                    }
                    RealtimeControl::Cancel => {
                        let _ = writer.send(Message::Close(None)).await;
                        return Ok(RealtimeSessionEnd::Cancelled);
                    }
                }
            }
            _ = flush_check_interval.tick(), if pending_flush.is_some() => {
                if flush_due_at.is_some_and(|due_at| Instant::now() >= due_at) {
                    let text = transcript.text();
                    if let Some(response_tx) = pending_flush.take() {
                        let _ = response_tx.send(text);
                    }
                    ignored_item_ids_after_flush.extend(transcript.item_ids());
                    transcript.clear();
                    update_latest_transcript(latest_transcript, "");
                    flush_due_at = None;
                }
            }
            _ = health_check_interval.tick() => {
                if last_socket_event_at.elapsed() > Duration::from_secs(REALTIME_SOCKET_IDLE_TIMEOUT_SECS)
                    && (last_audio_append_at.is_some() || last_commit_at.is_some())
                {
                    return Err(RealtimeRecorderError::Stream(format!(
                        "Realtime socket idle for {}s while capture is active",
                        last_socket_event_at.elapsed().as_secs()
                    )));
                }
            }
            message = reader.next() => {
                let Some(message) = message else {
                    return Err(RealtimeRecorderError::Stream("Realtime socket closed".to_string()));
                };
                let message = message.map_err(|error| RealtimeRecorderError::Stream(error.to_string()))?;
                last_socket_event_at = Instant::now();
                if let Message::Text(payload) = message {
                    if handle_realtime_message(
                        &payload,
                        transcript,
                        latest_transcript,
                        ignored_item_ids_after_flush,
                    )? {
                        last_transcript_event_at = Some(Instant::now());
                    }
                }
            }
        }

        if session_started_at.elapsed() > Duration::from_secs(REALTIME_SESSION_ROTATE_SECS) {
            info!(
                "Live Assist realtime rotating session after {:?}; last_audio={:?} last_commit={:?} last_transcript={:?} last_socket={:?}",
                session_started_at.elapsed(),
                last_audio_append_at.map(|time| time.elapsed()),
                last_commit_at.map(|time| time.elapsed()),
                last_transcript_event_at.map(|time| time.elapsed()),
                last_socket_event_at.elapsed()
            );
            return Err(RealtimeRecorderError::Stream(
                "Realtime session rotation requested".to_string(),
            ));
        }
    }
}

fn can_commit_audio(sample_count: usize) -> bool {
    pending_audio_ms(sample_count) >= REALTIME_MIN_COMMIT_MS
}

fn pending_audio_ms(sample_count: usize) -> u64 {
    (sample_count as u64 * 1000) / REALTIME_SAMPLE_RATE as u64
}

#[derive(Default)]
struct RealtimeTranscriptState {
    item_order: Vec<String>,
    item_text: HashMap<String, String>,
}

impl RealtimeTranscriptState {
    fn append_delta(&mut self, item_id: String, delta: &str) {
        self.ensure_item(&item_id);
        self.item_text.entry(item_id).or_default().push_str(delta);
    }

    fn complete_item(&mut self, item_id: String, text: &str) {
        self.ensure_item(&item_id);
        self.item_text.insert(item_id, text.trim().to_string());
    }

    fn text(&self) -> String {
        self.item_order
            .iter()
            .filter_map(|item_id| self.item_text.get(item_id))
            .map(|text| text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn clear(&mut self) {
        self.item_order.clear();
        self.item_text.clear();
    }

    fn item_ids(&self) -> Vec<String> {
        self.item_order.clone()
    }

    fn ensure_item(&mut self, item_id: &str) {
        if !self.item_text.contains_key(item_id) {
            self.item_order.push(item_id.to_string());
            self.item_text.insert(item_id.to_string(), String::new());
        }
    }
}

fn handle_realtime_message(
    payload: &str,
    transcript: &mut RealtimeTranscriptState,
    latest_transcript: &Arc<Mutex<String>>,
    ignored_item_ids_after_flush: &mut HashSet<String>,
) -> Result<bool, RealtimeRecorderError> {
    let value: serde_json::Value = serde_json::from_str(payload)
        .map_err(|error| RealtimeRecorderError::Stream(error.to_string()))?;
    let event_type = value["type"].as_str().unwrap_or_default();
    if event_type != "input_audio_buffer.committed"
        && event_type != "input_audio_buffer.cleared"
        && event_type != "input_audio_buffer.appended"
    {
        info!("Live Assist realtime event: {}", event_type);
    }

    if event_type == "error" {
        let message = value["error"]["message"]
            .as_str()
            .unwrap_or("OpenAI realtime transcription failed");
        let code = value["error"]["code"].as_str().unwrap_or("unknown_code");
        let param = value["error"]["param"].as_str().unwrap_or("unknown_param");
        error!(
            "Live Assist realtime error from OpenAI: code={} param={} message={}",
            code, param, message
        );
        return Err(RealtimeRecorderError::Stream(message.to_string()));
    }

    if event_type == "conversation.item.input_audio_transcription.delta" {
        if let Some(delta) = value["delta"].as_str() {
            let item_id = value["item_id"]
                .as_str()
                .unwrap_or("unknown-item")
                .to_string();
            if ignored_item_ids_after_flush.contains(&item_id) {
                return Ok(false);
            }
            transcript.append_delta(item_id, delta);
            let text = transcript.text();
            update_latest_transcript(latest_transcript, &text);
            live_assist_bridge::transcript_delta(&text);
            return Ok(true);
        }
    }

    if event_type == "conversation.item.input_audio_transcription.completed" {
        if let Some(done) = value["transcript"].as_str() {
            let item_id = value["item_id"]
                .as_str()
                .unwrap_or("unknown-item")
                .to_string();
            if ignored_item_ids_after_flush.remove(&item_id) {
                return Ok(false);
            }
            transcript.complete_item(item_id, done);
            let text = transcript.text();
            update_latest_transcript(latest_transcript, &text);
            live_assist_bridge::transcript_delta(&text);
            return Ok(true);
        }
        return Ok(false);
    }

    Ok(false)
}

fn update_latest_transcript(latest_transcript: &Arc<Mutex<String>>, text: &str) {
    if let Ok(mut latest) = latest_transcript.lock() {
        *latest = text.to_string();
    }
}

async fn send_json(
    writer: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    value: serde_json::Value,
) -> Result<(), RealtimeRecorderError> {
    writer
        .send(Message::Text(value.to_string()))
        .await
        .map_err(|error| RealtimeRecorderError::Stream(error.to_string()))
}

fn pcm16_to_base64(samples: &[i16]) -> String {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    general_purpose::STANDARD.encode(bytes)
}

fn build_realtime_input_stream(
    audio_tx: mpsc::UnboundedSender<Vec<i16>>,
    level_channel: Option<Channel<f32>>,
) -> Result<cpal::Stream, RealtimeRecorderError> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or(RealtimeRecorderError::NoInputDevice)?;
    let config = device
        .default_input_config()
        .map_err(|_| RealtimeRecorderError::DeviceError)?;

    let input_rate = config.sample_rate().0 as usize;
    let channels = config.channels() as usize;
    let (resampler, required_chunk_size) =
        FftFixedInOut::<f32>::new(input_rate, REALTIME_SAMPLE_RATE as usize, 1024, channels)
            .map(|resampler| {
                let input_frames = resampler.input_frames_next();
                (Arc::new(Mutex::new(resampler)), input_frames)
            })
            .map_err(|error| RealtimeRecorderError::Stream(error.to_string()))?;
    let sample_buffer = Arc::new(Mutex::new(vec![Vec::new(); channels]));

    match config.sample_format() {
        cpal::SampleFormat::I8 => build_stream::<i8>(
            &device,
            &config.into(),
            audio_tx,
            level_channel,
            resampler,
            sample_buffer,
            required_chunk_size,
            channels,
        ),
        cpal::SampleFormat::I16 => build_stream::<i16>(
            &device,
            &config.into(),
            audio_tx,
            level_channel,
            resampler,
            sample_buffer,
            required_chunk_size,
            channels,
        ),
        cpal::SampleFormat::I32 => build_stream::<i32>(
            &device,
            &config.into(),
            audio_tx,
            level_channel,
            resampler,
            sample_buffer,
            required_chunk_size,
            channels,
        ),
        cpal::SampleFormat::F32 => build_stream::<f32>(
            &device,
            &config.into(),
            audio_tx,
            level_channel,
            resampler,
            sample_buffer,
            required_chunk_size,
            channels,
        ),
        _ => Err(RealtimeRecorderError::DeviceError),
    }
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    audio_tx: mpsc::UnboundedSender<Vec<i16>>,
    level_channel: Option<Channel<f32>>,
    resampler: Arc<Mutex<FftFixedInOut<f32>>>,
    sample_buffer: Arc<Mutex<Vec<Vec<f32>>>>,
    required_chunk_size: usize,
    channels: usize,
) -> Result<cpal::Stream, RealtimeRecorderError>
where
    T: Sample + FromSample<i16> + FromSample<f32> + std::fmt::Debug + cpal::SizedSample,
    f32: FromSample<T>,
{
    let stream = device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                write_realtime_input(
                    data,
                    &audio_tx,
                    &level_channel,
                    &resampler,
                    &sample_buffer,
                    required_chunk_size,
                    channels,
                );
            },
            |error| error!("Realtime input stream error: {}", error),
            None,
        )
        .map_err(|error| RealtimeRecorderError::Stream(error.to_string()))?;

    Ok(stream)
}

fn write_realtime_input<T>(
    input: &[T],
    audio_tx: &mpsc::UnboundedSender<Vec<i16>>,
    level_channel: &Option<Channel<f32>>,
    resampler: &Arc<Mutex<FftFixedInOut<f32>>>,
    sample_buffer: &Arc<Mutex<Vec<Vec<f32>>>>,
    required_chunk_size: usize,
    channels: usize,
) where
    T: Sample,
    f32: FromSample<T>,
{
    if input.is_empty() {
        return;
    }

    let sum_of_squares: f32 = input
        .iter()
        .map(|&sample| {
            let sample_f32: f32 = sample.to_sample();
            sample_f32 * sample_f32
        })
        .sum();
    if let Some(channel) = level_channel {
        let rms = (sum_of_squares / input.len() as f32).sqrt();
        let _ = channel.send((rms * 100.0).min(1.0));
    }

    let mut buffer_guard = match sample_buffer.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };

    for (index, &sample) in input.iter().enumerate() {
        let sample_f32: f32 = sample.to_sample();
        buffer_guard[index % channels].push(sample_f32);
    }

    while buffer_guard[0].len() >= required_chunk_size {
        let channel_chunks: Vec<Vec<f32>> = buffer_guard
            .iter_mut()
            .map(|channel| channel.drain(..required_chunk_size).collect())
            .collect();
        drop(buffer_guard);

        let resampled = {
            let mut resampler_guard = match resampler.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            let refs: Vec<&[f32]> = channel_chunks.iter().map(Vec::as_slice).collect();
            match resampler_guard.process(&refs, None) {
                Ok(resampled) => resampled,
                Err(error) => {
                    warn!("Realtime resample failed: {}", error);
                    return;
                }
            }
        };

        let mut mono = Vec::with_capacity(resampled[0].len());
        if resampled.len() > 1 {
            for frame_index in 0..resampled[0].len() {
                let mixed = resampled
                    .iter()
                    .map(|channel| channel[frame_index])
                    .sum::<f32>()
                    / resampled.len() as f32;
                mono.push(mixed);
            }
        } else {
            mono.extend_from_slice(&resampled[0]);
        }

        let pcm: Vec<i16> = mono
            .iter()
            .map(|sample| (sample.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect();
        let _ = audio_tx.send(pcm);

        buffer_guard = match sample_buffer.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
    }
}
