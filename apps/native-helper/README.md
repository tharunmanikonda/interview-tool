# GPTDisguise Native Helper

This is the native-helper prototype for the rolling transcription bridge.

It implements the WebSocket contract that the extension consumes today. The current server is intentionally lightweight and testable: it can receive commands, emit capture lifecycle events, and simulate 10-second transcript chunks. The next hardening step is to wire these commands to the Dictara/Tauri recording and transcription internals.

## Run

```bash
pnpm --filter @gptdisguise/native-helper dev
```

The server listens on `ws://127.0.0.1:43217/live-assist`.

## Dictara Integration Target

Replace `RollingCaptureSession.startChunkLoop` with:

- start recording a 10s chunk
- include 1s overlap with the previous chunk
- transcribe through selected engine: `local` or `api`
- emit `chunk_transcribed`
- repeat until `finalize_question` or `stop_capture`

Default hotkeys for the future Tauri shell:

- `Option+Space`: start/stop rolling capture
- `Option+Enter`: finalize current question
