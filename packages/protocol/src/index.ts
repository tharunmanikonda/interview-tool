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
  | "chunk_transcribed"
  | "starter_updated"
  | "question_finalized"
  | "capture_stopped"
  | "transcription_error";

export type HelperCommandType =
  | "start_capture"
  | "stop_capture"
  | "finalize_question"
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
    buffer,
    starter: buildStarterFromTranscript(buffer)
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

export function buildStarterFromTranscript(text: string): string {
  const lower = text.toLowerCase();
  const isYesNo = /^(would|do|does|did|can|could|should|is|are|will)\b/.test(lower);
  const technical =
    /(redis|cache|database|index|api|scale|latency|consistency|security|auth|oauth|postgres|kubernetes|system design|queue|event)/.test(
      lower
    );

  if (isYesNo && technical) {
    return "Yes, I’d answer directly first, then frame the tradeoff and constraint.";
  }

  if (technical) {
    return "I’d approach this by separating the requirement, the tradeoff, and the implementation path.";
  }

  return "That’s a good question. I’d start by clarifying the main goal, then answer with the key reasoning.";
}

function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
