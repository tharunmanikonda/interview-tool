# Agent Guide

Use this guide when working on Interview Tool.

## Product Mental Model

The product has two active parts:

1. `apps/extension` renders a Google Docs-style interface on top of ChatGPT and automates the ChatGPT web composer.
2. `apps/dictara` records microphone audio, transcribes it, and pastes rolling chunks into the extension capture field.

The target loop is:

```text
Dictara paste -> rolling question buffer -> short starter -> full final prompt -> ChatGPT answer -> document card
```

Do not replace the current answer engine with an API backend unless explicitly requested. V1 intentionally uses the logged-in ChatGPT browser page.

## High-Value Files

- `apps/extension/entrypoints/content.tsx`
  - Main overlay UI.
  - Dictara paste capture.
  - Chunk/finalize flow.
  - Latency state.
  - ChatGPT send scheduling.

- `apps/extension/src/liveAssist.ts`
  - Conversation state machine.
  - Starter prompt builder.
  - Final prompt builder.
  - Queued follow-up handling.
  - Hydration state.

- `apps/extension/src/chatgptAdapter.ts`
  - Composer discovery.
  - Prompt insertion.
  - Send button clicking.
  - Assistant answer observation.
  - Conversation hydration from ChatGPT DOM.

- `apps/extension/src/content.css`
  - Docs-style layout.
  - Card rendering.
  - Toolbar/left rail styling.

- `apps/dictara/src-tauri/src/keyboard_listener.rs`
  - Fn and Fn+Space behavior.
  - Push-to-talk vs hands-free rolling mode.

- `apps/dictara/src-tauri/src/recording/controller.rs`
  - Recording/transcription state.
  - Rolling restart.
  - Final marker paste behavior.

- `packages/protocol/src/index.ts`
  - Shared event/command schema.

## Common Issues and Fix Strategy

### Dictara transcribes but extension does not receive text

Check:

- Is `Dictara Capture` active?
- Is the extension textarea focused?
- Did Dictara paste into another app?
- Does macOS Accessibility permission include the current Dictara dev binary?

Likely files:

- `apps/extension/entrypoints/content.tsx`
- `apps/dictara/src-tauri/src/text_paster.rs`
- `apps/dictara/src-tauri/src/recording/controller.rs`

### First chunk works but later chunks do not send

Check:

- `pendingStarterQuestionRef`
- `pendingFinalSendRef`
- `activeRequestRef`
- `maybeSendStarterToChatGpt`
- answer stable timer inside `observeLatestAnswer`

Likely file:

- `apps/extension/entrypoints/content.tsx`

### Final question becomes a queued follow-up

The final chunk for the same recording session should use:

```ts
engine.finalizeActiveInterviewerQuestion(...)
```

It should not call the generic `engine.ingestFinal(...)` path for the active interviewer question while a starter is generating.

Likely files:

- `apps/extension/entrypoints/content.tsx`
- `apps/extension/src/liveAssist.ts`

### ChatGPT answers but UI still says waiting

Check:

- `observeLatestAnswer`
- assistant index boundary
- `ignoredAnswerText`
- whether ChatGPT DOM selectors changed

Likely files:

- `apps/extension/src/chatgptAdapter.ts`
- `apps/extension/entrypoints/content.tsx`

### Prompt text appears inside the question card after refresh

Hydration must extract only the current/partial question from the full ChatGPT prompt.

Check:

- `extractQuestionFromPrompt`
- `buildHydratedTurns`

Likely file:

- `apps/extension/entrypoints/content.tsx`

### ChatGPT send stops working

ChatGPT often changes its DOM. Do not assume one selector is stable.

Check:

- composer selectors
- send button selectors
- contenteditable behavior
- whether the composer is inside a form

Likely file:

- `apps/extension/src/chatgptAdapter.ts`

## Verification Commands

Run these after extension changes:

```bash
pnpm --filter @gptdisguise/extension typecheck
pnpm --filter @gptdisguise/extension build
```

Run these after protocol changes:

```bash
pnpm typecheck:protocol
pnpm build:protocol
```

Run these after Dictara Rust changes:

```bash
cd apps/dictara/src-tauri
cargo fmt --check
cargo check
```

Run this after Dictara frontend changes:

```bash
pnpm typecheck:dictara:frontend
```

## Manual QA Checklist

- Load unpacked extension from `apps/extension/.output/chrome-mv3`.
- Open `https://chatgpt.com/`.
- Confirm Docs overlay appears.
- Click `Dictara Capture`.
- Start Dictara with `Fn+Space`.
- Speak a short question.
- Confirm the first starter is sent and rendered.
- Continue speaking into a second 10-second chunk.
- Confirm the updated starter is sent or queued.
- Press `Fn+Space` again.
- Confirm the final full question is sent.
- Confirm the answer card stops saying `Waiting for ChatGPT...`.
- Ask a follow-up while an answer is generating.
- Confirm it sends after the current answer stabilizes.
- Refresh the ChatGPT page.
- Confirm existing turns hydrate into cards.

## Do Not Commit

- API keys.
- `.env` files.
- `node_modules`.
- `.output`.
- `.logs`.
- `target`.
- local screenshots or recordings.
- macOS temporary files.

## Style Notes

- Keep the visible UI minimal.
- Avoid adding old browser microphone controls back into the primary toolbar.
- The primary voice path is Dictara rolling paste mode.
- Intermediate starter answers should stay short, around 50 words or fewer.
- Final answers should not use the 50-word starter limit.
- Preserve Dictara license and attribution.

