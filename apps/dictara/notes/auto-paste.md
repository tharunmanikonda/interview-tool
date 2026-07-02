# Auto-Paste Implementation Investigation

## Problem Summary

We need to auto-paste transcribed text after voice recording. The challenge is finding a keyboard simulation method that:
1. ✅ Works in Tauri apps on macOS
2. ✅ Doesn't corrupt rdev's global keyboard state tracking
3. ✅ Doesn't require excessive permissions
4. ✅ Is fast and secure

## Attempts & Findings

### ❌ Option 1: `rdev::simulate()`
**Status:** FAILED - Corrupts listener state

**Problem:**
- `rdev` uses a global mutex `LAST_FLAGS` to track modifier key state ([rdev/src/macos/common.rs:16-17](../.ai-repos/rdev/src/macos/common.rs#L16-L17))
- When you call `rdev::simulate()`, it updates this global state
- The FN key is a modifier, handled via `FlagsChanged` events
- After simulating Cmd+V, the global flags are corrupted
- Next FN key press is misidentified as a RELEASE instead of PRESS

**Code Location:**
- [clipboard_paste.rs](../src-tauri/src/clipboard_paste.rs) (originally used `rdev::simulate()`)

**Evidence:**
```rust
// rdev/src/macos/common.rs
lazy_static! {
    pub static ref LAST_FLAGS: Mutex<CGEventFlags> = Mutex::new(CGEventFlags(0));
    pub static ref KEYBOARD_STATE: Mutex<Keyboard> = Mutex::new(Keyboard::new().unwrap());
}
```

When `simulate()` is called for Cmd+V, it updates `LAST_FLAGS`, causing the FN key listener to compare against corrupted state.

---

### ❌ Option 2: `enigo` Crate
**Status:** FAILED - Crashes in Tauri apps

**Problem:**
- Enigo crashes when calling macOS APIs like `TISCopyCurrentKeyboardInputSource` in Tauri WebKit context
- Known issue: [Tauri #6421](https://github.com/tauri-apps/tauri/issues/6421)
- The crash is **silent** (panics without logs), causing:
  - No auto-paste logs appear
  - Async transcription task dies
  - FN key listener stops working

**Code Location:**
- [Cargo.toml:33](../src-tauri/Cargo.toml#L33) - Added `enigo = "0.2"`
- [clipboard_paste.rs:2](../src-tauri/src/clipboard_paste.rs#L2) - Attempted to use `enigo::{Direction, Enigo, Key, Keyboard, Settings}`

**Evidence:**
From Tauri issue #6421:
> "use `enigo` in tauri cause app crashed... will only appear in my Tauri app"

The crash happens due to conflicts between Tauri's WebKit integration and enigo's keyboard event handling.

---

### ⚠️ Option 2.5: AppleScript (Current Implementation)
**Status:** WORKS but requires extra permissions

**Implementation:**
```rust
let script = r#"
    tell application "System Events"
        keystroke "v" using command down
    end tell
"#;

Command::new("osascript")
    .arg("-e")
    .arg(script)
    .output()
```

**Code Location:**
- [clipboard_paste.rs:35-65](../src-tauri/src/clipboard_paste.rs#L35-L65)

**Pros:**
- ✅ Works reliably
- ✅ Doesn't crash
- ✅ Doesn't corrupt rdev state (separate process)

**Cons:**
- ❌ Requires "System Events" automation permission (user sees permission dialog)
- ⚠️ Process spawn overhead (~20-50ms per paste)
- ⚠️ Spawns visible `osascript` process

**Performance:**
- Process creation: ~5-15ms
- AppleScript parsing + execution: ~15-35ms
- **Total: ~20-50ms** (acceptable since it happens after transcription which takes seconds)

**Security:**
- ✅ Script is hardcoded (no injection risk)
- ⚠️ Requires broad automation permissions for System Events
- ✅ Runs in separate process (isolated from main app)

---

## 🎯 Option 3: Native Core Graphics (Next to Try)

### Hypothesis
Use `core-graphics` crate to call `CGEventPost` directly for **sending** keyboard events only, without using rdev's `simulate()`.

**Key Question:** Will this still corrupt rdev's global `LAST_FLAGS` state?

### Theory
- `rdev::simulate()` likely updates the global state because it's in the same crate
- Using `core-graphics` directly might bypass this global state
- Need to verify if the global state is truly in rdev's code, or if it's macOS-level

### Research Findings

#### Core Graphics API
From [Apple CGEvent Documentation](https://developer.apple.com/documentation/coregraphics/cgevent):

```c
// Create keyboard event
CGEventRef event = CGEventCreateKeyboardEvent(NULL, keyCode, keyDown);

// Post event to event stream
CGEventPost(kCGHIDEventTap, event);
```

#### Rust Bindings
Available via `core-graphics` or `objc2-core-graphics` crates:

- [core-graphics docs](https://docs.rs/core-graphics/latest/core_graphics/event/index.html)
- [objc2-core-graphics on crates.io](https://crates.io/crates/objc2-core-graphics)

The `rdev` crate already uses `objc2-core-graphics` for **listening**, so we could use it for **sending** too.

### Implementation Plan

#### Step 1: Add Dependencies
Already have `objc2-core-graphics` via `rdev`, but may need to add it explicitly:

```toml
# Cargo.toml
objc2-core-graphics = "0.2"  # Check rdev's version
```

#### Step 2: Implement CGEvent-based Paste

```rust
use objc2_core_graphics::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType,
};

pub fn paste_with_cgevent() -> Result<(), String> {
    unsafe {
        // Key code for 'V' is 9 on macOS
        let v_keycode = 9u16;

        // Create Cmd key down event (flags include Command)
        let flags = CGEventFlags::MaskCommand;

        // Create V key press event
        let key_down = CGEvent::keyboard_event(
            std::ptr::null_mut(),
            v_keycode,
            true  // key down
        ).ok_or("Failed to create key down event")?;

        // Set flags for Command key
        key_down.set_flags(flags);

        // Post the event
        key_down.post(CGEventTapLocation::HIDEventTap);

        // Small delay
        std::thread::sleep(std::time::Duration::from_millis(10));

        // Create V key release event
        let key_up = CGEvent::keyboard_event(
            std::ptr::null_mut(),
            v_keycode,
            false  // key up
        ).ok_or("Failed to create key up event")?;

        key_up.set_flags(flags);
        key_up.post(CGEventTapLocation::HIDEventTap);

        // Release Command key (optional - system should handle this)
    }

    Ok(())
}
```

#### Step 3: Test for State Corruption

**Test Procedure:**
1. Record audio (press FN)
2. Transcription completes
3. Auto-paste runs (using CGEvent)
4. Press FN again
5. Check logs - does it correctly show "PRESSED" or incorrectly show "RELEASED"?

**What to Look For:**
- ✅ **SUCCESS:** FN key press is correctly identified as PRESSED
- ❌ **FAILURE:** FN key press is misidentified as RELEASED (state corrupted)

#### Step 4: Investigate rdev's Global State

If CGEvent still corrupts state, examine:

1. **Is `LAST_FLAGS` updated by macOS itself?**
   - Check if macOS automatically updates the global flags when any event is posted
   - Location: [rdev/src/macos/common.rs:16](../.ai-repos/rdev/src/macos/common.rs#L16)

2. **Does rdev's listener see our posted events?**
   - Our listener only handles `Key::Function`, so it should ignore Cmd+V
   - But the `FlagsChanged` event for Cmd might still update global state

3. **Can we isolate the state?**
   - Use a different event tap location?
   - Post events at a different level in the event hierarchy?

### Alternative: Event Isolation

If direct CGEvent posting still causes issues:

**Option 3a:** Post events to a **specific application** instead of globally:
```rust
// Post event only to the active application
CGEventPostToPid(target_pid, event);
```

**Option 3b:** Use `kCGSessionEventTap` instead of `kCGHIDEventTap`:
```rust
key_down.post(CGEventTapLocation::SessionEventTap);
```

Different tap locations might not trigger the global state update.

### Code Structure

```
clipboard_paste.rs
├── copy_to_clipboard()        // Simple clipboard-only (no paste)
├── auto_paste_text()          // Current AppleScript implementation
└── paste_with_cgevent()       // NEW: Core Graphics implementation
```

Keep AppleScript as fallback in case CGEvent doesn't work.

---

## Next Steps

1. ✅ Document current state (this file)
2. ⬜ Implement `paste_with_cgevent()` function
3. ⬜ Test for rdev state corruption
4. ⬜ If successful, replace AppleScript with CGEvent
5. ⬜ If unsuccessful, investigate state isolation options
6. ⬜ Document final decision in this file

---

## Resources

### Documentation
- [rdev GitHub](https://github.com/Narsil/rdev)
- [Tauri Issue #6421: enigo crash](https://github.com/tauri-apps/tauri/issues/6421)
- [enigo Permissions.md](https://github.com/enigo-rs/enigo/blob/main/Permissions.md)
- [core-graphics Rust docs](https://docs.rs/core-graphics/latest/core_graphics/event/index.html)
- [Apple CGEvent API](https://developer.apple.com/documentation/coregraphics/cgevent)

### Related Code
- [keyboard_listener.rs:42-46](../src-tauri/src/keyboard_listener.rs#L42-L46) - Threading fix for emit
- [setup.rs:189-197](../src-tauri/src/setup.rs#L189-L197) - Auto-paste call location
- [rdev/src/macos/common.rs:74-128](../.ai-repos/rdev/src/macos/common.rs#L74-L128) - FlagsChanged handling

### Key Questions Answered
- **Q:** Why does rdev::simulate() corrupt state?
  - **A:** It updates the global `LAST_FLAGS` mutex that the listener uses to determine press vs release for modifier keys.

- **Q:** Why does enigo crash in Tauri?
  - **A:** Conflicts between WebKit and macOS keyboard APIs (TISCopyCurrentKeyboardInputSource).

- **Q:** Is AppleScript slow?
  - **A:** ~20-50ms, but acceptable since transcription takes seconds.

- **Q:** Is AppleScript secure?
  - **A:** Script is hardcoded so no injection risk, but requires System Events automation permission.

---

## Decision Log

### 2025-12-11: Current Implementation
**Decision:** Use AppleScript for auto-paste
**Rationale:** Works reliably, doesn't crash, doesn't corrupt rdev state
**Trade-off:** Requires extra permissions, minor performance overhead
**Next:** Will attempt Core Graphics implementation to avoid permission requirement

---

## Debugging Tips

### Check if FN Key Listener is Working
```bash
# Look for alternating PRESSED/RELEASED in logs
grep "FN Key" logs.txt
```

Should see:
```
[timestamp] FN Key PRESSED
[timestamp] FN Key RELEASED
[timestamp] FN Key PRESSED   # ← Should be PRESSED, not RELEASED
[timestamp] FN Key RELEASED
```

### Check if Auto-Paste is Running
```bash
# Look for auto-paste logs
grep "Auto-Paste" logs.txt
```

Should see:
```
[Auto-Paste] ✅ Successfully pasted text: {transcribed_text}
```

### Test rdev State Corruption
1. Comment out auto-paste code
2. Rapid-fire FN key presses
3. Should see perfect alternation
4. Uncomment auto-paste
5. Do a recording
6. Press FN again
7. Check if it shows PRESSED or RELEASED (should be PRESSED)
