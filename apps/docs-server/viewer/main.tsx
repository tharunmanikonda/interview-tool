import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  applyEncodedYState,
  applyEncodedYUpdate,
  applySnapshotToYDoc,
  createLiveDoc,
  snapshotFromYDoc,
  yDocFromEncodedState
} from "@gptdisguise/live-doc-core";
import { LiveDocShell } from "@gptdisguise/live-doc-ui";
import { LiveDocServerEvent, LiveDocSnapshot } from "@gptdisguise/protocol";

type SessionPayload = {
  yState?: string;
  snapshot?: LiveDocSnapshot;
};

const viewToken = location.pathname.split("/").filter(Boolean).at(-1) || "";

function ViewerApp() {
  const doc = useMemo(() => yDocFromEncodedState(), []);
  const [snapshot, setSnapshot] = useState<LiveDocSnapshot | undefined>(() => snapshotFromYDoc(doc));
  const [connection, setConnection] = useState({ title: "Connecting", detail: "Loading live session", state: "warn" as const });

  useEffect(() => {
    const update = () => setSnapshot(snapshotFromYDoc(doc));
    doc.on("update", update);
    return () => doc.off("update", update);
  }, [doc]);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let cancelled = false;

    async function start() {
      if (!viewToken) {
        setConnection({ title: "Offline", detail: "Missing session token", state: "bad" });
        return;
      }

      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(viewToken)}`);
        if (!response.ok) throw new Error("Live session was not found.");
        const payload = await response.json() as SessionPayload;
        if (payload.snapshot) applySnapshotToYDoc(doc, payload.snapshot);
        else if (payload.yState) applyEncodedYState(doc, payload.yState);
        if (!cancelled) connect();
      } catch (error) {
        setConnection({ title: "Offline", detail: error instanceof Error ? error.message : "Unable to open live session", state: "bad" });
      }
    }

    function connect() {
      setConnection({ title: "Reconnecting", detail: "Opening live connection", state: "warn" });
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${location.host}/api/sessions/${encodeURIComponent(viewToken)}/view`);

      socket.addEventListener("open", () => setConnection({ title: "Live", detail: "Session connected", state: "ok" }));
      socket.addEventListener("message", (event) => applyServerEvent(doc, safeJson(event.data)));
      socket.addEventListener("close", () => {
        if (cancelled) return;
        setConnection({ title: "Offline", detail: "Trying to reconnect", state: "bad" });
        reconnectTimer = window.setTimeout(connect, 1200);
      });
      socket.addEventListener("error", () => setConnection({ title: "Offline", detail: "Connection error", state: "bad" }));
    }

    void start();
    return () => {
      cancelled = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [doc]);

  return <LiveDocShell snapshot={snapshot} connectionTitle={connection.title} connectionDetail={connection.detail} connectionState={connection.state} classNamePrefix="doc" />;
}

function applyServerEvent(doc: ReturnType<typeof createLiveDoc>, event?: LiveDocServerEvent) {
  if (!event) return;
  if ((event.type === "session_ready" || event.type === "y_state") && event.snapshot) {
    applySnapshotToYDoc(doc, event.snapshot);
  } else if ((event.type === "session_ready" || event.type === "y_state") && event.yState) {
    applyEncodedYState(doc, event.yState);
  } else if (event.type === "y_update" && event.yUpdate) {
    applyEncodedYUpdate(doc, event.yUpdate);
  } else if (event.type === "snapshot_replace" && event.snapshot) {
    applySnapshotToYDoc(doc, event.snapshot);
  }
}

function safeJson(raw: string) {
  try {
    return JSON.parse(raw) as LiveDocServerEvent;
  } catch {
    return undefined;
  }
}

createRoot(document.getElementById("app") || document.body).render(<ViewerApp />);
