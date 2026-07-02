import * as Y from "yjs";
import {
  LiveDocAttachment,
  LiveDocLatency,
  LiveDocSnapshot,
  LiveDocStatus,
  LiveDocTheme,
  LiveDocTurn,
  LiveDocViewMode
} from "@gptdisguise/protocol";

export type LiveDocYDoc = Y.Doc;

type LiveDocMeta = {
  schemaVersion: 1;
  sessionId: string;
  chatConversationId: string;
  title: string;
  theme: LiveDocTheme;
  viewMode: LiveDocViewMode;
  activeTurnId?: string;
  updatedAt: number;
};

const DEFAULT_STATUS: LiveDocStatus = {
  chatGpt: "checking",
  dictara: "disconnected",
  capture: "off",
  answer: "idle"
};

const DEFAULT_LATENCY: LiveDocLatency = { status: "idle" };

export function createLiveDoc() {
  return new Y.Doc();
}

export function applySnapshotToYDoc(doc: Y.Doc, snapshot: LiveDocSnapshot) {
  doc.transact(() => {
    const meta = doc.getMap<unknown>("meta");
    const partial = doc.getMap<unknown>("partial");
    const status = doc.getMap<unknown>("status");
    const latency = doc.getMap<unknown>("latency");
    const turns = doc.getMap<Y.Map<unknown>>("turns");
    const turnOrder = doc.getArray<string>("turnOrder");

    setJson(meta, {
      schemaVersion: snapshot.schemaVersion,
      sessionId: snapshot.sessionId,
      chatConversationId: snapshot.chatConversationId,
      title: snapshot.title,
      theme: snapshot.theme,
      viewMode: snapshot.viewMode,
      activeTurnId: latestLiveTurnId(snapshot),
      updatedAt: snapshot.updatedAt
    } satisfies LiveDocMeta);
    setJson(status, snapshot.status);
    setJson(latency, snapshot.latency);
    setJson(partial, { text: snapshot.partialQuestion || "" });

    syncStringArray(turnOrder, snapshot.turns.map((turn) => turn.id));
    const seen = new Set(snapshot.turns.map((turn) => turn.id));
    for (const key of Array.from(turns.keys())) {
      if (!seen.has(key)) turns.delete(key);
    }

    for (const turn of snapshot.turns) {
      syncTurn(turns, turn);
    }
  }, "snapshot");
}

export function snapshotToYDoc(snapshot: LiveDocSnapshot) {
  const doc = createLiveDoc();
  applySnapshotToYDoc(doc, snapshot);
  return doc;
}

export function snapshotFromYDoc(doc: Y.Doc): LiveDocSnapshot {
  const meta = mapToObject<LiveDocMeta>(doc.getMap("meta"));
  const partial = mapToObject<{ text?: string }>(doc.getMap("partial"));
  const status = mapToObject<LiveDocStatus>(doc.getMap("status"));
  const latency = mapToObject<LiveDocLatency>(doc.getMap("latency"));
  const turns = doc.getMap<Y.Map<unknown>>("turns");
  const turnOrder = doc.getArray<string>("turnOrder").toArray();

  return {
    schemaVersion: 1,
    sessionId: meta.sessionId || "",
    chatConversationId: meta.chatConversationId || "unknown",
    title: meta.title || "Interview Notes",
    theme: meta.theme || "dark",
    viewMode: meta.viewMode || "reader",
    turns: turnOrder.map((turnId) => turnFromYMap(turnId, turns.get(turnId))).filter((turn): turn is LiveDocTurn => Boolean(turn)),
    partialQuestion: partial.text || undefined,
    status: { ...DEFAULT_STATUS, ...status },
    latency: { ...DEFAULT_LATENCY, ...latency },
    updatedAt: meta.updatedAt || Date.now()
  };
}

export function encodeYState(doc: Y.Doc) {
  return bytesToBase64(Y.encodeStateAsUpdate(doc));
}

export function encodeYUpdate(update: Uint8Array) {
  return bytesToBase64(update);
}

export function applyEncodedYState(doc: Y.Doc, state: string) {
  if (!state) return;
  Y.applyUpdate(doc, base64ToBytes(state), "remote-state");
}

export function applyEncodedYUpdate(doc: Y.Doc, update: string) {
  if (!update) return;
  Y.applyUpdate(doc, base64ToBytes(update), "remote-update");
}

export function yDocFromEncodedState(state?: string, fallbackSnapshot?: LiveDocSnapshot) {
  const doc = createLiveDoc();
  if (state) {
    applyEncodedYState(doc, state);
  } else if (fallbackSnapshot) {
    applySnapshotToYDoc(doc, fallbackSnapshot);
  }
  return doc;
}

function syncTurn(turns: Y.Map<Y.Map<unknown>>, turn: LiveDocTurn) {
  let map = turns.get(turn.id);
  if (!map) {
    map = new Y.Map<unknown>();
    map.set("answerText", new Y.Text());
    turns.set(turn.id, map);
  }

  map.set("id", turn.id);
  map.set("question", turn.question || "");
  map.set("starter", turn.starter || "");
  map.set("answerHtml", turn.answerHtml || "");
  map.set("questionAttachments", turn.questionAttachments || []);
  map.set("answerAttachments", turn.answerAttachments || []);
  map.set("createdAt", turn.createdAt);
  map.set("updatedAt", turn.updatedAt);

  let answerText = map.get("answerText") as Y.Text | undefined;
  if (!answerText) {
    answerText = new Y.Text();
    map.set("answerText", answerText);
  }
  syncYText(answerText, turn.answer || "");
}

function turnFromYMap(id: string, map?: Y.Map<unknown>): LiveDocTurn | undefined {
  if (!map) return undefined;
  const answerText = map.get("answerText") as Y.Text | undefined;
  return {
    id,
    question: stringValue(map.get("question")),
    starter: optionalString(map.get("starter")),
    answer: answerText?.toString() || "",
    answerHtml: optionalString(map.get("answerHtml")),
    questionAttachments: attachmentArray(map.get("questionAttachments")),
    answerAttachments: attachmentArray(map.get("answerAttachments")),
    createdAt: numberValue(map.get("createdAt")),
    updatedAt: numberValue(map.get("updatedAt"))
  };
}

function syncYText(text: Y.Text, next: string) {
  const current = text.toString();
  if (current === next) return;

  let prefix = 0;
  while (prefix < current.length && prefix < next.length && current[prefix] === next[prefix]) prefix += 1;

  let currentSuffix = current.length;
  let nextSuffix = next.length;
  while (currentSuffix > prefix && nextSuffix > prefix && current[currentSuffix - 1] === next[nextSuffix - 1]) {
    currentSuffix -= 1;
    nextSuffix -= 1;
  }

  if (currentSuffix > prefix) text.delete(prefix, currentSuffix - prefix);
  if (nextSuffix > prefix) text.insert(prefix, next.slice(prefix, nextSuffix));
}

function syncStringArray(array: Y.Array<string>, next: string[]) {
  const current = array.toArray();
  if (current.length === next.length && current.every((value, index) => value === next[index])) return;
  if (array.length) array.delete(0, array.length);
  if (next.length) array.insert(0, next);
}

function latestLiveTurnId(snapshot: LiveDocSnapshot) {
  if (!["waiting", "streaming"].includes(snapshot.status.answer)) return undefined;
  return snapshot.turns.at(-1)?.id;
}

function setJson(map: Y.Map<unknown>, value: Record<string, unknown>) {
  for (const key of Array.from(map.keys())) {
    if (!(key in value)) map.delete(key);
  }
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) map.set(key, item);
  }
}

function mapToObject<T>(map: Y.Map<unknown>): Partial<T> {
  return Object.fromEntries(Array.from(map.entries())) as Partial<T>;
}

function attachmentArray(value: unknown): LiveDocAttachment[] | undefined {
  return Array.isArray(value) ? value as LiveDocAttachment[] : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
