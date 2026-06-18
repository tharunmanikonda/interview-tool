# Regression Test Plan v0.1.23

**From:** v0.1.22 → v0.1.23-rc.1 (10 commits) | **Date:** 2026-01-12

## Summary of Changes

**Features:**
- Added microphone permission step in onboarding flow (welcome → accessibility → microphone → api_keys)
- Landing page stats now filter to show only stable versions (excludes RC/beta/alpha releases)
- Added 10-second transcription timeout for remote API providers (OpenAI, Azure OpenAI)
- Added `npm run land` script to run landing dev server from project root

**Fixes:**
- Stop button now works correctly in hands-free recording mode
- Onboarding summary displays correct trigger key (Fn/Control/Option/Command) instead of hardcoded "FN"
- System no longer freezes when accessibility permission is revoked during recording (graceful shutdown within 200ms)
- Space key now works normally during hands-free recording (only swallowed once during lock transition)
- No-speech error popup stays visible for manual dismissal with larger text and simplified message

**Other:**
- Version bumped to 0.1.23-rc.1
- Bump-version command documentation updated for RC version support

---

## 🔴 Critical

### Core Recording Functionality
- [ ] Start recording in push-to-talk mode (hold trigger key) → speak → release → verify transcription works
- [ ] Start recording → press Space to lock → speak in hands-free mode → press trigger to stop → verify transcription works
- [ ] Click stop button during hands-free recording → verify recording stops and transcription starts
- [ ] Press trigger key during hands-free mode → verify recording stops and transcription starts
- [ ] Release trigger key during hands-free mode → verify recording continues (release ignored in locked state)
- [ ] Type spaces during hands-free recording → verify all spaces appear in typed text
- [ ] Press Space once to lock recording → verify only first Space swallowed, subsequent spaces work normally
- [ ] Cancel recording with Escape key in both push-to-talk and hands-free modes → verify popup closes

### Permission Handling
- [ ] Launch app with accessibility permission denied → verify clear error message shown
- [ ] Revoke accessibility permission during active recording → verify graceful shutdown within 500ms (no system freeze)
- [ ] Revoke accessibility permission while holding trigger key → verify key release handled gracefully
- [ ] Microphone permission check on onboarding step → verify correct status displayed (authorized/denied/not_determined)
- [ ] Grant microphone permission through System Settings while on onboarding step → verify UI auto-updates within 1 second

### Transcription Timeout
- [ ] Record audio with OpenAI provider, simulate slow response (>10 seconds) → verify timeout error "Transcription took too long. Try again."
- [ ] Record audio with Azure OpenAI provider, simulate slow response (>10 seconds) → verify timeout error shown
- [ ] Timeout occurs → click Retry → verify retry attempt initiates with same audio file
- [ ] Record audio with Local model → verify NO timeout occurs (local model has no timeout)
- [ ] API transcription completes in 9 seconds → verify success (no timeout triggered)

---

## 🟡 New Features

### Microphone Permission Onboarding Step
- [ ] First-time user on microphone step with no permission decision → verify "Open System Settings" button shown and Next disabled
- [ ] Click "Open System Settings" → verify macOS Settings opens to Privacy & Security → Microphone pane
- [ ] Grant permission in System Settings → verify UI automatically shows success alert and enables Next button
- [ ] Deny permission in System Settings → verify red error alert and disabled Next button
- [ ] Navigate from microphone step to api_keys step when authorized → verify successful progression
- [ ] Navigate back from microphone step to accessibility step → verify successful regression
- [ ] Skip onboarding from microphone step → verify onboarding closes and marked incomplete
- [ ] Direct URL navigation to `/onboarding/microphone` → verify step loads correctly
- [ ] Onboarding flow includes microphone in step order: welcome → accessibility → microphone → api_keys → verify all steps appear

### Landing Page Stats Filtering
- [ ] Visit landing page stats → verify only stable versions (vX.X.X format) displayed in table
- [ ] Verify RC versions (v0.1.19-rc.1) do NOT appear in stats table
- [ ] Verify dev/beta/alpha versions do NOT appear in stats table
- [ ] Verify "Latest" badge appears on most recent stable version only
- [ ] Verify total download count excludes RC/dev/beta versions
- [ ] Verify version links to GitHub releases work for all displayed versions
- [ ] Run `npm run land` from project root → verify landing dev server starts successfully
- [ ] Verify hot reload works in landing dev server started via `npm run land`

### Transcription Timeout
- [ ] Timeout error shows "Transcription took too long. Try again." message with Retry button
- [ ] Timeout error → click Dismiss → verify error cleared and popup closed
- [ ] Timeout with valid API credentials → verify timeout is connection/response issue, not auth error
- [ ] Switch from OpenAI to Azure after timeout → retry → verify new provider used
- [ ] Update API key after timeout → retry → verify new API key used

### No-Speech Error UX Improvement
- [ ] Record with no speech → verify popup stays visible (doesn't auto-close)
- [ ] No-speech error displays "No speech detected." in large text (`text-sm`)
- [ ] No-speech error shows no error type header (no "Recording Failed" title)
- [ ] No-speech error shows only Dismiss button (no Retry button)
- [ ] Click Dismiss on no-speech error → verify popup closes and audio file deleted

---

## 🟢 Regression

### Onboarding Flow
- [ ] Complete full onboarding flow with all steps → verify can proceed from welcome to completion
- [ ] Onboarding summary displays correct trigger key for Fn selection → verify "Hold Fn" and "Fn + Space" shown
- [ ] Onboarding summary displays correct trigger key for Control selection → verify "Hold Control" and "Control + Space" shown
- [ ] Onboarding summary displays correct trigger key for Option selection → verify "Hold Option" and "Option + Space" shown
- [ ] Onboarding summary displays correct trigger key for Command selection → verify "Hold Command" and "Command + Space" shown
- [ ] Navigate backward through onboarding steps → verify all steps allow backward navigation
- [ ] Restart onboarding from settings → verify all steps including microphone are present

### Recording States & UI
- [ ] Recording popup opens when trigger key pressed → verify popup visible with timer
- [ ] Recording timer increments during active recording → verify seconds count up
- [ ] Audio level visualization works during recording → verify waveform/bars animate
- [ ] Stop button is enabled and clickable in push-to-talk mode → verify can stop recording
- [ ] Stop button shows loading state while processing → verify "..." text appears
- [ ] Error popup shows "Recording Failed" header for recording errors → verify title displayed
- [ ] Error popup shows "Transcription Failed" header for transcription errors → verify title displayed
- [ ] Successful transcription closes popup automatically → verify popup disappears
- [ ] Transcription error shows Retry button when audio file available → verify button appears

### Keyboard & Input
- [ ] Press trigger key in Ready state → verify recording starts
- [ ] Letters, numbers, symbols pass through during hands-free recording → verify typing works normally
- [ ] Modifier key combinations (Shift+Space, Control+Space) work during hands-free recording → verify combinations work
- [ ] Multiple rapid trigger key presses → verify state transitions handled correctly
- [ ] Rapid Space key presses during hands-free recording → verify all spaces appear
- [ ] Type multi-word sentence in hands-free mode → verify all spaces preserved between words

### Provider & Transcription
- [ ] OpenAI provider with valid API key → verify transcription succeeds within timeout
- [ ] Azure OpenAI provider with valid API key → verify transcription succeeds within timeout
- [ ] Local model provider → verify transcription works without timeout constraint
- [ ] Invalid API key for OpenAI → verify 401 error shown (not timeout error)
- [ ] Rate limit error from API → verify 429 error shown (not timeout error)
- [ ] Switch between providers (OpenAI ↔ Azure ↔ Local) → verify all work correctly

### Accessibility & Permissions
- [ ] Keyboard shortcuts work with all trigger key options (Fn, Control, Option, Command) → verify each works
- [ ] Accessibility permission polling detects permission loss within 200ms → verify no system freeze
- [ ] TapDisabledByTimeout event with permission granted → verify tap re-enabled automatically
- [ ] TapDisabledByUserInput event handled → verify graceful recovery
- [ ] App restart after accessibility permission granted → verify keyboard listener starts successfully

### Error Handling
- [ ] Recording error (microphone access lost) → verify error displayed and popup auto-closes
- [ ] Transcription error → retry → success → verify popup closes after successful retry
- [ ] Transcription error → retry → fail again → verify error persists with retry option
- [ ] Delete audio file after transcription error → retry → verify "File not found" error shown
- [ ] Cancel recording mid-speech → verify popup closes and no error shown

### State Transitions
- [ ] Ready → Recording → Transcribing → Ready → verify state machine progresses correctly
- [ ] Ready → Recording → RecordingLocked → Transcribing → Ready → verify hands-free flow works
- [ ] Recording → Cancel → Ready → verify cancellation returns to ready state
- [ ] Transcribing → Error → Retry → Transcribing → Ready → verify retry flow works
- [ ] RecordingLocked → Stop (button) → Transcribing → verify stop button transitions correctly
- [ ] RecordingLocked → Stop (trigger key) → Transcribing → verify keyboard stop transitions correctly

### Landing Page & Website
- [ ] Main landing page navigation → stats page → verify stats load correctly
- [ ] Stats page back button → main landing page → verify navigation works
- [ ] Direct URL access to `/stats` route → verify page loads
- [ ] Stats table sorting by date descending → verify most recent stable version first
- [ ] Refresh button on stats page → verify data reloads correctly
- [ ] Mobile responsive layout on landing page and stats → verify layout adapts

### Data Persistence & Config
- [ ] Onboarding progress saved when navigating between steps → verify step saved to config
- [ ] Skip onboarding → restart onboarding → verify starts from beginning
- [ ] Complete onboarding → verify all steps marked complete in config
- [ ] Selected trigger key persisted across app restarts → verify config.recordingTrigger saved
- [ ] API keys saved in preferences → verify used in transcription requests

---

## Platforms
- [ ] macOS (primary platform) - All features tested
- [ ] Windows - Recording, transcription, UI (skip macOS-specific permission tests)
- [ ] Linux - Recording, transcription, UI (skip macOS-specific permission tests)

---

## Notes for Testers

**Critical Discrepancy:** The transcription timeout commit message states "20-second timeout" but actual implementation is **10 seconds** (see `TRANSCRIPTION_TIMEOUT_SECS` in code). This test plan reflects the actual 10-second implementation.

**Permission Testing:** Accessibility and microphone permission tests are macOS-specific. Non-macOS platforms return "authorized" by default.

**Hands-Free Mode:** This is a key workflow - press trigger, press Space to lock, type with both hands, press trigger to stop. Test thoroughly with real usage patterns.

**New Microphone Step:** This step was added to address GitHub issue #53. Ensure polling (1-second interval) doesn't cause performance issues during extended testing.

**Stats Filtering Regex:** The landing page uses `/^v\d+\.\d+\.\d+$/` to filter versions. Test edge cases like v10.10.10, v100.100.100, and malformed tags.
