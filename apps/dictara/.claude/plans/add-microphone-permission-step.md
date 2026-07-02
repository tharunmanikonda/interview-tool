# Add Microphone Permission Step to Onboarding

**Issue:** [GitHub Issue #53](https://github.com/vitalii-zinchenko/dictara/issues/53)
**Problem:** Users aren't guided to enable microphone permissions during onboarding

## Summary

Add a dedicated Microphone Permission step to the onboarding flow (after Accessibility, before API Keys). The step will:
1. Check if microphone permission is granted
2. Show a button to trigger the system permission dialog
3. Show "Open System Settings" button if permission was denied
4. Automatically detect when permission is enabled (polling)

## Files to Modify

### Backend (Rust)

| File | Changes |
|------|---------|
| [src-tauri/Cargo.toml](src-tauri/Cargo.toml) | Add `objc2-av-foundation` dependency |
| [src-tauri/src/config.rs](src-tauri/src/config.rs#L110) | Add `Microphone` variant to `OnboardingStep` enum |
| [src-tauri/src/tauri_commands.rs](src-tauri/src/tauri_commands.rs#L39) | Add 3 new commands for microphone permissions |
| [src-tauri/src/lib.rs](src-tauri/src/lib.rs#L19) | Register commands in specta builder and invoke handler |

### Frontend (TypeScript/React)

| File | Changes |
|------|---------|
| [src/hooks/useMicrophonePermission.ts](src/hooks/) | NEW - Hook for microphone permission (similar to useAccessibilityPermission) |
| [src/components/onboarding/steps/MicrophoneStep.tsx](src/components/onboarding/steps/) | NEW - Microphone permission step component |
| [src/routes/onboarding/microphone.tsx](src/routes/onboarding/) | NEW - Route file for microphone step |
| [src/hooks/useOnboardingNavigation.ts](src/hooks/useOnboardingNavigation.ts#L5) | Add `microphone` to STEP_ORDER and STEP_ROUTES |
| [src/components/onboarding/utils.ts](src/components/onboarding/utils.ts#L29) | Add microphone to STEPS array |

## Implementation Details

### 1. Rust Dependency (Cargo.toml)

Add to `[target.'cfg(target_os = "macos")'.dependencies]`:
```toml
objc2-av-foundation = { version = "0.3.1", features = ["AVMediaFormat", "block2"] }
```

### 2. OnboardingStep Enum (config.rs)

Add `Microphone` variant after `Accessibility`:
```rust
#[serde(rename = "accessibility")]
Accessibility,
#[serde(rename = "microphone")]  // NEW
Microphone,                       // NEW
#[serde(rename = "api_keys")]
ApiKeys,
```

### 3. New Rust Commands (tauri_commands.rs)

```rust
/// Returns: "authorized", "denied", "restricted", or "not_determined"
#[tauri::command]
#[specta::specta]
pub fn check_microphone_permission() -> String { ... }

/// Triggers macOS permission dialog, returns true if granted
#[tauri::command]
#[specta::specta]
pub async fn request_microphone_permission() -> bool { ... }

/// Opens System Preferences > Privacy > Microphone
#[tauri::command]
#[specta::specta]
pub fn open_microphone_settings() { ... }
```

**macOS API:**
- Use `AVCaptureDevice::authorizationStatusForMediaType(AVMediaTypeAudio)` to check permission
- Use `AVCaptureDevice::requestAccessForMediaType_completionHandler()` to request permission
- Use URL scheme `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` to open settings

### 4. Frontend Hook (useMicrophonePermission.ts)

Similar to [useAccessibilityPermission.ts](src/hooks/useAccessibilityPermission.ts):
- `useMicrophonePermission()` - checks status with polling (refetchInterval: 1000ms)
- `useRequestMicrophonePermission()` - triggers system dialog
- `useOpenMicrophoneSettings()` - opens System Settings

### 5. MicrophoneStep Component

Three states:
1. **Not Determined** - Show "Grant Microphone Access" button (triggers system dialog)
2. **Authorized** - Show green success state with Next button
3. **Denied/Restricted** - Show red alert with "Open System Settings" button

Key differences from AccessibilityStep:
- No app restart required (microphone permission takes effect immediately)
- Uses polling to detect permission changes in System Settings

### 6. Update Step Order

**Before:** welcome → accessibility → api_keys → trigger_key → ...
**After:** welcome → accessibility → **microphone** → api_keys → trigger_key → ...

## Verification

1. **Build & Run:**
   ```bash
   npm run verify
   npm run tauri dev
   ```

2. **Test Scenarios:**
   - [ ] Fresh install: Microphone step appears after accessibility
   - [ ] Click "Grant Microphone Access" → System dialog appears
   - [ ] Grant permission → Green success state shows
   - [ ] Deny permission → Red alert with "Open System Settings" button
   - [ ] Enable in System Settings → UI auto-updates (polling)
   - [ ] Skip button works from microphone step
   - [ ] Back button returns to accessibility step

3. **Non-macOS:** Commands return appropriate defaults ("authorized" / true)

## Reference

- Existing pattern: [AccessibilityStep.tsx](src/components/onboarding/steps/AccessibilityStep.tsx)
- macOS URL schemes: [Apple System Preferences URL Schemes](https://gist.github.com/rmcdongit/f66ff91e0dad78d4d6346a75ded4b751)
- Apple docs: [Requesting Authorization for Media Capture on macOS](https://developer.apple.com/documentation/avfoundation/cameras_and_media_capture/requesting_authorization_for_media_capture_on_macos)
