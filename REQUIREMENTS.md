# Requirements

This document lists what is needed to run and develop Interview Tool.

## Operating System

- macOS desktop is required for the Dictara native helper.
- Apple Silicon is recommended, but Intel Macs can work if Rust/Tauri dependencies compile successfully.
- Chrome desktop or Arc browser is required for the extension.

## Accounts

- A logged-in ChatGPT account at `https://chatgpt.com/`.
- Optional: OpenAI or Azure OpenAI account if using API transcription in Dictara.

## System Tools

- Node.js 20 or newer.
- pnpm 10 or newer.
- Rust and Cargo.
- Xcode Command Line Tools.
- Tauri macOS prerequisites.

Recommended checks:

```bash
node --version
pnpm --version
cargo --version
xcode-select -p
```

## Browser Requirements

- Browser extension developer mode enabled.
- Load unpacked extension from:

```text
apps/extension/.output/chrome-mv3
```

Target pages:

```text
https://chatgpt.com/*
https://chat.openai.com/*
```

## macOS Permissions

Dictara needs:

- Microphone permission for recording.
- Accessibility permission for global hotkeys and paste automation.

If permissions look correct but hotkeys do not work, remove the Dictara entry from System Settings, restart the app, and grant permission again.

## Transcription Options

Dictara supports provider-based transcription. For this prototype, use one of:

- OpenAI transcription API.
- Azure OpenAI transcription API.
- Dictara local transcription mode, if configured and available on the machine.

Provider keys must stay local. Do not commit `.env` files or keys.

## Runtime Behavior Requirements

The expected voice flow is:

```text
Fn hold -> record -> release -> transcribe/paste
Fn+Space -> start hands-free rolling mode
Fn+Space again -> stop/finalize hands-free rolling mode
```

Rolling mode uses 10-second chunks. Each completed chunk is pasted into the extension capture textarea, and the extension decides whether to send a starter prompt or the final prompt.

## Development Verification

Extension:

```bash
pnpm --filter @gptdisguise/extension typecheck
pnpm --filter @gptdisguise/extension build
```

Protocol package:

```bash
pnpm typecheck:protocol
pnpm build:protocol
```

Dictara frontend:

```bash
pnpm typecheck:dictara:frontend
```

Dictara Rust backend:

```bash
pnpm typecheck:dictara:rust
```

Manual QA:

- Load extension on ChatGPT.
- Click Dictara Capture.
- Start Dictara hands-free with `Fn+Space`.
- Speak a short question under 10 seconds.
- Confirm starter appears and ChatGPT responds.
- Speak a longer question across multiple chunks.
- Press `Fn+Space` again.
- Confirm final answer replaces/continues the starter.
- Refresh ChatGPT.
- Confirm document cards hydrate from the existing conversation.

