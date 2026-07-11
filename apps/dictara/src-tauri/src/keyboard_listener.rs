use crate::config::ShortcutsConfig;
use crate::recording::{RecordingCommand, RecordingStateManager};
use crate::shortcuts::events::KeyCaptureEvent;
use dictara_keyboard::{grab, Event, EventType};
use log::{error, info};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_specta::Event as EventTrait;
use tokio::sync::mpsc;

/// Operating mode for the keyboard listener
enum ListenerMode {
    /// Normal mode: match shortcuts and trigger recording
    Normal { shortcuts: ShortcutsConfig },
    /// Capture mode: emit key events to frontend for configuration
    Capture { app_handle: AppHandle },
}

/// Keyboard listener that detects key events and emits recording commands
pub struct KeyListener {
    _thread_handle: Option<JoinHandle<()>>,
    mode_tx: mpsc::Sender<ListenerMode>, // Send mode updates to thread
}

impl KeyListener {
    pub fn start(
        command_tx: mpsc::Sender<RecordingCommand>,
        state_manager: Arc<RecordingStateManager>,
        initial_config: ShortcutsConfig,
    ) -> Self {
        info!(
            "Starting KeyListener with initial config: push_to_record={:?}, hands_free={:?}",
            initial_config.push_to_record.keys, initial_config.hands_free.keys
        );

        let (mode_tx, mut mode_rx) = mpsc::channel(10);
        let rolling_active = Arc::new(AtomicBool::new(false));
        let rolling_hands_free = Arc::new(AtomicBool::new(false));
        let rolling_active_for_thread = rolling_active.clone();
        let rolling_hands_free_for_thread = rolling_hands_free.clone();
        let fn_key_down = Arc::new(AtomicBool::new(false));
        let fn_hold_recording = Arc::new(AtomicBool::new(false));
        let fn_stop_consumed = Arc::new(AtomicBool::new(false));
        let fn_key_down_for_thread = fn_key_down.clone();
        let fn_hold_recording_for_thread = fn_hold_recording.clone();
        let fn_stop_consumed_for_thread = fn_stop_consumed.clone();

        let thread_handle = thread::spawn(move || {
            let mut mode = ListenerMode::Normal {
                shortcuts: initial_config,
            };
            let mut pressed_keys: HashSet<u32> = HashSet::new();
            let mut last_fn_tap_at: Option<Instant> = None;

            if let Err(err) = grab(move |event| {
                // Phase 1: Sync to latest mode from control channel
                Self::sync_mode(&mut mode, &mut mode_rx, &mut pressed_keys);

                // Phase 2: Process event with fresh mode
                match &mode {
                    ListenerMode::Normal { shortcuts } => Self::handle_normal_mode(
                        event,
                        shortcuts,
                        &mut pressed_keys,
                        &command_tx,
                        &state_manager,
                        &rolling_active_for_thread,
                        &rolling_hands_free_for_thread,
                        &fn_key_down_for_thread,
                        &fn_hold_recording_for_thread,
                        &fn_stop_consumed_for_thread,
                        &mut last_fn_tap_at,
                    ),
                    ListenerMode::Capture { app_handle } => {
                        Self::handle_capture_mode(event, app_handle)
                    }
                }
            }) {
                error!(
                    "Keyboard grab failed: {}. Keyboard shortcuts will not work.",
                    err
                );
            }
        });

        Self {
            _thread_handle: Some(thread_handle),
            mode_tx,
        }
    }

    /// Drain all pending mode updates from the control channel to ensure we always
    /// process events with the latest mode (avoids stale state)
    fn sync_mode(
        mode: &mut ListenerMode,
        mode_rx: &mut mpsc::Receiver<ListenerMode>,
        pressed_keys: &mut HashSet<u32>,
    ) {
        while let Ok(new_mode) = mode_rx.try_recv() {
            match &new_mode {
                ListenerMode::Normal { shortcuts } => {
                    info!(
                        "KeyListener mode updated: Normal (push_to_record={:?}, hands_free={:?})",
                        shortcuts.push_to_record.keys, shortcuts.hands_free.keys
                    );
                }
                ListenerMode::Capture { .. } => {
                    info!("KeyListener mode updated: Capture");
                }
            }
            *mode = new_mode;
            pressed_keys.clear(); // Reset on mode change
        }
    }

    /// Handle keyboard events in normal mode (shortcuts matching, recording triggers)
    fn handle_normal_mode(
        event: Event,
        shortcuts: &ShortcutsConfig,
        pressed_keys: &mut HashSet<u32>,
        command_tx: &mpsc::Sender<RecordingCommand>,
        state_manager: &Arc<RecordingStateManager>,
        rolling_active: &Arc<AtomicBool>,
        rolling_hands_free: &Arc<AtomicBool>,
        fn_key_down: &Arc<AtomicBool>,
        fn_hold_recording: &Arc<AtomicBool>,
        fn_stop_consumed: &Arc<AtomicBool>,
        last_fn_tap_at: &mut Option<Instant>,
    ) -> Option<Event> {
        match event.event_type {
            EventType::KeyPress(key) => {
                let keycode = key.to_macos_keycode();

                if live_assist_realtime_enabled() {
                    pressed_keys.insert(keycode);
                    if handle_realtime_live_assist_keypress(
                        keycode,
                        command_tx,
                        state_manager,
                        rolling_active,
                        rolling_hands_free,
                        fn_key_down,
                        fn_stop_consumed,
                    ) {
                        return None;
                    }
                    return Some(event);
                }

                if keycode == FN_KEYCODE {
                    pressed_keys.insert(keycode);
                    handle_fn_press(
                        command_tx,
                        state_manager,
                        rolling_active,
                        rolling_hands_free,
                        fn_key_down,
                        fn_hold_recording,
                        fn_stop_consumed,
                        last_fn_tap_at,
                    );
                    return None;
                }

                // Check if shortcut was matched BEFORE inserting new key (rising edge detection)
                let was_push_to_record = shortcuts.push_to_record.matches(pressed_keys);
                let was_hands_free = shortcuts.hands_free.matches(pressed_keys);

                pressed_keys.insert(keycode);

                // Push-to-talk: Rising edge detected
                if !was_push_to_record && shortcuts.push_to_record.matches(pressed_keys) {
                    if state_manager.is_recording_locked() {
                        // Stop hands-free mode (push-to-talk can stop hands-free)
                        if rolling_active.swap(false, Ordering::SeqCst) {
                            rolling_hands_free.store(false, Ordering::SeqCst);
                            let _ = command_tx
                                .blocking_send(RecordingCommand::FinalizeRollingRecording);
                        } else {
                            let _ = command_tx.blocking_send(RecordingCommand::StopRecording);
                        }
                    } else {
                        // Start live-assist rolling push-to-talk recording.
                        start_live_assist_rolling(
                            command_tx,
                            state_manager,
                            rolling_active,
                            rolling_hands_free,
                            false,
                        );
                    }
                }

                // Hands-free: Rising edge detected (toggle behavior)
                if !was_hands_free && shortcuts.hands_free.matches(pressed_keys) {
                    if state_manager.is_recording_locked() {
                        // Toggle off: Stop hands-free
                        let _ = command_tx.blocking_send(RecordingCommand::StopRecording);
                    } else {
                        // Toggle on: Start hands-free
                        let _ = command_tx.blocking_send(RecordingCommand::StartRecording);
                        let _ = command_tx.blocking_send(RecordingCommand::LockRecording);
                    }

                    // Swallow Space if it's in the combo
                    if shortcuts.hands_free.keys.iter().any(|k| k.keycode == 49) {
                        return None;
                    }
                }

                // Swallow all keys while push-to-record is active
                if shortcuts.push_to_record.matches(pressed_keys) {
                    return None;
                }

                Some(event)
            }
            EventType::KeyRelease(key) => {
                let keycode = key.to_macos_keycode();

                if live_assist_realtime_enabled() {
                    pressed_keys.remove(&keycode);
                    if keycode == FN_KEYCODE {
                        handle_realtime_live_assist_keyrelease(
                            command_tx,
                            rolling_active,
                            fn_key_down,
                            fn_stop_consumed,
                        );
                        return None;
                    }
                    if is_control_key(keycode) {
                        return None;
                    }
                    return Some(event);
                }

                if keycode == FN_KEYCODE {
                    pressed_keys.remove(&keycode);
                    handle_fn_release(
                        command_tx,
                        rolling_active,
                        rolling_hands_free,
                        fn_key_down,
                        fn_hold_recording,
                        fn_stop_consumed,
                        last_fn_tap_at,
                    );
                    return None;
                }

                // Check push-to-record BEFORE removing key
                let was_push_to_record = shortcuts.push_to_record.matches(pressed_keys);

                pressed_keys.remove(&keycode);

                // Release stops recording (unless locked)
                if was_push_to_record
                    && rolling_active.load(Ordering::SeqCst)
                    && !rolling_hands_free.load(Ordering::SeqCst)
                {
                    rolling_active.store(false, Ordering::SeqCst);
                    let _ = command_tx.blocking_send(RecordingCommand::FinalizeRollingRecording);
                } else if was_push_to_record && !state_manager.is_recording_locked() {
                    let _ = command_tx.blocking_send(RecordingCommand::StopRecording);
                }

                Some(event)
            }
        }
    }

    /// Handle keyboard events in capture mode (emit to frontend, swallow all)
    fn handle_capture_mode(event: Event, app_handle: &AppHandle) -> Option<Event> {
        match event.event_type {
            EventType::KeyPress(key) => {
                let keycode = key.to_macos_keycode();
                let label = key.to_label();
                let _ = KeyCaptureEvent::KeyDown { keycode, label }.emit(app_handle);
            }
            EventType::KeyRelease(key) => {
                let keycode = key.to_macos_keycode();
                let label = key.to_label();
                let _ = KeyCaptureEvent::KeyUp { keycode, label }.emit(app_handle);
            }
        }

        // Swallow ALL events in capture mode (prevent Cmd+Q, etc.)
        None
    }

    /// Enter capture mode to configure shortcuts
    pub fn enter_capture_mode(&self, app_handle: AppHandle) -> Result<(), String> {
        info!("Sending mode change request: Capture");
        self.mode_tx
            .blocking_send(ListenerMode::Capture { app_handle })
            .map_err(|_| "KeyListener thread is not running".to_string())
    }

    /// Exit capture mode and return to normal mode with updated shortcuts
    pub fn exit_capture_mode(&self, shortcuts: ShortcutsConfig) -> Result<(), String> {
        info!(
            "Sending mode change request: Normal (push_to_record={:?}, hands_free={:?})",
            shortcuts.push_to_record.keys, shortcuts.hands_free.keys
        );
        self.mode_tx
            .blocking_send(ListenerMode::Normal { shortcuts })
            .map_err(|_| "KeyListener thread is not running".to_string())
    }

    /// Update shortcuts at runtime (no restart needed!)
    pub fn update_shortcuts(&self, new_config: ShortcutsConfig) -> Result<(), String> {
        info!(
            "Sending shortcuts update request: push_to_record={:?}, hands_free={:?}",
            new_config.push_to_record.keys, new_config.hands_free.keys
        );
        self.mode_tx
            .blocking_send(ListenerMode::Normal {
                shortcuts: new_config,
            })
            .map_err(|_| "KeyListener thread is not running".to_string())
    }

    /// Check if any shortcut uses Fn key (for globe key fix)
    pub fn uses_fn_key(config: &ShortcutsConfig) -> bool {
        // Live Assist rolling mode always uses Fn gestures.
        // Keep the macOS Globe/Fn behavior compatible even if user-configured
        // Dictara shortcuts do not include Fn.
        if cfg!(target_os = "macos") {
            return true;
        }

        let fn_code = 63u32;
        config
            .push_to_record
            .keys
            .iter()
            .any(|k| k.keycode == fn_code)
            || config.hands_free.keys.iter().any(|k| k.keycode == fn_code)
    }
}

const FN_KEYCODE: u32 = 63;
const SPACE_KEYCODE: u32 = 49;
const LEFT_CONTROL_KEYCODE: u32 = 59;
const RIGHT_CONTROL_KEYCODE: u32 = 62;
const LIVE_ASSIST_FIRST_CHUNK_SECONDS: u64 = 10;
const LIVE_ASSIST_FOLLOWUP_CHUNK_SECONDS: u64 = 5;
const FN_HOLD_TO_RECORD_MS: u64 = 320;
const FN_DOUBLE_TAP_MS: u64 = 380;
const REALTIME_FN_HOLD_TOGGLE_MS: u64 = 650;

fn handle_realtime_live_assist_keypress(
    keycode: u32,
    command_tx: &mpsc::Sender<RecordingCommand>,
    state_manager: &Arc<RecordingStateManager>,
    rolling_active: &Arc<AtomicBool>,
    rolling_hands_free: &Arc<AtomicBool>,
    fn_key_down: &Arc<AtomicBool>,
    fn_stop_consumed: &Arc<AtomicBool>,
) -> bool {
    if keycode == FN_KEYCODE {
        if fn_key_down.swap(true, Ordering::SeqCst) {
            return true;
        }

        fn_stop_consumed.store(false, Ordering::SeqCst);
        let hold_tx = command_tx.clone();
        let hold_state_manager = state_manager.clone();
        let hold_rolling_active = rolling_active.clone();
        let hold_rolling_hands_free = rolling_hands_free.clone();
        let hold_fn_key_down = fn_key_down.clone();
        let hold_fn_consumed = fn_stop_consumed.clone();

        thread::spawn(move || {
            thread::sleep(Duration::from_millis(REALTIME_FN_HOLD_TOGGLE_MS));
            if !hold_fn_key_down.load(Ordering::SeqCst) {
                return;
            }

            hold_fn_consumed.store(true, Ordering::SeqCst);
            if hold_rolling_active.swap(false, Ordering::SeqCst) {
                info!("Live Assist realtime always-listen stopped by Fn hold");
                hold_rolling_hands_free.store(false, Ordering::SeqCst);
                let _ = hold_tx.blocking_send(RecordingCommand::Cancel);
            } else {
                info!("Live Assist realtime always-listen started by Fn hold");
                start_live_assist_rolling(
                    &hold_tx,
                    &hold_state_manager,
                    &hold_rolling_active,
                    &hold_rolling_hands_free,
                    true,
                );
            }
        });

        return true;
    }

    if is_control_key(keycode) && rolling_active.load(Ordering::SeqCst) {
        info!("Live Assist realtime starter requested by Control");
        let _ = command_tx.blocking_send(RecordingCommand::RequestRealtimeStarter);
        return true;
    }

    if keycode == SPACE_KEYCODE && rolling_active.load(Ordering::SeqCst) {
        info!("Live Assist realtime buffer cleared by Space");
        let _ = command_tx.blocking_send(RecordingCommand::ClearRealtimeBuffer);
        return true;
    }

    false
}

fn handle_realtime_live_assist_keyrelease(
    command_tx: &mpsc::Sender<RecordingCommand>,
    rolling_active: &Arc<AtomicBool>,
    fn_key_down: &Arc<AtomicBool>,
    fn_stop_consumed: &Arc<AtomicBool>,
) {
    fn_key_down.store(false, Ordering::SeqCst);

    if fn_stop_consumed.swap(false, Ordering::SeqCst) {
        return;
    }

    if rolling_active.load(Ordering::SeqCst) {
        info!("Live Assist realtime buffer finalized by Fn tap");
        let _ = command_tx.blocking_send(RecordingCommand::FinalizeRealtimeBuffer);
    }
}

fn is_control_key(keycode: u32) -> bool {
    keycode == LEFT_CONTROL_KEYCODE || keycode == RIGHT_CONTROL_KEYCODE
}

fn handle_fn_press(
    command_tx: &mpsc::Sender<RecordingCommand>,
    state_manager: &Arc<RecordingStateManager>,
    rolling_active: &Arc<AtomicBool>,
    rolling_hands_free: &Arc<AtomicBool>,
    fn_key_down: &Arc<AtomicBool>,
    fn_hold_recording: &Arc<AtomicBool>,
    fn_stop_consumed: &Arc<AtomicBool>,
    last_fn_tap_at: &mut Option<Instant>,
) {
    let now = Instant::now();

    if rolling_active.load(Ordering::SeqCst) && rolling_hands_free.load(Ordering::SeqCst) {
        rolling_active.store(false, Ordering::SeqCst);
        rolling_hands_free.store(false, Ordering::SeqCst);
        fn_key_down.store(false, Ordering::SeqCst);
        fn_hold_recording.store(false, Ordering::SeqCst);
        fn_stop_consumed.store(true, Ordering::SeqCst);
        *last_fn_tap_at = None;
        let _ = command_tx.blocking_send(RecordingCommand::FinalizeRollingRecording);
        return;
    }

    if last_fn_tap_at
        .map(|last| now.duration_since(last) <= Duration::from_millis(FN_DOUBLE_TAP_MS))
        .unwrap_or(false)
    {
        *last_fn_tap_at = None;
        fn_key_down.store(true, Ordering::SeqCst);
        fn_hold_recording.store(false, Ordering::SeqCst);
        fn_stop_consumed.store(true, Ordering::SeqCst);
        start_live_assist_rolling(
            command_tx,
            state_manager,
            rolling_active,
            rolling_hands_free,
            true,
        );
        return;
    }

    *last_fn_tap_at = None;

    if fn_key_down.swap(true, Ordering::SeqCst) {
        return;
    }

    let hold_tx = command_tx.clone();
    let hold_state_manager = state_manager.clone();
    let hold_rolling_active = rolling_active.clone();
    let hold_rolling_hands_free = rolling_hands_free.clone();
    let hold_fn_key_down = fn_key_down.clone();
    let hold_fn_recording = fn_hold_recording.clone();

    thread::spawn(move || {
        thread::sleep(Duration::from_millis(FN_HOLD_TO_RECORD_MS));

        if !hold_fn_key_down.load(Ordering::SeqCst)
            || hold_rolling_active.load(Ordering::SeqCst)
            || hold_state_manager.is_recording_locked()
        {
            return;
        }

        hold_fn_recording.store(true, Ordering::SeqCst);
        start_live_assist_rolling(
            &hold_tx,
            &hold_state_manager,
            &hold_rolling_active,
            &hold_rolling_hands_free,
            false,
        );
    });
}

fn handle_fn_release(
    command_tx: &mpsc::Sender<RecordingCommand>,
    rolling_active: &Arc<AtomicBool>,
    rolling_hands_free: &Arc<AtomicBool>,
    fn_key_down: &Arc<AtomicBool>,
    fn_hold_recording: &Arc<AtomicBool>,
    fn_stop_consumed: &Arc<AtomicBool>,
    last_fn_tap_at: &mut Option<Instant>,
) {
    fn_key_down.store(false, Ordering::SeqCst);

    if fn_stop_consumed.swap(false, Ordering::SeqCst) {
        *last_fn_tap_at = None;
        return;
    }

    if fn_hold_recording.swap(false, Ordering::SeqCst) {
        rolling_active.store(false, Ordering::SeqCst);
        rolling_hands_free.store(false, Ordering::SeqCst);
        *last_fn_tap_at = None;
        let _ = command_tx.blocking_send(RecordingCommand::FinalizeRollingRecording);
        return;
    }

    *last_fn_tap_at = Some(Instant::now());
}

fn start_live_assist_rolling(
    command_tx: &mpsc::Sender<RecordingCommand>,
    state_manager: &Arc<RecordingStateManager>,
    rolling_active: &Arc<AtomicBool>,
    rolling_hands_free: &Arc<AtomicBool>,
    hands_free: bool,
) {
    rolling_active.store(true, Ordering::SeqCst);
    rolling_hands_free.store(hands_free, Ordering::SeqCst);

    if !state_manager.is_recording() && !state_manager.is_recording_locked() {
        let _ = command_tx.blocking_send(RecordingCommand::StartLiveAssistRecording);
    }
    let _ = command_tx.blocking_send(RecordingCommand::LockRecording);

    let timer_tx = command_tx.clone();
    let timer_active = rolling_active.clone();
    let timer_state_manager = state_manager.clone();
    if live_assist_realtime_enabled() {
        return;
    }

    thread::spawn(move || {
        let mut next_chunk_seconds = LIVE_ASSIST_FIRST_CHUNK_SECONDS;

        while timer_active.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_secs(next_chunk_seconds));
            if !timer_active.load(Ordering::SeqCst) {
                break;
            }

            if !timer_state_manager.is_recording_locked() {
                continue;
            }

            if timer_tx
                .blocking_send(RecordingCommand::StopAndRestartRecording)
                .is_err()
            {
                timer_active.store(false, Ordering::SeqCst);
                break;
            }

            next_chunk_seconds = LIVE_ASSIST_FOLLOWUP_CHUNK_SECONDS;
        }
    });
}

fn live_assist_realtime_enabled() -> bool {
    matches!(
        std::env::var("DICTARA_LIVE_ASSIST_REALTIME").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES")
    )
}
