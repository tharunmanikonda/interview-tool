//! Event types for keyboard events.

use crate::Key;
use std::time::SystemTime;

/// Type of keyboard event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventType {
    /// A key was pressed down.
    KeyPress(Key),

    /// A key was released.
    KeyRelease(Key),
}

/// A keyboard event.
#[derive(Debug, Clone)]
pub struct Event {
    /// When the event occurred.
    pub time: SystemTime,

    /// The type of event (press or release) and which key.
    pub event_type: EventType,

    /// The character that would be produced by this key press,
    /// taking into account the current keyboard layout and modifiers.
    /// This is `None` for non-character keys like Shift, Ctrl, etc.
    pub name: Option<String>,
}

impl Event {
    /// Create a new event.
    pub fn new(event_type: EventType) -> Self {
        Self {
            time: SystemTime::now(),
            event_type,
            name: None,
        }
    }

    /// Create a new event with a name/character.
    pub fn with_name(event_type: EventType, name: Option<String>) -> Self {
        Self {
            time: SystemTime::now(),
            event_type,
            name,
        }
    }
}
