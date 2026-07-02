import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  applyEncodedYUpdate,
  encodeYState,
  snapshotFromYDoc,
  yDocFromEncodedState
} from "@gptdisguise/live-doc-core";
import {
  LiveDocPublishMessage,
  LiveDocServerEvent,
  LiveDocSession,
  LiveDocSnapshot
} from "@gptdisguise/protocol";

const PORT = Number(process.env.GPTD_DOCS_PORT || 8787);
const HOST = process.env.GPTD_DOCS_HOST || "127.0.0.1";
const DATA_DIR = process.env.GPTD_DOCS_DATA_DIR || join(process.cwd(), ".data");
const DB_PATH = join(DATA_DIR, "docs.sqlite");
const JSON_PATH = join(DATA_DIR, "docs-store.json");
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../public");

type StoredSession = LiveDocSession & {
  snapshot?: LiveDocSnapshot;
  yState?: string;
  sequence: number;
  events: LiveDocServerEvent[];
};

type SessionStore = {
  init(): Promise<void>;
  create(chatConversationId: string, origin: string): Promise<StoredSession>;
  getByViewToken(viewToken: string): Promise<StoredSession | undefined>;
  getBySessionId(sessionId: string): Promise<StoredSession | undefined>;
  saveSnapshot(sessionId: string, snapshot: LiveDocSnapshot, event: LiveDocServerEvent): Promise<StoredSession | undefined>;
  saveYState(sessionId: string, yState: string, snapshot: LiveDocSnapshot | undefined, event: LiveDocServerEvent): Promise<StoredSession | undefined>;
};

const viewerSockets = new Map<string, Set<WebSocket>>();
let store: SessionStore;

async function main() {
  store = await createStore();
  await store.init();

  const server = createServer(handleRequest);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      void handleSocket(ws, request);
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`GPTDisguise docs server running at http://${HOST}:${PORT}`);
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);

    if (request.method === "OPTIONS") {
      sendCors(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJson<{ chatConversationId?: string }>(request);
      const session = await store.create(body.chatConversationId || "unknown", requestOrigin(request));
      sendJson(response, 201, session);
      return;
    }

    const snapshotMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (request.method === "GET" && snapshotMatch) {
      const session = await store.getByViewToken(snapshotMatch[1]);
      if (!session) {
        sendJson(response, 404, { error: "Session not found." });
        return;
      }
      sendJson(response, 200, {
        session: publicSession(session),
        yState: session.yState,
        snapshot: session.snapshot
      });
      return;
    }

    if (request.method === "GET" && /^\/s\/[^/]+$/.test(url.pathname)) {
      await sendFile(response, join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
      return;
    }

    if (request.method === "GET" && url.pathname === "/viewer.js") {
      await sendFile(response, join(PUBLIC_DIR, "assets/viewer.js"), "text/javascript; charset=utf-8");
      return;
    }

    if (request.method === "GET" && (url.pathname === "/viewer.css" || url.pathname === "/assets/viewer.css")) {
      await sendFile(response, join(PUBLIC_DIR, "viewer.css"), "text/css; charset=utf-8");
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
      await sendFile(response, join(PUBLIC_DIR, url.pathname.slice(1)), contentType(url.pathname));
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Server error." });
  }
}

async function handleSocket(socket: WebSocket, request: IncomingMessage) {
  const url = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);
  const publishMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/publish$/);
  const viewMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/view$/);

  if (publishMatch) {
    await handlePublishSocket(socket, publishMatch[1], url.searchParams.get("token") || "");
    return;
  }

  if (viewMatch) {
    await handleViewSocket(socket, viewMatch[1]);
    return;
  }

  socket.close(1008, "Unknown websocket route");
}

async function handlePublishSocket(socket: WebSocket, sessionId: string, token: string) {
  const session = await store.getBySessionId(sessionId);
  if (!session || session.publishToken !== token) {
    socket.close(1008, "Invalid publish token");
    return;
  }

  socket.send(JSON.stringify(serverEvent(sessionId, session.sequence, "session_ready", { yState: session.yState, snapshot: session.snapshot })));

  socket.on("message", (raw) => {
    void (async () => {
      const message = parseJson<LiveDocPublishMessage>(raw.toString());
      if (!message) return;
      if (message.type === "ping") return;

      const nextSequence = (await store.getBySessionId(sessionId))?.sequence ?? session.sequence;
      const current = await store.getBySessionId(sessionId);

      if (message.type === "y_state") {
        const snapshot = message.snapshot || snapshotFromYDoc(yDocFromEncodedState(message.yState));
        const event = serverEvent(sessionId, nextSequence + 1, "y_state", { yState: message.yState, snapshot });
        const updated = await store.saveYState(sessionId, message.yState, snapshot, event);
        if (updated) broadcast(sessionId, event);
        return;
      }

      if (message.type === "y_update") {
        const doc = yDocFromEncodedState(current?.yState, current?.snapshot);
        applyEncodedYUpdate(doc, message.yUpdate);
        const yState = encodeYState(doc);
        const snapshot = message.snapshot || snapshotFromYDoc(doc);
        const event = serverEvent(sessionId, nextSequence + 1, "y_update", { yUpdate: message.yUpdate });
        const updated = await store.saveYState(sessionId, yState, snapshot, event);
        if (updated) broadcast(sessionId, event);
        return;
      }

      if (message.type === "snapshot_replace") {
        const snapshot = {
          ...message.snapshot,
          sessionId,
          updatedAt: Date.now()
        };
        const doc = yDocFromEncodedState(undefined, snapshot);
        const yState = encodeYState(doc);
        const event = serverEvent(sessionId, nextSequence + 1, "snapshot_replace", { snapshot, yState });
        const updated = await store.saveYState(sessionId, yState, snapshot, event);
        if (updated) broadcast(sessionId, event);
      }
    })();
  });
}

async function handleViewSocket(socket: WebSocket, viewToken: string) {
  const session = await store.getByViewToken(viewToken);
  if (!session) {
    socket.close(1008, "Session not found");
    return;
  }

  const sockets = viewerSockets.get(session.sessionId) || new Set<WebSocket>();
  sockets.add(socket);
  viewerSockets.set(session.sessionId, sockets);

  socket.send(JSON.stringify(serverEvent(session.sessionId, session.sequence, "session_ready", { yState: session.yState, snapshot: session.snapshot })));
  broadcastPresence(session.sessionId);

  socket.on("close", () => {
    sockets.delete(socket);
    broadcastPresence(session.sessionId);
  });
}

function broadcast(sessionId: string, event: LiveDocServerEvent) {
  const sockets = viewerSockets.get(sessionId);
  if (!sockets) return;
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }
}

function broadcastPresence(sessionId: string) {
  const sockets = viewerSockets.get(sessionId);
  const event = serverEvent(sessionId, Date.now(), "viewer_presence_update", { viewers: sockets?.size || 0 });
  broadcast(sessionId, event);
}

async function createStore(): Promise<SessionStore> {
  await mkdir(DATA_DIR, { recursive: true });
  const sqlite = await createSqliteStore().catch(() => undefined);
  return sqlite || new JsonSessionStore(JSON_PATH);
}

async function createSqliteStore(): Promise<SessionStore> {
  const runtimeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<{
    DatabaseSync: new (path: string) => SqliteDatabase;
  }>;
  const { DatabaseSync } = await runtimeImport("node:sqlite");
  return new SqliteSessionStore(new DatabaseSync(DB_PATH));
}

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: unknown[]): void;
    get(...values: unknown[]): Record<string, unknown> | undefined;
  };
};

class SqliteSessionStore implements SessionStore {
  constructor(private db: SqliteDatabase) {}

  async init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        publish_token TEXT NOT NULL,
        view_token TEXT NOT NULL UNIQUE,
        chat_conversation_id TEXT NOT NULL,
        view_url TEXT NOT NULL,
        y_state TEXT,
        snapshot_json TEXT,
        sequence INTEGER NOT NULL,
        events_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN y_state TEXT");
    } catch {
      // Existing databases already have the column.
    }
  }

  async create(chatConversationId: string, origin: string) {
    const now = Date.now();
    const session: StoredSession = {
      sessionId: createId("sess"),
      publishToken: createToken(),
      viewToken: createToken(),
      viewUrl: "",
      chatConversationId,
      sequence: 0,
      events: [],
      createdAt: now,
      updatedAt: now
    };
    session.viewUrl = `${origin}/s/${session.viewToken}`;
    this.db.prepare(`
      INSERT INTO sessions (
        session_id,
        publish_token,
        view_token,
        chat_conversation_id,
        view_url,
        y_state,
        snapshot_json,
        sequence,
        events_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.sessionId,
      session.publishToken,
      session.viewToken,
      session.chatConversationId,
      session.viewUrl,
      null,
      null,
      session.sequence,
      JSON.stringify(session.events),
      session.createdAt,
      session.updatedAt
    );
    return session;
  }

  async getByViewToken(viewToken: string) {
    return this.rowToSession(this.db.prepare("SELECT * FROM sessions WHERE view_token = ?").get(viewToken));
  }

  async getBySessionId(sessionId: string) {
    return this.rowToSession(this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId));
  }

  async saveSnapshot(sessionId: string, snapshot: LiveDocSnapshot, event: LiveDocServerEvent) {
    const session = await this.getBySessionId(sessionId);
    if (!session) return undefined;
    const events = [...session.events, event].slice(-500);
    const updatedAt = Date.now();
    this.db.prepare("UPDATE sessions SET snapshot_json = ?, sequence = ?, events_json = ?, updated_at = ? WHERE session_id = ?").run(
      JSON.stringify(snapshot),
      event.sequence,
      JSON.stringify(events),
      updatedAt,
      sessionId
    );
    return { ...session, snapshot, events, sequence: event.sequence, updatedAt };
  }

  async saveYState(sessionId: string, yState: string, snapshot: LiveDocSnapshot | undefined, event: LiveDocServerEvent) {
    const session = await this.getBySessionId(sessionId);
    if (!session) return undefined;
    const events = [...session.events, event].slice(-500);
    const updatedAt = Date.now();
    this.db.prepare("UPDATE sessions SET y_state = ?, snapshot_json = ?, sequence = ?, events_json = ?, updated_at = ? WHERE session_id = ?").run(
      yState,
      snapshot ? JSON.stringify(snapshot) : null,
      event.sequence,
      JSON.stringify(events),
      updatedAt,
      sessionId
    );
    return { ...session, yState, snapshot, events, sequence: event.sequence, updatedAt };
  }

  private rowToSession(row?: Record<string, unknown>): StoredSession | undefined {
    if (!row) return undefined;
    const snapshotJson = row.snapshot_json as string | null;
    return {
      sessionId: row.session_id as string,
      publishToken: row.publish_token as string,
      viewToken: row.view_token as string,
      viewUrl: row.view_url as string,
      chatConversationId: row.chat_conversation_id as string,
      yState: row.y_state as string | undefined,
      snapshot: snapshotJson ? JSON.parse(snapshotJson) as LiveDocSnapshot : undefined,
      sequence: Number(row.sequence || 0),
      events: JSON.parse((row.events_json as string) || "[]") as LiveDocServerEvent[],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }
}

class JsonSessionStore implements SessionStore {
  private sessions = new Map<string, StoredSession>();

  constructor(private path: string) {}

  async init() {
    const raw = await readFile(this.path, "utf8").catch(() => "");
    if (!raw) return;
    const parsed = JSON.parse(raw) as StoredSession[];
    parsed.forEach((session) => this.sessions.set(session.sessionId, session));
  }

  async create(chatConversationId: string, origin: string) {
    const now = Date.now();
    const session: StoredSession = {
      sessionId: createId("sess"),
      publishToken: createToken(),
      viewToken: createToken(),
      viewUrl: "",
      chatConversationId,
      sequence: 0,
      events: [],
      createdAt: now,
      updatedAt: now
    };
    session.viewUrl = `${origin}/s/${session.viewToken}`;
    this.sessions.set(session.sessionId, session);
    await this.flush();
    return session;
  }

  async getByViewToken(viewToken: string) {
    return [...this.sessions.values()].find((session) => session.viewToken === viewToken);
  }

  async getBySessionId(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  async saveSnapshot(sessionId: string, snapshot: LiveDocSnapshot, event: LiveDocServerEvent) {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const updated: StoredSession = {
      ...session,
      snapshot,
      sequence: event.sequence,
      events: [...session.events, event].slice(-500),
      updatedAt: Date.now()
    };
    this.sessions.set(sessionId, updated);
    await this.flush();
    return updated;
  }

  async saveYState(sessionId: string, yState: string, snapshot: LiveDocSnapshot | undefined, event: LiveDocServerEvent) {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const updated: StoredSession = {
      ...session,
      yState,
      snapshot,
      sequence: event.sequence,
      events: [...session.events, event].slice(-500),
      updatedAt: Date.now()
    };
    this.sessions.set(sessionId, updated);
    await this.flush();
    return updated;
  }

  private async flush() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify([...this.sessions.values()], null, 2), "utf8");
  }
}

function serverEvent(
  sessionId: string,
  sequence: number,
  type: LiveDocServerEvent["type"],
  payload: Partial<LiveDocServerEvent> = {}
): LiveDocServerEvent {
  return {
    type,
    sessionId,
    sequence,
    createdAt: Date.now(),
    ...payload
  };
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as T : {} as T;
}

function parseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  response.end(JSON.stringify(value));
}

function sendCors(response: ServerResponse) {
  response.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  response.end();
}

async function sendFile(response: ServerResponse, path: string, type: string) {
  const content = await readFile(path);
  response.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store, max-age=0"
  });
  response.end(content);
}

function publicSession(session: StoredSession) {
  return {
    sessionId: session.sessionId,
    viewToken: session.viewToken,
    viewUrl: session.viewUrl,
    chatConversationId: session.chatConversationId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

function requestOrigin(request: IncomingMessage) {
  const host = request.headers.host || `${HOST}:${PORT}`;
  return `http://${host}`;
}

function contentType(path: string) {
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function createId(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function createToken() {
  return randomBytes(18).toString("base64url");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
