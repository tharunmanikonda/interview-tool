import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot,
  FileText,
  Mic,
  MicOff,
  PauseCircle,
  PlayCircle,
  Radio,
  Send,
  Square,
  UserRound,
  Volume2,
  X
} from "lucide-react";
import {
  HelperEvent,
  RollingQuestionState,
  TranscriptionEngine,
  appendTranscriptChunk,
  createEmptyRollingQuestion
} from "@gptdisguise/protocol";
import "../src/content.css";
import { ChatGptAdapter, ChatGptConnectionState, ChatGptConversationTurn } from "../src/chatgptAdapter";
import {
  ConversationEvent,
  ConversationState,
  ConversationTurn,
  InputRole,
  LiveAssistEngine,
  StarterMode
} from "../src/liveAssist";
import { NativeBridge, NativeBridgeStatus } from "../src/nativeBridge";
import { BrowserSpeechProvider, TabAudioCaptureProvider, testMicrophoneAccess } from "../src/speechProviders";

type DebugEntry = {
  id: string;
  message: string;
  createdAt: string;
};

type LatencyState = {
  status: "idle" | "waiting" | "streaming" | "rendered";
  startedAt?: number;
  submittedAt?: number;
  firstAnswerAt?: number;
  lastRenderAt?: number;
};

type ActiveRequest = {
  question: string;
  assistantStartCount: number;
  kind: "starter" | "final";
  ignoredAnswerText?: string;
};

const LIVE_ASSIST_FINALIZE_MARKER = "[[GPTD_LIVE_ASSIST_FINALIZE]]";

export default defineContentScript({
  matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  cssInjectionMode: "ui",
  runAt: "document_idle",
  async main(ctx) {
    await waitForBody();

    async function mountOverlay() {
      if (document.querySelector("[data-gptd-mounted='true']")) return;

      const ui = await createShadowRootUi(ctx, {
        name: "gptdisguise-live-assist",
        position: "inline",
        anchor: "body",
        append: "last",
        onMount(container) {
          const rootNode = container.getRootNode();
          if (rootNode instanceof ShadowRoot && rootNode.host instanceof HTMLElement) {
            rootNode.host.dataset.gptdMounted = "true";
          }

          const mountPoint = document.createElement("div");
          mountPoint.dataset.gptdReactRoot = "true";
          container.append(mountPoint);

          const root = createRoot(mountPoint);
          root.render(<LiveAssistOverlay />);
          return { root, mountPoint };
        },
        onRemove(mounted) {
          mounted?.root.unmount();
          mounted?.mountPoint.remove();
        }
      });

      ui.mount();
    }

    await mountOverlay();

    const observer = new MutationObserver(() => {
      if (!document.body || document.querySelector("[data-gptd-mounted='true']")) return;
      void mountOverlay();
    });

    observer.observe(document.documentElement, { childList: true });
    window.addEventListener("pageshow", () => void mountOverlay());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void mountOverlay();
    });
  }
});

function waitForBody() {
  if (document.body) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.body) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(document.documentElement, { childList: true });
  });
}

function buildHydratedTurns(pageTurns: ChatGptConversationTurn[]) {
  const turns: Array<{ question: string; answer: string; answerHtml?: string }> = [];

  for (const pageTurn of pageTurns) {
    if (pageTurn.role === "user") {
      turns.push({ question: extractQuestionFromPrompt(pageTurn.text), answer: "" });
      continue;
    }

    const latest = turns.at(-1);
    if (latest && !latest.answer) {
      latest.answer = pageTurn.text;
      latest.answerHtml = pageTurn.html;
    } else {
      turns.push({ question: "", answer: pageTurn.text, answerHtml: pageTurn.html });
    }
  }

  return turns.filter((turn) => turn.question || turn.answer);
}

function extractQuestionFromPrompt(text: string) {
  const markers = ["Current interviewer question:", "Partial interviewer question so far:"];
  const marker = markers.find((candidate) => text.includes(candidate));
  if (!marker) return text;

  const markerIndex = text.indexOf(marker);

  const afterMarker = text.slice(markerIndex + marker.length).trim();
  const nextSectionIndex = afterMarker.search(/\n\s*\n[A-Z][^:\n]+:/);
  const section = nextSectionIndex === -1 ? afterMarker : afterMarker.slice(0, nextSectionIndex);
  const cleanupMarkers = [
    "Return only the bridge sentence.",
    "You are helping with a live interview.",
    "Write only one short natural bridge sentence",
    "Keep it neutral, safe, and useful.",
    "Keep the response around 50 words"
  ];
  const cleanupIndex = cleanupMarkers
    .map((candidate) => section.indexOf(candidate))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return (cleanupIndex === undefined ? section : section.slice(0, cleanupIndex)).trim() || text;
}

function LiveAssistOverlay() {
  const adapter = useMemo(() => new ChatGptAdapter(), []);
  const engine = useMemo(() => new LiveAssistEngine(), []);
  const speechProvider = useMemo(() => new BrowserSpeechProvider(), []);
  const tabAudioProvider = useMemo(() => new TabAudioCaptureProvider(), []);
  const nativeBridge = useMemo(() => new NativeBridge(), []);
  const [state, setState] = useState<ConversationState>(() => engine.snapshot());
  const [connection, setConnection] = useState<ChatGptConnectionState>({ status: "checking" });
  const [nativeStatus, setNativeStatus] = useState<NativeBridgeStatus>("disconnected");
  const [nativeEngine, setNativeEngine] = useState<TranscriptionEngine>("local");
  const [rollingQuestion, setRollingQuestion] = useState<RollingQuestionState>(() => createEmptyRollingQuestion());
  const [chunkTimingText, setChunkTimingText] = useState("10s chunks");
  const [isOpen, setIsOpen] = useState(true);
  const [isListening, setIsListening] = useState(false);
  const [isCapturingTab, setIsCapturingTab] = useState(false);
  const [tabLevel, setTabLevel] = useState(0);
  const [typedText, setTypedText] = useState("");
  const [typedRole, setTypedRole] = useState<InputRole>("interviewer");
  const [starterMode, setStarterMode] = useState<StarterMode>("neutral-speculative");
  const [statusText, setStatusText] = useState("Ready");
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [showDebug] = useState(false);
  const [isVoiceCapture, setIsVoiceCapture] = useState(false);
  const [latency, setLatency] = useState<LatencyState>({ status: "idle" });
  const [elapsedMs, setElapsedMs] = useState(0);
  const captureTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const docScrollRef = useRef<HTMLElement | null>(null);
  const flowDebounceRef = useRef<number | undefined>(undefined);
  const focusIntervalRef = useRef<number | undefined>(undefined);
  const lastFlowSubmittedRef = useRef("");
  const nativeStatusRef = useRef<NativeBridgeStatus>("disconnected");
  const rollingQuestionRef = useRef<RollingQuestionState>(createEmptyRollingQuestion());
  const finalizeAfterNextChunkRef = useRef(false);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const answerStableTimerRef = useRef<number | undefined>(undefined);
  const stateRef = useRef<ConversationState>(engine.snapshot());
  const starterSentRef = useRef(false);
  const lastStarterQuestionSentRef = useRef("");
  const pendingStarterQuestionRef = useRef("");
  const pendingFinalSendRef = useRef(false);
  const lastHydratedSignatureRef = useRef("");

  function debug(message: string) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      message,
      createdAt: new Date().toLocaleTimeString()
    };
    setDebugEntries((entries) => [entry, ...entries].slice(0, 8));
  }

  function scrollLatestTurnIntoView() {
    const scroll = docScrollRef.current;
    const latestTurn = scroll?.querySelector<HTMLElement>(".gptd-turn.latest, .gptd-turn:last-child");
    if (!scroll || !latestTurn) return;

    const scrollRect = scroll.getBoundingClientRect();
    const turnRect = latestTurn.getBoundingClientRect();
    const top = scroll.scrollTop + turnRect.top - scrollRect.top;
    scroll.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  function latestAssistantText() {
    return adapter.readConversation().filter((turn) => turn.role === "assistant").at(-1)?.text || "";
  }

  useEffect(() => {
    const unsubscribe = engine.subscribe(setState);
    debug("Overlay mounted");
    return () => {
      unsubscribe();
    };
  }, [engine]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    nativeBridge.connect({
      onStatus: (status, message) => {
        nativeStatusRef.current = status;
        setNativeStatus(status);
        if (message) {
          setStatusText(message);
          debug(message);
        }
      },
      onEvent: handleNativeEvent
    });

    return () => nativeBridge.disconnect();
  }, [nativeBridge, starterMode]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setConnection(adapter.checkConnection());
    }, 1500);
    setConnection(adapter.checkConnection());
    return () => window.clearInterval(interval);
  }, [adapter]);

  useEffect(() => {
    return adapter.observeLatestAnswer((answer) => {
      const activeRequest = activeRequestRef.current;
      if (!activeRequest) return;
      if (answer.index < activeRequest.assistantStartCount && answer.text === activeRequest.ignoredAnswerText) return;

      const now = performance.now();
      setLatency((current) => ({
        ...current,
        status: "streaming",
        firstAnswerAt: current.firstAnswerAt ?? now,
        lastRenderAt: now
      }));
      engine.setAssistantAnswer(answer.text, answer.html);

      if (answerStableTimerRef.current) window.clearTimeout(answerStableTimerRef.current);
      answerStableTimerRef.current = window.setTimeout(() => {
        const hadQueuedFollowUp = stateRef.current.queuedQuestions.length > 0;
        activeRequestRef.current = null;
        engine.markIdle();
        setLatency((current) => ({
          ...current,
          status: "rendered",
          lastRenderAt: performance.now()
        }));
        setStatusText("Answer rendered");

        if (pendingFinalSendRef.current) {
          pendingFinalSendRef.current = false;
          pendingStarterQuestionRef.current = "";
          setStatusText("Starter rendered. Sending full answer prompt...");
          window.setTimeout(() => {
            void sendToChatGpt();
          }, 120);
        } else if (pendingStarterQuestionRef.current) {
          const nextStarterQuestion = pendingStarterQuestionRef.current;
          pendingStarterQuestionRef.current = "";
          setStatusText("Sending updated starter for latest chunk...");
          window.setTimeout(() => {
            void maybeSendStarterToChatGpt(nextStarterQuestion);
          }, 120);
        } else if (hadQueuedFollowUp) {
          setStatusText("Sending queued follow-up to ChatGPT...");
          window.setTimeout(() => {
            void sendToChatGpt();
          }, 120);
        }
      }, 1300);
    });
  }, [adapter, engine]);

  useEffect(() => {
    const hydrate = () => {
      if (activeRequestRef.current) return;
      if (rollingQuestionRef.current.buffer.trim() || typedText.trim()) return;

      const hydratedTurns = buildHydratedTurns(adapter.readConversation());
      if (hydratedTurns.length === 0) return;

      const signature = hydratedTurns.map((turn) => `${turn.question}\n${turn.answer}`).join("\n---\n");
      if (signature === lastHydratedSignatureRef.current) return;

      lastHydratedSignatureRef.current = signature;
      engine.hydrateTurns(hydratedTurns);
      setStatusText("ChatGPT conversation synced");
      debug(`Synced ${hydratedTurns.length} ChatGPT turns`);
    };

    const first = window.setTimeout(hydrate, 600);
    const interval = window.setInterval(hydrate, 1000);
    const observer = new MutationObserver(() => {
      window.setTimeout(hydrate, 120);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
      observer.disconnect();
    };
  }, [adapter, engine, typedText]);

  useEffect(() => {
    if (latency.status !== "waiting" && latency.status !== "streaming") return;

    const interval = window.setInterval(() => {
      if (!latency.startedAt) return;
      setElapsedMs(performance.now() - latency.startedAt);
    }, 100);

    return () => window.clearInterval(interval);
  }, [latency.status, latency.startedAt]);

  useEffect(() => {
    if (state.phase !== "idle" || latency.status !== "streaming") return;
    setLatency((current) => ({ ...current, status: "rendered", lastRenderAt: performance.now() }));
  }, [state.phase, latency.status]);

  useEffect(() => {
    if (state.turns.length === 0) return;
    window.setTimeout(() => {
      scrollLatestTurnIntoView();
    }, 80);
  }, [state.turns.length]);

  useEffect(() => {
    return () => {
      if (flowDebounceRef.current) window.clearTimeout(flowDebounceRef.current);
      if (answerStableTimerRef.current) window.clearTimeout(answerStableTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isVoiceCapture) return;

    const focusTimer = window.setTimeout(() => {
      captureTextareaRef.current?.focus();
    }, 80);

    focusIntervalRef.current = window.setInterval(() => {
      const textarea = captureTextareaRef.current;
      if (!textarea) return;
      if (document.activeElement !== textarea) {
        textarea.focus();
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
      }
    }, 700);

    return () => {
      window.clearTimeout(focusTimer);
      if (focusIntervalRef.current) window.clearInterval(focusIntervalRef.current);
      focusIntervalRef.current = undefined;
    };
  }, [isVoiceCapture]);

  useEffect(() => {
    rollingQuestionRef.current = rollingQuestion;
  }, [rollingQuestion]);

  function toggleVoiceCapture() {
    const next = !isVoiceCapture;
    setIsVoiceCapture(next);
    setTypedRole("interviewer");
    setStatusText(next ? "Dictara Capture ready. Start Dictara rolling mode and keep this cursor focused." : "Dictara Capture stopped");
    debug(next ? "Dictara Capture enabled; focusing capture box" : "Dictara Capture disabled");

    if (next) {
      window.setTimeout(() => {
        const textarea = captureTextareaRef.current;
        textarea?.focus();
        const end = textarea?.value.length || 0;
        textarea?.setSelectionRange(end, end);
      }, 80);
    }
  }

  function handleNativeEvent(event: HelperEvent) {
    debug(`Native event: ${event.type}${event.text ? ` · ${event.text.slice(0, 60)}` : ""}`);

    if (event.engine) setNativeEngine(event.engine);
    if (event.chunkDurationMs) setChunkTimingText(`${Math.round(event.chunkDurationMs / 1000)}s chunks`);

    if (event.type === "helper_ready") {
      setNativeStatus("connected");
      nativeStatusRef.current = "connected";
      setStatusText("Native helper connected.");
      return;
    }

    if (event.type === "capture_started") {
      setNativeStatus("capturing");
      nativeStatusRef.current = "capturing";
      setRollingQuestion(createEmptyRollingQuestion(event.sessionId));
      setStatusText("Rolling capture started.");
      return;
    }

    if (event.type === "chunk_recording_started") {
      setNativeStatus("transcribing");
      nativeStatusRef.current = "transcribing";
      setStatusText(`Recording ${event.chunkId || "next chunk"}...`);
      return;
    }

    if (event.type === "chunk_transcribed" || event.type === "starter_updated") {
      setNativeStatus("capturing");
      nativeStatusRef.current = "capturing";
      setRollingQuestion((current) => {
        const next = event.type === "chunk_transcribed" ? appendTranscriptChunk(current, event) : { ...current, starter: event.starter || current.starter };
        if (next.buffer) engine.ingestPartial("interviewer", next.buffer, starterMode);
        return next;
      });

      if (event.startedAt && event.completedAt) {
        setChunkTimingText(`Chunk ${(event.completedAt - event.startedAt) / 1000}s`);
      }
      setStatusText("Chunk transcribed. Starter updated.");
      return;
    }

    if (event.type === "question_finalized") {
      const question = event.text?.trim();
      if (!question) {
        setStatusText("No question text captured yet.");
        return;
      }

      engine.finalizeActiveInterviewerQuestion(question, starterMode);
      setRollingQuestion(createEmptyRollingQuestion(event.sessionId));
      setStatusText("Question finalized. Sending to ChatGPT...");
      window.setTimeout(() => {
        void sendToChatGpt();
      }, 80);
      return;
    }

    if (event.type === "capture_stopped") {
      setNativeStatus("connected");
      nativeStatusRef.current = "connected";
      setStatusText("Rolling capture stopped.");
      return;
    }

    if (event.type === "transcription_error") {
      setNativeStatus("error");
      nativeStatusRef.current = "error";
      setStatusText(event.error || "Native transcription failed.");
    }
  }

  function toggleNativeCapture() {
    if (nativeStatus === "disconnected" || nativeStatus === "error") {
      nativeBridge.connect({
        onStatus: (status, message) => {
          nativeStatusRef.current = status;
          setNativeStatus(status);
          if (message) setStatusText(message);
        },
        onEvent: handleNativeEvent
      });
      return;
    }

    if (nativeStatus === "capturing" || nativeStatus === "transcribing") {
      nativeBridge.stopCapture();
      return;
    }

    nativeBridge.startCapture();
  }

  function finalizeNativeQuestion() {
    if (rollingQuestionRef.current.buffer.trim() || typedText.trim()) {
      finalizeRollingPasteQuestion();
      return;
    }

    nativeBridge.finalizeQuestion();
  }

  function cancelNativeQuestion() {
    nativeBridge.cancelQuestion();
    if (flowDebounceRef.current) window.clearTimeout(flowDebounceRef.current);
    flowDebounceRef.current = undefined;
    setRollingQuestion(createEmptyRollingQuestion());
    rollingQuestionRef.current = createEmptyRollingQuestion();
    setTypedText("");
    setStatusText("Rolling question cancelled.");
  }

  function handleNativeEngineChange(engineName: TranscriptionEngine) {
    setNativeEngine(engineName);
    nativeBridge.setEngine(engineName);
  }

  function handleCaptureTextChange(value: string) {
    setTypedText(value);

    if (!isVoiceCapture) return;

    const hasFinalizeMarker = value.includes(LIVE_ASSIST_FINALIZE_MARKER);
    const text = value.replace(LIVE_ASSIST_FINALIZE_MARKER, "").trim();
    if (!text && !hasFinalizeMarker) return;

    setStatusText("Dictara pasted a chunk. Adding it to the rolling question...");
    debug(`Dictara paste input: ${text.slice(0, 70)}`);

    if (flowDebounceRef.current) window.clearTimeout(flowDebounceRef.current);
    flowDebounceRef.current = window.setTimeout(() => {
      const rawChunkText = captureTextareaRef.current?.value || "";
      const shouldFinalize = rawChunkText.includes(LIVE_ASSIST_FINALIZE_MARKER) || finalizeAfterNextChunkRef.current;
      const chunkText = rawChunkText.replace(LIVE_ASSIST_FINALIZE_MARKER, "").trim();
      if (!chunkText || chunkText === lastFlowSubmittedRef.current) {
        if (shouldFinalize) {
          setTypedText("");
          finalizeAfterNextChunkRef.current = false;
          window.setTimeout(() => {
            finalizeRollingPasteQuestion();
          }, 80);
        }
        return;
      }

      lastFlowSubmittedRef.current = chunkText;
      appendRollingPasteChunk(chunkText);
      setTypedText("");
      setStatusText(shouldFinalize ? "Final Dictara chunk added. Sending..." : "Dictara chunk added. Continue speaking or press Finalize.");
      debug(`Dictara chunk added as ${typedRole}: ${chunkText.slice(0, 70)}`);

      if (shouldFinalize) {
        finalizeAfterNextChunkRef.current = false;
        window.setTimeout(() => {
          finalizeRollingPasteQuestion();
        }, 80);
      }

      if (isVoiceCapture) {
        window.setTimeout(() => {
          const textarea = captureTextareaRef.current;
          textarea?.focus();
          textarea?.setSelectionRange(0, 0);
        }, 120);
      }
    }, 350);
  }

  function appendRollingPasteChunk(text: string) {
    const event: HelperEvent = {
      type: "chunk_transcribed",
      sessionId: rollingQuestionRef.current.sessionId || `dictara-paste-${Date.now()}`,
      chunkId: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      isFinal: false,
      engine: nativeEngine,
      completedAt: Date.now()
    };

    const next = appendTranscriptChunk(rollingQuestionRef.current, event);
    rollingQuestionRef.current = next;
    setRollingQuestion(next);

    if (next.buffer) {
      engine.ingestPartial(typedRole, next.buffer, starterMode);
      if (typedRole === "interviewer") {
        void maybeSendStarterToChatGpt(next.buffer);
      }
    }
  }

  async function maybeSendStarterToChatGpt(partialQuestion: string) {
    const normalizedQuestion = partialQuestion.trim();
    if (normalizedQuestion.length < 10) return;
    if (normalizedQuestion === lastStarterQuestionSentRef.current) return;
    if (pendingFinalSendRef.current) return;
    if (activeRequestRef.current) {
      pendingStarterQuestionRef.current = normalizedQuestion;
      return;
    }

    starterSentRef.current = true;
    lastStarterQuestionSentRef.current = normalizedQuestion;
    const prompt = engine.buildStarterPromptForQuestion(normalizedQuestion);
    if (!prompt.ok) {
      starterSentRef.current = false;
      lastStarterQuestionSentRef.current = "";
      return;
    }

    const connectionState = adapter.checkConnection();
    setConnection(connectionState);
    if (connectionState.status !== "connected") {
      starterSentRef.current = false;
      lastStarterQuestionSentRef.current = "";
      setStatusText(connectionState.message || "ChatGPT page connection lost.");
      return;
    }

    try {
      const startedAt = performance.now();
      const assistantStartCount = adapter.assistantCount();
      const ignoredAnswerText = latestAssistantText();
      activeRequestRef.current = {
        question: prompt.question,
        assistantStartCount,
        kind: "starter",
        ignoredAnswerText
      };
      setElapsedMs(0);
      setLatency({ status: "waiting", startedAt });
      engine.markGeneratingStarter(prompt.question);
      setStatusText("Sending starter to ChatGPT...");
      await adapter.sendPrompt(prompt.prompt);
      setLatency((current) => ({ ...current, submittedAt: performance.now() }));
      setStatusText("Starter prompt sent to ChatGPT");
    } catch (error) {
      activeRequestRef.current = null;
      starterSentRef.current = false;
      lastStarterQuestionSentRef.current = "";
      engine.markIdle();
      setStatusText(error instanceof Error ? error.message : "Unable to send starter prompt");
      debug(`Starter send exception: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function finalizeRollingPasteQuestion() {
    if (flowDebounceRef.current) {
      window.clearTimeout(flowDebounceRef.current);
      flowDebounceRef.current = undefined;
    }

    const pendingText = captureTextareaRef.current?.value.trim() || typedText.trim();
    if (pendingText && pendingText !== lastFlowSubmittedRef.current) {
      lastFlowSubmittedRef.current = pendingText;
      appendRollingPasteChunk(pendingText);
    }

    const question = rollingQuestionRef.current.buffer.trim();
    if (!question) {
      setStatusText("No Dictara chunks captured yet.");
      return;
    }

    if (typedRole === "interviewer") {
      engine.finalizeActiveInterviewerQuestion(question, starterMode);
    } else {
      engine.ingestFinal(typedRole, question, starterMode);
    }
    setTypedText("");
    setRollingQuestion(createEmptyRollingQuestion());
    rollingQuestionRef.current = createEmptyRollingQuestion();
    lastFlowSubmittedRef.current = "";
    lastStarterQuestionSentRef.current = "";
    pendingStarterQuestionRef.current = "";
    setStatusText(typedRole === "interviewer" ? "Dictara question finalized. Sending to ChatGPT..." : "Dictara question finalized.");
    debug(`Dictara rolling question finalized: ${question.slice(0, 90)}`);

    if (typedRole === "interviewer") {
      starterSentRef.current = false;
      pendingStarterQuestionRef.current = "";
      if (activeRequestRef.current) {
        pendingFinalSendRef.current = true;
        setStatusText("Final question ready. Waiting for starter response to finish...");
      } else {
        window.setTimeout(() => {
          void sendToChatGpt();
        }, 80);
      }
    }
  }

  async function toggleListening() {
    debug(`Mic button clicked. isListening=${isListening}`);
    setStatusText(isListening ? "Stopping microphone..." : "Starting microphone...");

    if (isListening) {
      speechProvider.stop();
      setIsListening(false);
      setStatusText("Microphone stopped");
      debug("Microphone stopped");
      return;
    }

    const support = speechProvider.support();
    debug(`Speech support: ${support.ok ? "ok" : support.reason}`);
    if (!support.ok) {
      const micAccess = await testMicrophoneAccess();
      debug(`Mic access test: ${micAccess.ok ? "ok" : micAccess.reason}`);
      setStatusText(micAccess.ok ? `${support.reason} Typed input still works.` : micAccess.reason);
      return;
    }

    try {
      await speechProvider.start({
        onPartial: (text) => {
          debug(`Speech partial: ${text.slice(0, 60)}`);
          engine.ingestPartial("interviewer", text, starterMode);
        },
        onFinal: (text) => {
          debug(`Speech final: ${text.slice(0, 60)}`);
          engine.ingestFinal("interviewer", text, starterMode);
        },
        onError: (error) => {
          debug(`Speech error: ${error}`);
          setStatusText(error);
          setIsListening(false);
        }
      });
      setIsListening(true);
      setStatusText("Listening through microphone");
      debug("Speech recognition start requested");
    } catch (error) {
      debug(`Mic start exception: ${error instanceof Error ? error.message : String(error)}`);
      setStatusText(error instanceof Error ? error.message : "Unable to start microphone");
    }
  }

  async function toggleTabAudio() {
    debug(`Tab audio button clicked. isCapturingTab=${isCapturingTab}`);
    setStatusText(isCapturingTab ? "Stopping tab audio..." : "Requesting tab audio...");

    if (isCapturingTab) {
      tabAudioProvider.stop();
      setIsCapturingTab(false);
      setTabLevel(0);
      setStatusText("Tab audio stopped");
      debug("Tab audio stopped");
      return;
    }

    try {
      await tabAudioProvider.start({
        onLevel: setTabLevel,
        onError: (error) => {
          debug(`Tab audio error: ${error}`);
          setStatusText(error);
          setIsCapturingTab(false);
          setTabLevel(0);
        }
      });
      setIsCapturingTab(true);
      setStatusText("Tab audio capture active; use typed transcript for v1 transcription");
      debug("Tab audio capture started");
    } catch (error) {
      debug(`Tab audio exception: ${error instanceof Error ? error.message : String(error)}`);
      setStatusText(error instanceof Error ? error.message : "Unable to capture tab audio");
    }
  }

  function addTypedTranscript() {
    debug("Add transcript clicked");
    const value = typedText.trim();
    if (!value) {
      setStatusText("Type something first, then add it to the document.");
      debug("Add transcript ignored: empty text");
      return;
    }
    engine.ingestFinal(typedRole, value, starterMode);
    setTypedText("");
    setStatusText(`${typedRole === "interviewer" ? "Interviewer" : "Candidate"} transcript added`);
    debug(`Transcript added as ${typedRole}`);
  }

  async function sendToChatGpt() {
    debug("Send clicked");
    setStatusText("Preparing prompt...");

    const prompt = engine.buildPromptForCurrentQuestion();
    if (!prompt.ok) {
      setStatusText(prompt.reason);
      debug(`Prompt build failed: ${prompt.reason}`);
      return;
    }

    const connectionState = adapter.checkConnection();
    setConnection(connectionState);
    debug(`ChatGPT connection: ${connectionState.status} ${connectionState.message || ""}`);
    if (connectionState.status !== "connected") {
      setStatusText(connectionState.message || "ChatGPT page connection lost.");
      return;
    }

    try {
      const startedAt = performance.now();
      const assistantStartCount = adapter.assistantCount();
      const ignoredAnswerText = latestAssistantText();
      activeRequestRef.current = {
        question: prompt.question,
        assistantStartCount,
        kind: "final",
        ignoredAnswerText
      };
      setElapsedMs(0);
      setLatency({ status: "waiting", startedAt });
      engine.markGenerating(prompt.question);
      await adapter.sendPrompt(prompt.prompt);
      setLatency((current) => ({ ...current, submittedAt: performance.now() }));
      setStatusText("Prompt sent to ChatGPT");
      debug("Prompt sent to ChatGPT");
    } catch (error) {
      activeRequestRef.current = null;
      engine.markIdle();
      debug(`Send exception: ${error instanceof Error ? error.message : String(error)}`);
      setStatusText(error instanceof Error ? error.message : "Unable to send prompt");
    }
  }

  function clearSession() {
    engine.reset();
    setStatusText("Session cleared");
    debug("Session cleared");
  }

  if (!isOpen) {
    return (
      <button className="gptd-mini-tab" onClick={() => setIsOpen(true)} title="Open GPTDisguise Live Assist">
        <FileText size={18} />
      </button>
    );
  }

  return (
    <section className="gptd-shell" aria-label="GPTDisguise document interface">
      <header className="gptd-doc-header">
        <div className="gptd-doc-identity">
          <FileText size={25} />
          <div>
            <div className="gptd-title-row">
              <h1>Interview Notes</h1>
              <ConnectionPill connection={connection} />
            </div>
            <nav className="gptd-menu-row" aria-label="Document menu">
              <span>File</span>
              <span>Edit</span>
              <span>View</span>
              <span>Insert</span>
              <span>Format</span>
              <span>Tools</span>
              <span>Extensions</span>
              <span>Help</span>
            </nav>
          </div>
        </div>
        <div className="gptd-header-actions">
          <span className="gptd-save-state">{statusText}</span>
          <LatencyPill latency={latency} elapsedMs={elapsedMs} />
          <button className="gptd-icon-button" onClick={() => setIsOpen(false)} title="Reveal ChatGPT">
            <X size={18} />
          </button>
        </div>
      </header>

      <div className="gptd-toolbar" role="toolbar" aria-label="Document toolbar">
        <span className="gptd-toolbar-chip">100%</span>
        <span className="gptd-toolbar-chip">Normal text</span>
        <span className="gptd-toolbar-chip">Arial</span>
        <span className="gptd-toolbar-chip">11</span>
        <span className="gptd-divider" />
        <NativeStatusPill status={nativeStatus} timing={chunkTimingText} />
        <button className={isVoiceCapture ? "gptd-tool active" : "gptd-tool"} onClick={toggleVoiceCapture}>
          <Mic size={17} />
          <span>{isVoiceCapture ? "Dictara ready" : "Dictara Capture"}</span>
        </button>
        <button className="gptd-tool" onClick={clearSession}>
          <Radio size={17} />
          <span>Clear</span>
        </button>
      </div>

      <div className="gptd-ruler" aria-hidden="true">
        {Array.from({ length: 12 }).map((_, index) => (
          <span key={index}>{index + 1}</span>
        ))}
      </div>

      <main className="gptd-page">
        <aside className="gptd-input-panel" aria-label="Typed transcript">
          <div className="gptd-panel-title">Live notes</div>
          <div className={isVoiceCapture ? "gptd-voice-hint active" : "gptd-voice-hint"}>
            <strong>Dictara rolling paste</strong>
            <span>{isVoiceCapture ? "Cursor is locked here. Press Fn+Space again to send the final chunk." : "Click Dictara Capture, then press Fn+Space."}</span>
          </div>
          <div className={nativeStatus === "capturing" || nativeStatus === "transcribing" ? "gptd-native-card active" : "gptd-native-card"}>
            <strong>Native helper</strong>
            <span>{nativeStatusLabel(nativeStatus)} · {nativeEngine} · {chunkTimingText}</span>
            {rollingQuestion.buffer ? <p>{rollingQuestion.buffer}</p> : <p>Rolling transcript chunks will appear here.</p>}
            {rollingQuestion.starter && <em>{rollingQuestion.starter}</em>}
          </div>
          <div className="gptd-segmented">
            <button className={typedRole === "interviewer" ? "selected" : ""} onClick={() => setTypedRole("interviewer")}>
              <Bot size={16} />
              Interviewer
            </button>
            <button className={typedRole === "candidate" ? "selected" : ""} onClick={() => setTypedRole("candidate")}>
              <UserRound size={16} />
              Candidate
            </button>
          </div>
          <textarea
            ref={captureTextareaRef}
            className={isVoiceCapture ? "flow-active" : ""}
            value={typedText}
            onChange={(event) => handleCaptureTextChange(event.target.value)}
            onFocus={() => {
              if (isVoiceCapture) debug("Voice capture box focused");
            }}
            placeholder={isVoiceCapture ? "Dictara chunks paste here. Press Fn+Space again when the question is complete..." : "Type notes or a follow-up question..."}
            onKeyDown={(event) => {
              if (event.altKey && event.key === "Enter") {
                event.preventDefault();
                finalizeAfterNextChunkRef.current = true;
                setStatusText("Waiting for Dictara to paste the final chunk...");
                debug("Dictara finalize requested; waiting for final paste");
                return;
              }

              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                addTypedTranscript();
              }
            }}
          />
          <button className="gptd-wide-button" onClick={addTypedTranscript}>
            <PlayCircle size={17} />
            Add to document
          </button>
          {isCapturingTab && (
            <div className="gptd-meter" aria-label="Tab audio level">
              <span style={{ width: `${Math.max(4, tabLevel * 100)}%` }} />
            </div>
          )}
          {showDebug && (
            <section className="gptd-debug" aria-label="Diagnostics">
              <div className="gptd-panel-title">Diagnostics</div>
              {debugEntries.length === 0 ? (
                <p>No events yet.</p>
              ) : (
                debugEntries.map((entry) => (
                  <p key={entry.id}>
                    <span>{entry.createdAt}</span>
                    {entry.message}
                  </p>
                ))
              )}
            </section>
          )}
        </aside>

        <section className="gptd-doc" ref={docScrollRef}>
          <article className="gptd-document-page">
            <div className="gptd-document-date">Meeting notes · Live draft</div>
            <h2>Interview Notes</h2>
            {state.partialTranscript && <PartialTranscript event={state.partialTranscript} starter={state.provisionalStarter?.text} />}
            <TurnCards turns={state.turns} activeTurnId={state.activeTurnId} phase={state.phase} />
            {state.queuedQuestions.length > 0 && (
              <div className="gptd-queue">
                <span>Queued follow-ups</span>
                {state.queuedQuestions.map((question) => (
                  <p key={question.id}>{question.text}</p>
                ))}
              </div>
            )}
          </article>
        </section>
      </main>
    </section>
  );
}

function ConnectionPill({ connection }: { connection: ChatGptConnectionState }) {
  const label = connection.status === "connected" ? "ChatGPT connected" : connection.status === "checking" ? "Checking" : "Connection lost";
  return <span className={`gptd-pill ${connection.status}`}>{label}</span>;
}

function NativeStatusPill({ status, timing }: { status: NativeBridgeStatus; timing: string }) {
  return (
    <span className={`gptd-pill native ${status}`}>
      Dictara: {nativeStatusLabel(status)} · {timing}
    </span>
  );
}

function nativeStatusLabel(status: NativeBridgeStatus) {
  if (status === "disconnected") return "off";
  if (status === "connecting") return "connecting";
  if (status === "connected") return "ready";
  if (status === "capturing") return "capturing";
  if (status === "transcribing") return "transcribing";
  return "error";
}

function LatencyPill({ latency, elapsedMs }: { latency: LatencyState; elapsedMs: number }) {
  if (latency.status === "idle") {
    return <span className="gptd-latency idle">Timer --</span>;
  }

  if (latency.status === "waiting") {
    const submitMs = latency.startedAt && latency.submittedAt ? latency.submittedAt - latency.startedAt : undefined;
    return <span className="gptd-latency waiting">Waiting {formatSeconds(elapsedMs)} · sent {formatSeconds(submitMs)}</span>;
  }

  if (latency.status === "streaming") {
    const firstMs = latency.startedAt && latency.firstAnswerAt ? latency.firstAnswerAt - latency.startedAt : undefined;
    return <span className="gptd-latency streaming">Streaming {formatSeconds(elapsedMs)} · first {formatSeconds(firstMs)}</span>;
  }

  const totalMs = latency.startedAt && latency.lastRenderAt ? latency.lastRenderAt - latency.startedAt : undefined;
  const firstMs = latency.startedAt && latency.firstAnswerAt ? latency.firstAnswerAt - latency.startedAt : undefined;
  return <span className="gptd-latency rendered">Rendered {formatSeconds(totalMs)} · first {formatSeconds(firstMs)}</span>;
}

function formatSeconds(ms?: number) {
  if (typeof ms !== "number" || Number.isNaN(ms)) return "--";
  return `${(ms / 1000).toFixed(1)}s`;
}

function PartialTranscript({ event, starter }: { event: ConversationEvent; starter?: string }) {
  return (
    <div className="gptd-live-card">
      <div className="gptd-block-title">
        <FileText size={16} />
        <span>Live Capture</span>
      </div>
      <p>{event.text}</p>
      {starter && (
        <div className="gptd-starter compact">
          <span>Starter</span>
          <p>{starter}</p>
        </div>
      )}
    </div>
  );
}

function TurnCards({ turns, activeTurnId, phase }: { turns: ConversationTurn[]; activeTurnId?: string; phase: string }) {
  if (turns.length === 0) {
    return <p className="gptd-muted">Captured questions and answers will appear here as separate cards.</p>;
  }

  return (
    <div className="gptd-turn-list">
      {turns.map((turn, index) => (
        <article
          key={turn.id}
          className={[
            "gptd-turn",
            turn.id === activeTurnId ? "active" : "",
            index === turns.length - 1 ? "latest" : ""
          ].filter(Boolean).join(" ")}
        >
          <div className="gptd-turn-label">Question {index + 1}</div>
          <section className="gptd-question-band">
            <strong>Question</strong>
            <p>{turn.question}</p>
          </section>
          {turn.starter && (
            <div className="gptd-starter compact">
              <span>Starter</span>
              <p>{turn.starter}</p>
            </div>
          )}
          <section className="gptd-answer-band">
            <strong>Answer</strong>
            {turn.answerHtml ? (
              <div className="gptd-rich-answer" dangerouslySetInnerHTML={{ __html: turn.answerHtml }} />
            ) : (
              <p>{turn.answer || (turn.id === activeTurnId && phase === "generating" ? "Waiting for ChatGPT..." : "Not generated yet.")}</p>
            )}
          </section>
        </article>
      ))}
    </div>
  );
}

function TranscriptBlock({ title, events, partial }: { title: string; events: ConversationEvent[]; partial?: ConversationEvent }) {
  return (
    <div className="gptd-transcript">
      <div className="gptd-block-title">
        <FileText size={16} />
        <span>{title}</span>
      </div>
      {events.length === 0 && !partial ? (
        <p className="gptd-muted">Start with typed input or microphone transcription.</p>
      ) : (
        <div className="gptd-event-list">
          {events.slice(-8).map((event) => (
            <article key={event.id} className={`gptd-event ${event.role}`}>
              <strong>{event.role === "interviewer" ? "Interviewer" : "Candidate"}</strong>
              <p>{event.text}</p>
            </article>
          ))}
          {partial && (
            <article className={`gptd-event ${partial.role} partial`}>
              <strong>{partial.role === "interviewer" ? "Interviewer" : "Candidate"}</strong>
              <p>{partial.text}</p>
            </article>
          )}
        </div>
      )}
    </div>
  );
}
