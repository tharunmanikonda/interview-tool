# Recording Popup Focus Stealing Issue

## Problem Description

When the user first launches the app, puts their text cursor in a text input field (e.g., in a browser or other application), and then presses the FN key to start recording, **the focus is removed from the input box** on the first recording. However, on subsequent recordings, the focus is NOT stolen.

This is a poor user experience because the whole point of the app is to transcribe speech and paste it where the cursor is - but if the cursor loses focus, the paste target is lost.

## Root Cause Analysis

The issue stems from how macOS handles window visibility for the first time:

1. The `recording-popup` window is created at app startup with `visible: false` in `tauri.conf.json`
2. When `window.show()` is called for the first time, Tauri/macOS uses `makeKeyAndOrderFront:` under the hood
3. `makeKeyAndOrderFront:` **activates the app** and **steals keyboard focus**
4. On subsequent show/hide cycles, macOS behaves differently and doesn't aggressively steal focus

This is a known issue with Tauri on macOS: https://github.com/tauri-apps/tauri/issues/7519

## Attempted Solutions

### Attempt 1: `focus: false` in window config

**File:** `src-tauri/tauri.conf.json`

```json
{
  "label": "recording-popup",
  "focus": false,
  // ... other options
}
```

**Result:** Did not work. The `focus` property in Tauri config is reportedly ignored/buggy on macOS.

### Attempt 2: `focusable: false` in window config

**File:** `src-tauri/tauri.conf.json`

```json
{
  "label": "recording-popup",
  "focusable": false,
  // ... other options
}
```

**Result:** Did not work. Still steals focus on first appearance.

### Attempt 3: Native macOS API with `orderFrontRegardless`

**File:** `src-tauri/src/ui/window.rs`

Attempted to use native macOS Objective-C APIs via `objc2` crate:

```rust
unsafe {
    let _: () = msg_send![ns_window_ptr, orderFrontRegardless];
}
```

**Result:** Window didn't appear at all. `orderFrontRegardless` only changes z-order but doesn't unhide a hidden window.

### Attempt 4: Native macOS API with `setIsVisible:` + `orderFront:`

**File:** `src-tauri/src/ui/window.rs`

```rust
unsafe {
    // First, make the window visible
    let _: () = msg_send![ns_window_ptr, setIsVisible: true];
    // Then bring to front without making key
    let _: () = msg_send![ns_window_ptr, orderFront: ptr::null::<AnyObject>()];
}
```

**Result:** App hangs/doesn't respond to FN press. The native API calls seem to cause some kind of deadlock or blocking issue, possibly due to thread safety (the Controller runs in a separate blocking thread).

## Current State

The code currently has:
- `focusable: false` in `tauri.conf.json` (ineffective but harmless)
- Native macOS API approach in `window.rs` with debug logging (causes hang)

## Potential Next Steps

1. **Thread safety investigation**: The `ns_window()` and native calls might need to run on the main thread. Could try using `tauri::async_runtime::spawn` or dispatching to main thread.

2. **NSPanel approach**: Use `NSPanel` with `NSNonactivatingPanelMask` style mask instead of `NSWindow`. This is how Spotlight and similar apps show UI without stealing focus. Would require more complex native code.

3. **Alternative: Don't hide the window**: Instead of hiding/showing, keep the window always visible but:
   - Move it off-screen when not recording
   - Or make it fully transparent (alpha = 0) when not recording

4. **Alternative: Accept focus steal, restore focus**: After showing the popup, programmatically restore focus to the previously focused application using `NSWorkspace` or AppleScript.

5. **WebView overlay approach**: Instead of a separate window, use an overlay within the main app window (but this conflicts with the "no main window" design).

6. **File a detailed bug report with Tauri**: The focus handling on macOS is clearly broken.

## Relevant Files

- `src-tauri/tauri.conf.json` - Window configuration
- `src-tauri/src/ui/window.rs` - Window show/hide logic
- `src-tauri/src/recording/controller.rs` - Calls `open_recording_popup()`
- `src-tauri/Cargo.toml` - Added `objc2` and `objc2-app-kit` dependencies

## Dependencies Added

```toml
[target.'cfg(target_os = "macos")'.dependencies]
objc2-app-kit = { version = "0.3.1", features = ["NSWindow", "NSResponder"] }
objc2 = "0.6"
```

## References

- [Tauri issue #7519 - focus property not respected](https://github.com/tauri-apps/tauri/issues/7519)
- [Tauri issue #12834 - set_focus broken on macOS](https://github.com/tauri-apps/tauri/issues/12834)
- [Apple NSWindow orderFront: documentation](https://developer.apple.com/documentation/appkit/nswindow/1419204-orderfront)
- [Apple NSPanel documentation](https://developer.apple.com/documentation/appkit/nspanel)
