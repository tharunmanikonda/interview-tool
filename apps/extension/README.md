# GPTDisguise Live Assist

Standalone Chrome extension MVP for a live interview-assist loop on ChatGPT.

## What It Proves

- Capture typed, microphone, and Chrome tab-audio input.
- Show partial transcript and a provisional starter line quickly.
- Build a full-context prompt from prior answer, spoken candidate text, and the latest interviewer question.
- Send the prompt into the logged-in ChatGPT browser UI.
- Mirror the streamed ChatGPT answer into a Google Docs-style overlay.

## Run Locally

```bash
pnpm install
pnpm dev
```

Then load the generated extension in Chrome and open `https://chatgpt.com/`.

## V1 Constraints

- The microphone never starts automatically; the user must press Start.
- Tab audio capture requires Chrome extension permission and may fail depending on the active tab and browser policy.
- ChatGPT browser automation depends on the current ChatGPT page structure. If selectors change, the overlay shows a connection warning.
- Browser speech recognition availability varies by Chrome profile, OS, and language settings.

## Suggested Test Script

1. Open ChatGPT and start the extension overlay.
2. Use typed input: `Explain Redis caching for a read-heavy API.`
3. Submit to ChatGPT and confirm answer mirroring.
4. Add candidate-spoken text: `I said Redis stores hot reads in memory.`
5. Add follow-up: `How would you handle cache invalidation?`
6. Confirm the second prompt references the prior answer and what was actually said.
