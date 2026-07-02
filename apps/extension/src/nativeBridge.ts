import { HelperCommand, HelperEvent, NATIVE_BRIDGE_URL, TranscriptionEngine } from "@gptdisguise/protocol";

export type NativeBridgeStatus = "disconnected" | "connecting" | "connected" | "capturing" | "transcribing" | "error";

export type NativeBridgeHandlers = {
  onEvent: (event: HelperEvent) => void;
  onStatus: (status: NativeBridgeStatus, message?: string) => void;
};

export class NativeBridge {
  private socket?: WebSocket;
  private handlers?: NativeBridgeHandlers;

  connect(handlers: NativeBridgeHandlers) {
    this.handlers = handlers;

    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      return;
    }

    handlers.onStatus("connecting", "Connecting to native helper...");
    const socket = new WebSocket(NATIVE_BRIDGE_URL);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.handlers?.onStatus("connected", "Native helper connected.");
    });

    socket.addEventListener("message", (message) => {
      try {
        this.handlers?.onEvent(JSON.parse(message.data) as HelperEvent);
      } catch {
        this.handlers?.onStatus("error", "Native helper sent an unreadable event.");
      }
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.handlers?.onStatus("disconnected", "Native helper disconnected.");
    });

    socket.addEventListener("error", () => {
      this.handlers?.onStatus("error", "Native helper is not reachable.");
    });
  }

  disconnect() {
    this.socket?.close();
    this.socket = undefined;
    this.handlers?.onStatus("disconnected", "Native helper disconnected.");
  }

  send(command: HelperCommand) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.handlers?.onStatus("error", "Native helper is not connected.");
      return false;
    }

    this.socket.send(JSON.stringify(command));
    return true;
  }

  startCapture() {
    return this.send({ type: "start_capture", sessionId: `extension-${Date.now()}` });
  }

  stopCapture() {
    return this.send({ type: "stop_capture" });
  }

  finalizeQuestion() {
    return this.send({ type: "finalize_question" });
  }

  cancelQuestion() {
    return this.send({ type: "cancel_question" });
  }

  setEngine(engine: TranscriptionEngine) {
    return this.send({ type: "set_engine", engine });
  }
}
