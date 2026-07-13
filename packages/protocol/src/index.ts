export const NATIVE_BRIDGE_PORT = 43217;
export const NATIVE_BRIDGE_PATH = "/live-assist";
export const NATIVE_BRIDGE_URL = `ws://127.0.0.1:${NATIVE_BRIDGE_PORT}${NATIVE_BRIDGE_PATH}`;
export const DEFAULT_CHUNK_DURATION_MS = 10_000;
export const DEFAULT_CHUNK_OVERLAP_MS = 1_000;

export type TranscriptionEngine = "local" | "api";

export type HelperEventType =
  | "helper_ready"
  | "capture_started"
  | "chunk_recording_started"
  | "transcript_delta"
  | "chunk_transcribed"
  | "starter_updated"
  | "starter_requested"
  | "question_finalized"
  | "buffer_cleared"
  | "realtime_reconnecting"
  | "realtime_reconnected"
  | "realtime_failed"
  | "capture_stopped"
  | "transcription_error";

export type HelperCommandType =
  | "start_capture"
  | "stop_capture"
  | "finalize_question"
  | "clear_buffer"
  | "cancel_question"
  | "set_engine";

export type BridgeBase = {
  sessionId?: string;
  chunkId?: string;
  text?: string;
  isFinal?: boolean;
  startedAt?: number;
  completedAt?: number;
  engine?: TranscriptionEngine;
};

export type HelperEvent = BridgeBase & {
  type: HelperEventType;
  starter?: string;
  error?: string;
  chunkDurationMs?: number;
  chunkOverlapMs?: number;
};

export type HelperCommand = BridgeBase & {
  type: HelperCommandType;
  chunkDurationMs?: number;
  chunkOverlapMs?: number;
};

export type RollingQuestionState = {
  sessionId?: string;
  chunks: Array<{ chunkId: string; text: string; completedAt: number }>;
  buffer: string;
  starter?: string;
};

export type LiveDocTheme = "light" | "dark";
export type LiveDocViewMode = "reader" | "focus";

export type LiveDocAttachment = {
  type: "image" | "file";
  src?: string;
  href?: string;
  name?: string;
  alt?: string;
  kind?: string;
  width?: number;
  height?: number;
};

export type LiveDocTurn = {
  id: string;
  question: string;
  starter?: string;
  answer: string;
  answerHtml?: string;
  questionAttachments?: LiveDocAttachment[];
  answerAttachments?: LiveDocAttachment[];
  createdAt: number;
  updatedAt: number;
};

export type LiveDocStatus = {
  chatGpt: "checking" | "connected" | "lost";
  dictara: "disconnected" | "connecting" | "connected" | "capturing" | "transcribing" | "error";
  capture: "off" | "ready" | "capturing" | "transcribing";
  answer: "idle" | "waiting" | "streaming" | "rendered";
  message?: string;
};

export type LiveDocLatency = {
  status: "idle" | "waiting" | "streaming" | "rendered";
  elapsedMs?: number;
  submittedMs?: number;
  firstAnswerMs?: number;
  totalMs?: number;
};

export type LiveDocSnapshot = {
  schemaVersion: 1;
  sessionId: string;
  chatConversationId: string;
  title: string;
  theme: LiveDocTheme;
  viewMode: LiveDocViewMode;
  turns: LiveDocTurn[];
  partialQuestion?: string;
  status: LiveDocStatus;
  latency: LiveDocLatency;
  updatedAt: number;
};

export type LiveDocSession = {
  sessionId: string;
  publishToken: string;
  viewToken: string;
  viewUrl: string;
  chatConversationId: string;
  createdAt: number;
  updatedAt: number;
};

export type LiveDocServerEventType =
  | "session_ready"
  | "y_state"
  | "y_update"
  | "snapshot_replace"
  | "turn_upsert"
  | "turn_remove"
  | "partial_question_update"
  | "capture_status_update"
  | "answer_status_update"
  | "latency_update"
  | "viewer_presence_update"
  | "session_error";

export type LiveDocServerEvent = {
  type: LiveDocServerEventType;
  sessionId: string;
  sequence: number;
  yState?: string;
  yUpdate?: string;
  snapshot?: LiveDocSnapshot;
  turn?: LiveDocTurn;
  turnId?: string;
  partialQuestion?: string;
  status?: Partial<LiveDocStatus>;
  latency?: LiveDocLatency;
  viewers?: number;
  error?: string;
  createdAt: number;
};

export type LiveDocPublishMessage =
  | { type: "y_state"; yState: string; snapshot?: LiveDocSnapshot }
  | { type: "y_update"; yUpdate: string; snapshot?: LiveDocSnapshot }
  | { type: "snapshot_replace"; snapshot: LiveDocSnapshot }
  | { type: "ping"; createdAt: number };

export function createEmptyRollingQuestion(sessionId?: string): RollingQuestionState {
  return { sessionId, chunks: [], buffer: "" };
}

export function appendTranscriptChunk(state: RollingQuestionState, event: HelperEvent): RollingQuestionState {
  if (!event.text?.trim()) return state;

  const chunkId = event.chunkId || `${Date.now()}`;
  if (state.chunks.some((chunk) => chunk.chunkId === chunkId)) return state;

  const text = event.text.trim();
  const buffer = stitchTranscript(state.buffer, text);
  return {
    sessionId: event.sessionId || state.sessionId,
    chunks: [...state.chunks, { chunkId, text, completedAt: event.completedAt || Date.now() }],
    buffer
  };
}

export function stitchTranscript(existing: string, next: string): string {
  const cleanExisting = normalizeTranscript(existing);
  const cleanNext = normalizeTranscript(next);
  if (!cleanExisting) return cleanNext;
  if (!cleanNext) return cleanExisting;

  const existingWords = cleanExisting.split(" ");
  const nextWords = cleanNext.split(" ");
  const maxOverlap = Math.min(16, existingWords.length, nextWords.length);

  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const tail = existingWords.slice(-overlap).join(" ").toLowerCase();
    const head = nextWords.slice(0, overlap).join(" ").toLowerCase();
    if (tail === head) {
      return `${existingWords.join(" ")} ${nextWords.slice(overlap).join(" ")}`.trim();
    }
  }

  return `${cleanExisting} ${cleanNext}`.trim();
}

function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
