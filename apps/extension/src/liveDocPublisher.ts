import {
  LiveDocPublishMessage,
  LiveDocSession,
  LiveDocSnapshot
} from "@gptdisguise/protocol";
import {
  applySnapshotToYDoc,
  createLiveDoc,
  encodeYState,
  encodeYUpdate
} from "@gptdisguise/live-doc-core";

export const DEFAULT_DOCS_SERVER_URL = "http://127.0.0.1:8787";

export type LiveDocPublisherStatus = "off" | "creating" | "connecting" | "connected" | "error";

export type StoredLiveDocSession = LiveDocSession & {
  serverUrl: string;
};

export class LiveDocPublisher {
  private socket?: WebSocket;
  private session?: StoredLiveDocSession;
  private latestSnapshot?: LiveDocSnapshot;
  private publishTimer?: number;
  private reconnectTimer?: number;
  private statusHandler?: (status: LiveDocPublisherStatus, message?: string) => void;
  private doc = createLiveDoc();
  private applyingSnapshot = false;
  private suppressYUpdates = false;
  private needsStateSync = true;

  constructor(private serverUrl = DEFAULT_DOCS_SERVER_URL) {
    this.doc.on("update", (update: Uint8Array) => {
      if (!this.applyingSnapshot || this.suppressYUpdates) return;
      this.sendYUpdate(update);
    });
  }

  setStatusHandler(handler: (status: LiveDocPublisherStatus, message?: string) => void) {
    this.statusHandler = handler;
  }

  setServerUrl(serverUrl: string) {
    this.serverUrl = normalizeDocsServerUrl(serverUrl);
  }

  async createSession(chatConversationId: string) {
    this.status("creating", "Creating shared docs session...");
    const response = await fetch(`${this.serverUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatConversationId })
    });
    if (!response.ok) {
      throw new Error("Docs server did not create the session.");
    }
    const session = (await response.json()) as LiveDocSession;
    return { ...session, serverUrl: this.serverUrl };
  }

  connect(session: StoredLiveDocSession) {
    this.disconnect(false);
    this.session = session;
    this.status("connecting", "Connecting shared docs session...");

    const wsUrl = new URL(`/api/sessions/${session.sessionId}/publish`, session.serverUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.searchParams.set("token", session.publishToken);

    const socket = new WebSocket(wsUrl.toString());
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.status("connected", "Shared docs session live.");
      this.needsStateSync = true;
      if (this.latestSnapshot) this.sendSnapshot(this.latestSnapshot, true);
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.status("error", "Shared docs session disconnected.");
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      this.status("error", "Shared docs server is not reachable.");
    });
  }

  publish(snapshot: LiveDocSnapshot) {
    this.latestSnapshot = snapshot;
    if (shouldPublishImmediately(snapshot)) {
      if (this.publishTimer) window.clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
      this.sendSnapshot(snapshot, this.needsStateSync);
      return;
    }

    if (this.publishTimer) window.clearTimeout(this.publishTimer);
    this.publishTimer = window.setTimeout(() => {
      if (this.latestSnapshot) this.sendSnapshot(this.latestSnapshot, this.needsStateSync);
    }, publishDelayForSnapshot(snapshot));
  }

  disconnect(clearSession = true) {
    if (this.publishTimer) window.clearTimeout(this.publishTimer);
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.publishTimer = undefined;
    this.reconnectTimer = undefined;
    this.socket?.close();
    this.socket = undefined;
    if (clearSession) this.session = undefined;
    this.status(clearSession ? "off" : "connecting");
  }

  private sendSnapshot(snapshot: LiveDocSnapshot, asState = false) {
    this.suppressYUpdates = asState;
    this.applyingSnapshot = true;
    try {
      applySnapshotToYDoc(this.doc, snapshot);
    } finally {
      this.applyingSnapshot = false;
      this.suppressYUpdates = false;
    }
    if (asState) this.sendYState();
  }

  private sendYState() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.latestSnapshot) return;
    const message: LiveDocPublishMessage = { type: "y_state", yState: encodeYState(this.doc), snapshot: this.latestSnapshot };
    this.socket.send(JSON.stringify(message));
    this.needsStateSync = false;
  }

  private sendYUpdate(update: Uint8Array) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.latestSnapshot) return;
    const message: LiveDocPublishMessage = { type: "y_update", yUpdate: encodeYUpdate(update) };
    this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect() {
    if (!this.session || this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.session) this.connect(this.session);
    }, 1400);
  }

  private status(status: LiveDocPublisherStatus, message?: string) {
    this.statusHandler?.(status, message);
  }
}

export function defaultDocsServerUrl() {
  return DEFAULT_DOCS_SERVER_URL;
}

export function normalizeDocsServerUrl(serverUrl: string) {
  const value = serverUrl.trim().replace(/\/+$/, "");
  if (!value) return DEFAULT_DOCS_SERVER_URL;
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return value;
  }
}

function publishDelayForSnapshot(snapshot: LiveDocSnapshot) {
  if (snapshot.latency.status === "streaming") return 0;
  if (snapshot.latency.status === "waiting") return 0;
  if (snapshot.partialQuestion) return 0;
  return 90;
}

function shouldPublishImmediately(snapshot: LiveDocSnapshot) {
  return publishDelayForSnapshot(snapshot) === 0;
}
