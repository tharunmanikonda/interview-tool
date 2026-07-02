# GPTDisguise Docs Server

Local realtime Docs-style viewer server for GPTDisguise Live Assist.

```bash
pnpm dev:docs
```

The server runs on `http://127.0.0.1:8787`.

- `POST /api/sessions` creates a session for the extension.
- `GET /api/sessions/:viewToken` loads the latest read-only snapshot.
- `GET /s/:viewToken` opens the viewer.
- `ws://127.0.0.1:8787/api/sessions/:sessionId/publish?token=...` accepts extension snapshots.
- `ws://127.0.0.1:8787/api/sessions/:viewToken/view` streams read-only updates.
