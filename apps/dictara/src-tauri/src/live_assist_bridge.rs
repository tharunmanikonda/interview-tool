use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use serde::Serialize;
use std::sync::{LazyLock, Mutex};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::handshake::server::{Request, Response},
    tungstenite::Message,
};

const NATIVE_BRIDGE_ADDR: &str = "127.0.0.1:43217";
const NATIVE_BRIDGE_PATH: &str = "/live-assist";
const CHUNK_DURATION_MS: u64 = 10_000;
const CHUNK_OVERLAP_MS: u64 = 1_000;

static BRIDGE: LazyLock<LiveAssistBridge> = LazyLock::new(LiveAssistBridge::new);

pub fn start() {
    BRIDGE.start();
}

pub fn capture_started() {
    BRIDGE.capture_started();
}

pub fn chunk_transcribed(text: &str) {
    BRIDGE.chunk_transcribed(text);
}

pub fn question_finalized() {
    BRIDGE.question_finalized();
}

pub fn capture_stopped() {
    BRIDGE.capture_stopped();
}

pub fn transcription_error(message: &str) {
    BRIDGE.transcription_error(message);
}

struct LiveAssistBridge {
    sender: broadcast::Sender<String>,
    state: Mutex<BridgeState>,
    started: Mutex<bool>,
}

#[derive(Default)]
struct BridgeState {
    session_id: Option<String>,
    chunks: Vec<String>,
    chunk_index: u64,
    active: bool,
}

impl LiveAssistBridge {
    fn new() -> Self {
        let (sender, _) = broadcast::channel(128);
        Self {
            sender,
            state: Mutex::new(BridgeState::default()),
            started: Mutex::new(false),
        }
    }

    fn start(&self) {
        let mut started = match self.started.lock() {
            Ok(guard) => guard,
            Err(error) => {
                error!("Live Assist bridge start lock failed: {}", error);
                return;
            }
        };

        if *started {
            return;
        }
        *started = true;

        tauri::async_runtime::spawn(async move {
            if let Err(error) = run_server().await {
                error!("Live Assist bridge stopped: {}", error);
            }
        });
    }

    fn capture_started(&self) {
        let mut state = match self.state.lock() {
            Ok(guard) => guard,
            Err(error) => {
                error!("Live Assist bridge state lock failed: {}", error);
                return;
            }
        };

        if state.active {
            state.chunk_index += 1;
            let event = BridgeEvent::chunk_recording_started(&state);
            drop(state);
            self.emit(event);
            return;
        }

        state.active = true;
        state.chunks.clear();
        state.chunk_index = 1;
        state.session_id = Some(format!("dictara-{}", now_ms()));
        let capture = BridgeEvent::capture_started(&state);
        let chunk = BridgeEvent::chunk_recording_started(&state);
        drop(state);
        self.emit(capture);
        self.emit(chunk);
    }

    fn chunk_transcribed(&self, text: &str) {
        let clean_text = text.trim();
        if clean_text.is_empty() {
            return;
        }

        let mut state = match self.state.lock() {
            Ok(guard) => guard,
            Err(error) => {
                error!("Live Assist bridge state lock failed: {}", error);
                return;
            }
        };

        if !state.active {
            state.active = true;
            state.session_id = Some(format!("dictara-{}", now_ms()));
            state.chunk_index = 1;
        }

        state.chunks.push(clean_text.to_string());
        let event = BridgeEvent::chunk_transcribed(&state, clean_text);
        drop(state);
        self.emit(event);
    }

    fn question_finalized(&self) {
        let mut state = match self.state.lock() {
            Ok(guard) => guard,
            Err(error) => {
                error!("Live Assist bridge state lock failed: {}", error);
                return;
            }
        };

        let event = BridgeEvent::question_finalized(&state);
        state.active = false;
        state.chunks.clear();
        state.chunk_index = 0;
        state.session_id = None;
        drop(state);
        self.emit(event);
    }

    fn capture_stopped(&self) {
        let mut state = match self.state.lock() {
            Ok(guard) => guard,
            Err(error) => {
                error!("Live Assist bridge state lock failed: {}", error);
                return;
            }
        };

        let event = BridgeEvent::capture_stopped(&state);
        state.active = false;
        state.chunks.clear();
        state.chunk_index = 0;
        state.session_id = None;
        drop(state);
        self.emit(event);
    }

    fn transcription_error(&self, message: &str) {
        let state = match self.state.lock() {
            Ok(guard) => guard,
            Err(error) => {
                error!("Live Assist bridge state lock failed: {}", error);
                return;
            }
        };

        self.emit(BridgeEvent::transcription_error(&state, message));
    }

    fn emit(&self, event: BridgeEvent) {
        match serde_json::to_string(&event) {
            Ok(payload) => {
                let _ = self.sender.send(payload);
            }
            Err(error) => error!("Failed to serialize Live Assist event: {}", error),
        }
    }
}

async fn run_server() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let listener = TcpListener::bind(NATIVE_BRIDGE_ADDR).await?;
    info!(
        "Live Assist bridge listening on ws://{}{}",
        NATIVE_BRIDGE_ADDR, NATIVE_BRIDGE_PATH
    );

    loop {
        let (stream, _) = listener.accept().await?;
        tauri::async_runtime::spawn(async move {
            if let Err(error) = handle_connection(stream).await {
                warn!("Live Assist bridge connection ended: {}", error);
            }
        });
    }
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut accepted_path = String::new();
    let websocket = accept_hdr_async(stream, |request: &Request, response: Response| {
        accepted_path = request.uri().path().to_string();
        Ok(response)
    })
    .await?;

    if accepted_path != NATIVE_BRIDGE_PATH {
        return Ok(());
    }

    let (mut writer, mut reader) = websocket.split();
    writer
        .send(Message::Text(serde_json::to_string(
            &BridgeEvent::helper_ready(),
        )?))
        .await?;

    let mut receiver = BRIDGE.sender.subscribe();

    loop {
        tokio::select! {
            event = receiver.recv() => {
                match event {
                    Ok(payload) => writer.send(Message::Text(payload)).await?,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            message = reader.next() => {
                match message {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(Box::new(error)),
                }
            }
        }
    }

    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeEvent {
    #[serde(rename = "type")]
    event_type: &'static str,
    session_id: Option<String>,
    chunk_id: Option<String>,
    text: Option<String>,
    is_final: Option<bool>,
    started_at: Option<u64>,
    completed_at: Option<u64>,
    engine: Option<&'static str>,
    starter: Option<String>,
    error: Option<String>,
    chunk_duration_ms: Option<u64>,
    chunk_overlap_ms: Option<u64>,
}

impl BridgeEvent {
    fn helper_ready() -> Self {
        Self {
            event_type: "helper_ready",
            session_id: None,
            chunk_id: None,
            text: None,
            is_final: None,
            started_at: None,
            completed_at: Some(now_ms()),
            engine: Some("api"),
            starter: None,
            error: None,
            chunk_duration_ms: Some(CHUNK_DURATION_MS),
            chunk_overlap_ms: Some(CHUNK_OVERLAP_MS),
        }
    }

    fn capture_started(state: &BridgeState) -> Self {
        Self {
            event_type: "capture_started",
            session_id: state.session_id.clone(),
            chunk_id: None,
            text: None,
            is_final: None,
            started_at: Some(now_ms()),
            completed_at: None,
            engine: Some("api"),
            starter: None,
            error: None,
            chunk_duration_ms: Some(CHUNK_DURATION_MS),
            chunk_overlap_ms: Some(CHUNK_OVERLAP_MS),
        }
    }

    fn chunk_recording_started(state: &BridgeState) -> Self {
        Self {
            event_type: "chunk_recording_started",
            session_id: state.session_id.clone(),
            chunk_id: Some(format!("dictara-chunk-{}", state.chunk_index)),
            text: None,
            is_final: None,
            started_at: Some(now_ms()),
            completed_at: None,
            engine: Some("api"),
            starter: None,
            error: None,
            chunk_duration_ms: Some(CHUNK_DURATION_MS),
            chunk_overlap_ms: Some(CHUNK_OVERLAP_MS),
        }
    }

    fn chunk_transcribed(state: &BridgeState, text: &str) -> Self {
        let buffer = state.chunks.join(" ");
        Self {
            event_type: "chunk_transcribed",
            session_id: state.session_id.clone(),
            chunk_id: Some(format!("dictara-chunk-{}", state.chunk_index)),
            text: Some(text.to_string()),
            is_final: Some(false),
            started_at: None,
            completed_at: Some(now_ms()),
            engine: Some("api"),
            starter: Some(build_starter(&buffer)),
            error: None,
            chunk_duration_ms: Some(CHUNK_DURATION_MS),
            chunk_overlap_ms: Some(CHUNK_OVERLAP_MS),
        }
    }

    fn question_finalized(state: &BridgeState) -> Self {
        let text = state.chunks.join(" ").trim().to_string();
        Self {
            event_type: "question_finalized",
            session_id: state.session_id.clone(),
            chunk_id: None,
            text: if text.is_empty() {
                None
            } else {
                Some(text.clone())
            },
            is_final: Some(true),
            started_at: None,
            completed_at: Some(now_ms()),
            engine: Some("api"),
            starter: if text.is_empty() {
                None
            } else {
                Some(build_starter(&text))
            },
            error: None,
            chunk_duration_ms: Some(CHUNK_DURATION_MS),
            chunk_overlap_ms: Some(CHUNK_OVERLAP_MS),
        }
    }

    fn capture_stopped(state: &BridgeState) -> Self {
        Self {
            event_type: "capture_stopped",
            session_id: state.session_id.clone(),
            chunk_id: None,
            text: None,
            is_final: None,
            started_at: None,
            completed_at: Some(now_ms()),
            engine: Some("api"),
            starter: None,
            error: None,
            chunk_duration_ms: Some(CHUNK_DURATION_MS),
            chunk_overlap_ms: Some(CHUNK_OVERLAP_MS),
        }
    }

    fn transcription_error(state: &BridgeState, message: &str) -> Self {
        Self {
            event_type: "transcription_error",
            session_id: state.session_id.clone(),
            chunk_id: None,
            text: None,
            is_final: None,
            started_at: None,
            completed_at: Some(now_ms()),
            engine: Some("api"),
            starter: None,
            error: Some(message.to_string()),
            chunk_duration_ms: Some(CHUNK_DURATION_MS),
            chunk_overlap_ms: Some(CHUNK_OVERLAP_MS),
        }
    }
}

fn build_starter(text: &str) -> String {
    let lower = text.to_lowercase();
    let technical = lower.contains("redis")
        || lower.contains("cache")
        || lower.contains("database")
        || lower.contains("api")
        || lower.contains("latency")
        || lower.contains("security")
        || lower.contains("oauth")
        || lower.contains("postgres")
        || lower.contains("kubernetes")
        || lower.contains("system design");

    if technical {
        "I’d approach this by separating the requirement, the tradeoff, and the implementation path.".to_string()
    } else {
        "That’s a good question. I’d start by clarifying the main goal, then answer with the key reasoning.".to_string()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}
