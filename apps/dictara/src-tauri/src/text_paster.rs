use arboard::Clipboard;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use log::warn;
use std::{thread, time::Duration};

#[derive(Debug, thiserror::Error)]
pub enum ClipboardPasteError {
    #[error("Failed to initialize enigo: {0}")]
    EnigoInitFailed(String),
    #[error("Failed to simulate key event: {0}")]
    KeyEventFailed(String),
    #[error("Empty text")]
    EmptyText,
    #[error("Clipboard error: {0}")]
    ClipboardError(#[from] arboard::Error),
}

/// Auto-paste text
///
/// This function:
/// 1. Saves the current clipboard content
/// 2. Sets the transcribed text to clipboard
/// 3. Simulates Cmd+V (macOS) or Ctrl+V (Windows/Linux) using enigo
/// 4. Restores the original clipboard after a delay
///
/// Returns Ok(()) on success, Err on clipboard or keyboard simulation failure
pub fn paste_text(text: &str) -> Result<(), ClipboardPasteError> {
    // Guard: Don't paste empty text
    if text.is_empty() {
        return Err(ClipboardPasteError::EmptyText);
    }

    // Save current clipboard content (if any)
    let previous_clipboard = match get_current_clipboard() {
        Ok(text) => Some(text),
        Err(_) => {
            warn!("Failed to get current clipboard content");
            None
        }
    };

    // Set transcribed text to clipboard
    set_current_clipboard(text)?;

    // Simulate paste
    simulate_paste()?;

    // Give the target application time to process the paste event
    // before restoring the original clipboard content.
    // 250ms is chosen because:
    // - Some apps read clipboard asynchronously on dispatch queues
    // - Clipboard managers like Maccy poll every 500ms by default
    // - Too short a delay can cause race conditions (e.g., app crashes)
    thread::sleep(Duration::from_millis(250));

    // Restore previous clipboard content
    if let Some(previous_text) = previous_clipboard {
        if let Err(e) = set_current_clipboard(&previous_text) {
            warn!("Failed to set previous clipboard content: {}", e);
        }
    }

    Ok(())
}

fn get_current_clipboard() -> Result<String, arboard::Error> {
    let mut clipboard = Clipboard::new()?;
    clipboard.get_text()
}

fn set_current_clipboard(text: &str) -> Result<(), arboard::Error> {
    let mut clipboard = Clipboard::new()?;
    clipboard.set_text(text.to_string())
}

/// Simulate Cmd+V (macOS) or Ctrl+V (Windows/Linux) using enigo
/// Uses virtual key codes to work regardless of keyboard layout
pub fn simulate_paste() -> Result<(), ClipboardPasteError> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| ClipboardPasteError::EnigoInitFailed(e.to_string()))?;

    // Platform-specific key definitions
    // Use Key::Other with virtual key codes for layout-independent V key
    #[cfg(target_os = "macos")]
    let (modifier_key, v_key) = (Key::Meta, Key::Other(9)); // Cmd + V (keycode 9)
    #[cfg(target_os = "windows")]
    let (modifier_key, v_key) = (Key::Control, Key::Other(0x56)); // Ctrl + V (VK_V)
    #[cfg(target_os = "linux")]
    let (modifier_key, v_key) = (Key::Control, Key::Unicode('v')); // Ctrl + v

    // Press modifier
    enigo
        .key(modifier_key, Direction::Press)
        .map_err(|e| ClipboardPasteError::KeyEventFailed(format!("modifier press: {}", e)))?;

    // Click V key
    enigo
        .key(v_key, Direction::Click)
        .map_err(|e| ClipboardPasteError::KeyEventFailed(format!("V click: {}", e)))?;

    // Small delay for reliability
    thread::sleep(Duration::from_millis(50));

    // Release modifier
    enigo
        .key(modifier_key, Direction::Release)
        .map_err(|e| ClipboardPasteError::KeyEventFailed(format!("modifier release: {}", e)))?;

    Ok(())
}
