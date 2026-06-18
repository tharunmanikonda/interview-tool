# Interview Tool

Interview Tool is a prototype live interview assistant built from two pieces:

- A Chrome/Arc extension that disguises ChatGPT as a Google Docs-style document.
- A modified Dictara/Tauri macOS helper that records speech in rolling chunks and pastes transcripts into the extension.

The current loop is:

```text
Dictara audio chunk -> transcript paste -> extension rolling question buffer -> short starter prompt -> ChatGPT browser response -> final full answer prompt -> formatted Docs card
```

This is an MVP/prototype. It uses the logged-in ChatGPT web page as the answer engine instead of an API backend.

## Repository Layout

```text
.
├── apps
│   ├── extension       # WXT + React + TypeScript browser extension
│   ├── dictara         # Modified Dictara/Tauri macOS app for speech-to-text
│   └── native-helper   # Earlier WebSocket simulation helper, kept for reference/testing
├── packages
│   └── protocol        # Shared event/command types for helper/extension communication
├── AGENTS.md           # Instructions for future coding agents
├── REQUIREMENTS.md     # System, account, and permission requirements
├── requirements.txt    # Tooling checklist in plain text form
└── README.md
```

## What Works Now

- Google Docs-style overlay on `chatgpt.com`.
- Dictara rolling paste mode with 10-second chunks.
- `Fn` push-to-talk recording.
- `Fn+Space` hands-free recording; press again to stop/finalize.
- Short starter responses for partial chunks, capped around 50 words.
- Full final answer generation after the complete question is finalized.
- Formatted answer cards with question, starter, answer, code block rendering, and latency status.
- ChatGPT conversation hydration after refresh.

## Requirements

Read [REQUIREMENTS.md](./REQUIREMENTS.md) for the full list.

Short version:

- macOS desktop.
- Arc or Chrome desktop.
- Node.js 20+ recommended.
- pnpm 10+.
- Rust/Cargo.
- Tauri prerequisites for macOS.
- Logged-in ChatGPT account.
- OpenAI or Azure OpenAI transcription provider configured in Dictara, or a local Dictara transcription model.
- macOS Microphone and Accessibility permissions for Dictara.

## Install

Clone the repo:

```bash
git clone https://github.com/tharunmanikonda/interview-tool.git
cd interview-tool
```

Install root workspace dependencies:

```bash
pnpm install
```

Install Dictara dependencies:

```bash
pnpm --dir apps/dictara install
```

Make sure Rust is available:

```bash
cargo --version
```

## Run the Extension

Start the extension dev server:

```bash
pnpm dev:extension
```

If WXT cannot find Chrome because you use Arc, that is okay. The extension still builds into:

```text
apps/extension/.output/chrome-mv3
```

Load it manually:

1. Open `arc://extensions` or `chrome://extensions`.
2. Turn on Developer Mode.
3. Click `Load unpacked`.
4. Select `apps/extension/.output/chrome-mv3`.
5. Open `https://chatgpt.com/`.

You should see the Docs-style overlay with a left rail and a white document page.

## Run Dictara

Start the modified Dictara app:

```bash
pnpm dev:dictara
```

During first run, complete onboarding:

1. Grant Accessibility permission.
2. Grant Microphone permission.
3. Configure a transcription provider.
4. Restart the app if macOS asks for it.

Dictara stores provider credentials in macOS Keychain. Do not commit `.env` files or API keys.

## Use the Live Assist Flow

1. Open `https://chatgpt.com/` with the extension loaded.
2. Click `Dictara Capture` in the extension.
3. Keep the cursor/focus in the extension capture textarea.
4. Use one of these recording modes:

```text
Hold Fn         -> push-to-talk recording
Fn+Space       -> start hands-free rolling recording
Fn+Space again -> stop/finalize hands-free recording
```

Every 10 seconds, Dictara stops the current recording chunk, transcribes it, pastes the transcript into the extension, then starts the next chunk. The extension appends/dedupes chunks into the current question and sends short starter prompts to ChatGPT.

When recording is finalized, the extension sends the full accumulated question to ChatGPT and renders the final answer into the document card.

## Development Commands

```bash
pnpm typecheck:extension
pnpm build:extension
pnpm typecheck:protocol
pnpm build:protocol
pnpm typecheck:dictara:frontend
pnpm typecheck:dictara:rust
```

Full extension verification:

```bash
pnpm --filter @gptdisguise/extension typecheck
pnpm --filter @gptdisguise/extension build
```

Dictara Rust verification:

```bash
cd apps/dictara/src-tauri
cargo fmt --check
cargo check
```

## Important Files

- `apps/extension/entrypoints/content.tsx` - overlay UI, Dictara paste handling, ChatGPT send flow.
- `apps/extension/src/liveAssist.ts` - conversation state, starter/final prompt builders, queue handling.
- `apps/extension/src/chatgptAdapter.ts` - ChatGPT composer automation and answer observation.
- `apps/extension/src/content.css` - Docs-style overlay CSS.
- `apps/dictara/src-tauri/src/keyboard_listener.rs` - Dictara hotkey behavior.
- `apps/dictara/src-tauri/src/recording/controller.rs` - Dictara rolling recording/finalize behavior.
- `packages/protocol/src/index.ts` - shared helper event/command schema.

## Troubleshooting

### Extension does not appear

- Reload the unpacked extension.
- Refresh `https://chatgpt.com/`.
- Make sure the loaded folder is `apps/extension/.output/chrome-mv3`, not the repo root.

### Dictara does not paste text

- Check macOS Accessibility permission for the Dictara dev binary.
- Keep the extension capture textarea focused.
- Verify Dictara logs show transcription success.
- Make sure another app is not stealing focus.

### ChatGPT does not receive the prompt

- Confirm ChatGPT is logged in and the composer is visible.
- Refresh the ChatGPT tab.
- Reload the extension.
- Check whether ChatGPT changed its composer selectors; the adapter is in `apps/extension/src/chatgptAdapter.ts`.

### Overlay says waiting even though ChatGPT answered

- Refresh ChatGPT and reload the extension.
- Check `observeLatestAnswer` in `apps/extension/src/chatgptAdapter.ts`.
- Check active request and queue handling in `apps/extension/entrypoints/content.tsx`.

### First run fails with Tauri or Rust errors

- Confirm Rust is installed.
- Confirm Xcode command line tools are installed.
- Run `pnpm --dir apps/dictara install`.
- Run from repo root with `pnpm dev:dictara`.

## Security Notes

- Do not commit API keys.
- Do not commit `.env` files.
- Do not commit `node_modules`, `.output`, `.logs`, or `target`.
- Dictara may use OpenAI/Azure/local transcription depending on user configuration.
- The extension submits prompts to the logged-in ChatGPT browser session.

## Attribution

`apps/dictara` is based on the open-source Dictara project by Vitalii Zinchenko. The original license is preserved at `apps/dictara/LICENSE`.

