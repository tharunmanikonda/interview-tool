import "dotenv/config";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  DEFAULT_CHUNK_DURATION_MS,
  DEFAULT_CHUNK_OVERLAP_MS,
  HelperCommand,
  HelperEvent,
  NATIVE_BRIDGE_PATH,
  NATIVE_BRIDGE_PORT,
  TranscriptionEngine,
  appendTranscriptChunk,
  createEmptyRollingQuestion
} from "@gptdisguise/protocol";

const chunkDurationMs = readNumber("CHUNK_DURATION_MS", DEFAULT_CHUNK_DURATION_MS);
const chunkOverlapMs = readNumber("CHUNK_OVERLAP_MS", DEFAULT_CHUNK_OVERLAP_MS);
const defaultEngine = readEngine(process.env.TRANSCRIPTION_ENGINE);

const server = createServer();
const wss = new WebSocketServer({ noServer: true });
const sessions = new Map<WebSocket, RollingCaptureSession>();

server.on("upgrade", (request, socket, head) => {
  if (request.url !== NATIVE_BRIDGE_PATH) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  const session = new RollingCaptureSession(ws, defaultEngine);
  sessions.set(ws, session);

  session.emit({
    type: "helper_ready",
    engine: session.engine,
    chunkDurationMs,
    chunkOverlapMs,
    completedAt: Date.now()
  });

  ws.on("message", (raw) => {
    try {
      const command = JSON.parse(raw.toString()) as HelperCommand;
      session.handle(command);
    } catch (error) {
      session.emit({
        type: "transcription_error",
        error: error instanceof Error ? error.message : "Invalid command",
        completedAt: Date.now()
      });
    }
  });

  ws.on("close", () => {
    session.stop();
    sessions.delete(ws);
  });
});

server.listen(NATIVE_BRIDGE_PORT, "127.0.0.1", () => {
  console.log(`[native-helper] listening on ws://127.0.0.1:${NATIVE_BRIDGE_PORT}${NATIVE_BRIDGE_PATH}`);
});

class RollingCaptureSession {
  private sessionId?: string;
  private rolling = createEmptyRollingQuestion();
  private timer?: NodeJS.Timeout;
  private chunkIndex = 0;

  constructor(
    private ws: WebSocket,
    public engine: TranscriptionEngine
  ) {}

  handle(command: HelperCommand) {
    switch (command.type) {
      case "start_capture":
        this.start(command);
        break;
      case "stop_capture":
        this.stop();
        break;
      case "finalize_question":
        this.finalize();
        break;
      case "cancel_question":
        this.cancel();
        break;
      case "set_engine":
        if (command.engine) this.engine = command.engine;
        this.emit({ type: "helper_ready", engine: this.engine, completedAt: Date.now() });
        break;
    }
  }

  start(command: HelperCommand) {
    this.stopTimer();
    this.sessionId = command.sessionId || `session-${Date.now()}`;
    this.rolling = createEmptyRollingQuestion(this.sessionId);
    this.chunkIndex = 0;

    this.emit({
      type: "capture_started",
      sessionId: this.sessionId,
      engine: this.engine,
      startedAt: Date.now(),
      chunkDurationMs,
      chunkOverlapMs
    });

    this.startChunkLoop();
  }

  stop() {
    this.stopTimer();
    this.emit({
      type: "capture_stopped",
      sessionId: this.sessionId,
      engine: this.engine,
      completedAt: Date.now()
    });
  }

  finalize() {
    this.stopTimer();
    this.emit({
      type: "question_finalized",
      sessionId: this.sessionId,
      text: this.rolling.buffer,
      isFinal: true,
      engine: this.engine,
      completedAt: Date.now()
    });
    this.rolling = createEmptyRollingQuestion(this.sessionId);
  }

  cancel() {
    this.stopTimer();
    this.rolling = createEmptyRollingQuestion(this.sessionId);
    this.emit({
      type: "capture_stopped",
      sessionId: this.sessionId,
      engine: this.engine,
      completedAt: Date.now()
    });
  }

  emit(event: HelperEvent) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(event));
  }

  private startChunkLoop() {
    this.startChunk();
    this.timer = setInterval(() => this.startChunk(), chunkDurationMs);
  }

  private startChunk() {
    const chunkId = `chunk-${++this.chunkIndex}`;
    const startedAt = Date.now();
    this.emit({
      type: "chunk_recording_started",
      sessionId: this.sessionId,
      chunkId,
      engine: this.engine,
      startedAt
    });

    // Placeholder for Dictara integration.
    // The real implementation records audio, transcribes it, and emits the transcript below.
    const simulated = process.env.SIMULATED_TRANSCRIPT_CHUNKS?.split("|")[this.chunkIndex - 1]?.trim();
    if (!simulated) return;

    const completedAt = Date.now();
    const event: HelperEvent = {
      type: "chunk_transcribed",
      sessionId: this.sessionId,
      chunkId,
      text: simulated,
      isFinal: false,
      engine: this.engine,
      startedAt,
      completedAt
    };
    this.rolling = appendTranscriptChunk(this.rolling, event);
    this.emit(event);
    this.emit({
      type: "starter_updated",
      sessionId: this.sessionId,
      text: this.rolling.buffer,
      starter: this.rolling.starter,
      engine: this.engine,
      completedAt
    });
  }

  private stopTimer() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

function readNumber(key: string, fallback: number) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readEngine(value?: string): TranscriptionEngine {
  return value === "api" ? "api" : "local";
}
