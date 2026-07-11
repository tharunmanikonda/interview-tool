import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot,
  FileText as FileTextBase,
  Mic,
  MicOff,
  PauseCircle,
  PlayCircle,
  Radio,
  Send,
  Settings as SettingsBase,
  Share2 as Share2Base,
  Square,
  UserRound,
  Volume2,
  X as XBase
} from "lucide-react";
import {
  HelperEvent,
  LiveDocAttachment,
  LiveDocLatency,
  LiveDocSnapshot,
  LiveDocStatus,
  RollingQuestionState,
  TranscriptionEngine,
  appendTranscriptChunk,
  createEmptyRollingQuestion
} from "@gptdisguise/protocol";
import "../src/content.css";
import {
  ChatGptAdapter,
  ChatGptConnectionState,
  ChatGptConversationMarkers,
  ChatGptConversationTurn,
  ChatGptFileAttachment,
  ChatGptImageAttachment
} from "../src/chatgptAdapter";
import {
  ConversationEvent,
  ConversationState,
  ConversationTurn,
  HydratableConversationTurn,
  InputRole,
  LiveAssistEngine,
  StarterMode
} from "../src/liveAssist";
import { NativeBridge, NativeBridgeStatus } from "../src/nativeBridge";
import { LiveDocPublisher, LiveDocPublisherStatus, StoredLiveDocSession, defaultDocsServerUrl, normalizeDocsServerUrl } from "../src/liveDocPublisher";
import {
  DEFAULT_PROMPT_SETTINGS,
  PromptSettings,
  compilePromptTemplate,
  loadPromptSettings,
  savePromptSettings,
  validatePromptSettings
} from "../src/promptSettings";
import { BrowserSpeechProvider, TabAudioCaptureProvider, testMicrophoneAccess } from "../src/speechProviders";

type IconComponent = (props: { size?: number; className?: string }) => React.ReactElement;
const FileText = FileTextBase as unknown as IconComponent;
const Settings = SettingsBase as unknown as IconComponent;
const Share2 = Share2Base as unknown as IconComponent;
const X = XBase as unknown as IconComponent;

type DebugEntry = {
  id: string;
  message: string;
  createdAt: string;
};

type CaptureTimelineEntry = {
  id: string;
  label: string;
  detail?: string;
  createdAt: string;
};

type LatencyState = {
  status: "idle" | "waiting" | "streaming" | "rendered";
  startedAt?: number;
  submittedAt?: number;
  firstAnswerAt?: number;
  lastRenderAt?: number;
  checkpoints?: Record<string, number>;
};

type ActiveRequest = {
  turnId: string;
  question: string;
  assistantStartCount: number;
  kind: "starter" | "final";
  ignoredAnswerText?: string;
};

type StarterRequestPolicy = {
  sentCount: number;
  maxCount: number;
};

type ReaderViewMode = "reader" | "focus";
type ReaderTheme = "light" | "dark";

type TurnLedgerStatus =
  | "draft"
  | "starter_waiting"
  | "starter_streaming"
  | "starter_done"
  | "final_waiting"
  | "final_streaming"
  | "done"
  | "send_failed"
  | "interrupted"
  | "needs_retry";

type TurnLedgerLatency = {
  startedAt?: number;
  submittedAt?: number;
  firstAnswerAt?: number;
  lastRenderAt?: number;
  checkpoints?: Record<string, number>;
};

type StoredTurnLedgerEntry = {
  schemaVersion: 2;
  id: string;
  conversationId: string;
  question: string;
  starter?: string;
  answer: string;
  answerHtml?: string;
  status: TurnLedgerStatus;
  requestKind?: "starter" | "final";
  createdAt: number;
  updatedAt: number;
  latency?: TurnLedgerLatency;
  error?: string;
};

type StoredChatMessage = {
  key: string;
  order: number;
  role: "user" | "assistant";
  text: string;
  html?: string;
  images?: ChatGptImageAttachment[];
  files?: ChatGptFileAttachment[];
  updatedAt: number;
};

type StoredChatHistoryMetadata = {
  markerCount?: number;
  activeMarkerIndex?: number;
  markerSignature?: string;
};

const LIVE_ASSIST_FINALIZE_MARKER = "[[GPTD_LIVE_ASSIST_FINALIZE]]";
const TURN_LEDGER_STORAGE_PREFIX = "gptd-turn-ledger:v2:";
const CHAT_HISTORY_STORAGE_PREFIX = "gptd-chat-history:";
const CHAT_SCROLL_STORAGE_PREFIX = "gptd-chat-scroll:";
const LIVE_DOC_SESSION_STORAGE_PREFIX = "gptd-live-doc-session:";
const LIVE_DOC_SERVER_URL_STORAGE_KEY = "gptd-live-doc-server-url";

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

function messagesToHydratedTurns(messages: StoredChatMessage[]) {
  const turns: HydratableConversationTurn[] = [];
  const orderedMessages = [...messages].sort((a, b) => a.order - b.order);
  let pendingUser: StoredChatMessage | undefined;

  function findMatchingTurn(question: string) {
    const normalized = normalizeForHistory(question);
    if (!normalized) return undefined;
    return turns.find((turn) => {
      const existing = normalizeForHistory(turn.question);
      return existing === normalized || existing.includes(normalized) || normalized.includes(existing);
    });
  }

  function upsertInternalTurn(userMessage: StoredChatMessage, assistantMessage?: StoredChatMessage) {
    const question = extractQuestionFromPrompt(userMessage.text);
    if (!question && !userMessage.images?.length && !userMessage.files?.length) return undefined;

    let turn = findMatchingTurn(question);
    if (!turn) {
      turn = {
        id: liveTurnIdFromMessageKeys(userMessage.key, assistantMessage?.key),
        question,
        questionImages: userMessage.images,
        questionFiles: userMessage.files,
        answer: "",
        createdAt: userMessage.updatedAt
      };
      turns.push(turn);
    } else {
      if (question.length > turn.question.length && question.includes(turn.question)) turn.question = question;
      if (userMessage.images?.length) turn.questionImages = userMessage.images;
      if (userMessage.files?.length) turn.questionFiles = userMessage.files;
      if (assistantMessage) turn.id = liveTurnIdFromMessageKeys(userMessage.key, assistantMessage.key);
    }

    return turn;
  }

  function flushPendingUser() {
    if (!pendingUser) return;
    if (classifyPromptMessage(pendingUser.text) !== "normal") {
      pendingUser = undefined;
      return;
    }

    turns.push({
      id: liveTurnIdFromMessageKeys(pendingUser.key),
      question: extractQuestionFromPrompt(pendingUser.text),
      questionImages: pendingUser.images,
      questionFiles: pendingUser.files,
      answer: "",
      createdAt: pendingUser.updatedAt
    });
    pendingUser = undefined;
  }

  for (const message of orderedMessages) {
    if (message.role === "user") {
      flushPendingUser();
      pendingUser = message;
      continue;
    }

    if (pendingUser) {
      const promptKind = classifyPromptMessage(pendingUser.text);

      if (promptKind === "starter") {
        const turn = upsertInternalTurn(pendingUser, message);
        if (turn && message.text.trim()) turn.starter = message.text;
      } else if (promptKind === "final") {
        const turn = upsertInternalTurn(pendingUser, message);
        if (turn) {
          turn.answer = message.text;
          turn.answerHtml = message.html;
          turn.answerImages = message.images;
          turn.answerFiles = message.files;
        }
      } else {
        turns.push({
          id: liveTurnIdFromMessageKeys(pendingUser.key, message.key),
          question: extractQuestionFromPrompt(pendingUser.text),
          questionImages: pendingUser.images,
          questionFiles: pendingUser.files,
          answer: message.text,
          answerHtml: message.html,
          answerImages: message.images,
          answerFiles: message.files,
          createdAt: pendingUser.updatedAt
        });
      }

      pendingUser = undefined;
    } else {
      // ChatGPT turns should arrive as user -> assistant pairs. If an assistant
      // message is orphaned here, it usually came from stale local storage from
      // an older broken sync and should not become its own fake question card.
      continue;
    }
  }

  flushPendingUser();

  return turns.filter((turn) => turn.question || turn.questionImages?.length || turn.questionFiles?.length);
}

function liveTurnIdFromMessageKeys(userKey: string, assistantKey = "") {
  return `turn:${stableHistoryHash(`${userKey}::${assistantKey}`)}`;
}

function extractQuestionFromPrompt(text: string) {
  const cleanedText = cleanInternalPromptText(text);
  const markers = [
    "Current complete question:",
    "Current interviewer question:",
    "Partial interviewer question so far:",
    "Partial question so far:"
  ];
  const marker = markers.find((candidate) => cleanedText.includes(candidate));
  if (!marker) return cleanedText;

  const markerIndex = cleanedText.indexOf(marker);

  const afterMarker = cleanedText.slice(markerIndex + marker.length).trim();
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
  return (cleanupIndex === undefined ? section : section.slice(0, cleanupIndex)).trim() || cleanedText;
}

function classifyPromptMessage(text: string): "normal" | "starter" | "final" {
  const cleaned = cleanInternalPromptText(text);
  const hasStarterShape = cleaned.includes("The interviewer is still asking a question") || cleaned.includes("Return only the bridge sentence");
  const hasFinalShape = cleaned.includes("The interviewer has now completed the question") || cleaned.includes("Starter already shown to the candidate:");

  if (hasFinalShape && cleaned.includes("Current complete question:")) return "final";
  if (hasStarterShape && cleaned.includes("Partial question so far:")) return "starter";
  return "normal";
}

function cleanInternalPromptText(text: string) {
  return text
    .replaceAll(LIVE_ASSIST_FINALIZE_MARKER, "")
    .replace(/\s+/g, " ")
    .replace(/\s+(Current complete question:|Current interviewer question:|Partial interviewer question so far:|Partial question so far:)/g, "\n\n$1")
    .replace(/\s+(Starter already shown to the candidate:|Candidate actually said so far:)/g, "\n\n$1")
    .trim();
}

function chatHistorySignature(messages: StoredChatMessage[]) {
  return messages
    .map((message) => `${message.key}:${message.role}:${message.text.length}:${imageHistorySignature(message.images)}:${fileHistorySignature(message.files)}:${normalizeForHistory(message.text).slice(0, 180)}`)
    .join("::");
}

function imageHistorySignature(images?: ChatGptImageAttachment[]) {
  return images?.map((image) => image.src).join("|") || "0";
}

function fileHistorySignature(files?: ChatGptFileAttachment[]) {
  return files?.map((file) => `${file.name}:${file.href || ""}`).join("|") || "0";
}

function getChatConversationId() {
  const match = window.location.pathname.match(/\/c\/([^/?#]+)/);
  if (match?.[1]) return match[1];
  return `path:${window.location.pathname || "/"}`;
}

function turnLedgerKey(conversationId: string) {
  return `${TURN_LEDGER_STORAGE_PREFIX}${conversationId}`;
}

async function loadTurnLedger(conversationId: string): Promise<StoredTurnLedgerEntry[]> {
  const key = turnLedgerKey(conversationId);
  const result = await safeStorageGet(key);
  const turns = result[key]?.turns;
  await safeStorageRemove(`${CHAT_HISTORY_STORAGE_PREFIX}${conversationId}`);
  if (!Array.isArray(turns)) return [];

  let changed = false;
  const nextTurns = turns
    .filter(isStoredTurnLedgerEntry)
    .map((turn) => {
      if (isInterruptedLedgerStatus(turn.status)) {
        changed = true;
        return {
          ...turn,
          status: turn.answer || turn.starter ? "interrupted" as const : "needs_retry" as const,
          updatedAt: Date.now(),
          error: turn.error || "Page refreshed before this response completed."
        };
      }
      return turn;
    })
    .filter((turn) => turn.question.trim())
    .sort((a, b) => a.createdAt - b.createdAt);

  if (changed) await saveTurnLedger(conversationId, nextTurns);
  return nextTurns;
}

async function saveTurnLedger(conversationId: string, turns: StoredTurnLedgerEntry[]) {
  if (!conversationId) return;
  await safeStorageSet({
    [turnLedgerKey(conversationId)]: {
      schemaVersion: 2,
      conversationId,
      updatedAt: Date.now(),
      turns: turns.slice(-120).map((turn) => stripUndefined(turn))
    }
  });
}

async function clearTurnLedger(conversationId: string) {
  if (!conversationId) return;
  await safeStorageRemove(turnLedgerKey(conversationId));
}

function ledgerTurnToHydratable(turn: StoredTurnLedgerEntry): HydratableConversationTurn {
  return {
    id: turn.id,
    question: turn.question,
    starter: turn.starter,
    answer: turn.answer || turn.error || "",
    answerHtml: turn.answerHtml,
    createdAt: turn.createdAt
  };
}

function isInterruptedLedgerStatus(status: TurnLedgerStatus) {
  return status === "starter_waiting" || status === "starter_streaming" || status === "final_waiting" || status === "final_streaming";
}

function isStoredTurnLedgerEntry(value: unknown): value is StoredTurnLedgerEntry {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<StoredTurnLedgerEntry>;
  return (
    turn.schemaVersion === 2 &&
    typeof turn.id === "string" &&
    typeof turn.conversationId === "string" &&
    typeof turn.question === "string" &&
    typeof turn.answer === "string" &&
    typeof turn.status === "string" &&
    typeof turn.createdAt === "number" &&
    typeof turn.updatedAt === "number"
  );
}

function createLedgerTurn(conversationId: string, question: string): StoredTurnLedgerEntry {
  const now = Date.now();
  return {
    schemaVersion: 2,
    id: `ledger-turn-${now}-${Math.random().toString(36).slice(2, 8)}`,
    conversationId,
    question,
    answer: "",
    status: "draft",
    createdAt: now,
    updatedAt: now
  };
}

function normalizeQuestionForLedger(question: string) {
  return question.replace(/\s+/g, " ").trim().toLowerCase();
}

function shouldSendStarterForChunk(event: HelperEvent) {
  if (event.isFinal) return false;
  if (typeof event.startedAt === "number" && typeof event.completedAt === "number") {
    return event.completedAt - event.startedAt >= 9_500;
  }
  return true;
}

async function loadStoredChatMessages(conversationId: string): Promise<StoredChatMessage[]> {
  const key = `${CHAT_HISTORY_STORAGE_PREFIX}${conversationId}`;
  const result = await safeStorageGet(key);
  const messages = result[key]?.messages;
  if (Array.isArray(messages)) return messages.filter(isStoredChatMessage).sort((a, b) => a.order - b.order);

  const turns = result[key]?.turns;
  if (Array.isArray(turns)) return turnsToStoredMessages(turns.filter(isHydratableTurn));

  return [];
}

async function saveStoredChatMessages(conversationId: string, messages: StoredChatMessage[], metadata?: StoredChatHistoryMetadata) {
  if (!conversationId || messages.length === 0) return;

  const key = `${CHAT_HISTORY_STORAGE_PREFIX}${conversationId}`;
  await safeStorageSet({
    [key]: stripUndefined({
      conversationId,
      updatedAt: Date.now(),
      metadata,
      messages: messages.slice(-160)
    })
  });
}

async function clearStoredChatTurns(conversationId: string) {
  if (!conversationId) return;
  await safeStorageRemove(`${CHAT_HISTORY_STORAGE_PREFIX}${conversationId}`);
  await safeStorageRemove(`${CHAT_SCROLL_STORAGE_PREFIX}${conversationId}`);
}

async function loadStoredScrollTop(conversationId: string) {
  const key = `${CHAT_SCROLL_STORAGE_PREFIX}${conversationId}`;
  const result = await safeStorageGet(key);
  const value = result[key]?.scrollTop;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function saveStoredScrollTop(conversationId: string, scrollTop: number) {
  if (!conversationId || !Number.isFinite(scrollTop)) return;
  await safeStorageSet({
    [`${CHAT_SCROLL_STORAGE_PREFIX}${conversationId}`]: {
      conversationId,
      scrollTop,
      updatedAt: Date.now()
    }
  });
}

async function loadStoredLiveDocSession(conversationId: string): Promise<StoredLiveDocSession | undefined> {
  const key = `${LIVE_DOC_SESSION_STORAGE_PREFIX}${conversationId}`;
  const result = await safeStorageGet(key);
  const session = result[key];
  if (isStoredLiveDocSession(session)) return session;
  return undefined;
}

async function saveStoredLiveDocSession(conversationId: string, session: StoredLiveDocSession) {
  if (!conversationId) return;
  await safeStorageSet({ [`${LIVE_DOC_SESSION_STORAGE_PREFIX}${conversationId}`]: session });
}

async function clearStoredLiveDocSession(conversationId: string) {
  if (!conversationId) return;
  await safeStorageRemove(`${LIVE_DOC_SESSION_STORAGE_PREFIX}${conversationId}`);
}

async function loadStoredLiveDocServerUrl() {
  const result = await safeStorageGet(LIVE_DOC_SERVER_URL_STORAGE_KEY);
  const value = result[LIVE_DOC_SERVER_URL_STORAGE_KEY];
  return typeof value === "string" ? normalizeDocsServerUrl(value) : defaultDocsServerUrl();
}

async function saveStoredLiveDocServerUrl(serverUrl: string) {
  await safeStorageSet({ [LIVE_DOC_SERVER_URL_STORAGE_KEY]: normalizeDocsServerUrl(serverUrl) });
}

async function safeStorageGet(key: string) {
  if (!isExtensionContextValid()) return {} as Record<string, unknown>;
  try {
    return await chrome.storage.local.get(key);
  } catch (error) {
    if (isExtensionContextError(error)) return {} as Record<string, unknown>;
    throw error;
  }
}

async function safeStorageSet(value: Record<string, unknown>) {
  if (!isExtensionContextValid()) return;
  try {
    await chrome.storage.local.set(value);
  } catch (error) {
    if (!isExtensionContextError(error)) throw error;
  }
}

async function safeStorageRemove(key: string) {
  if (!isExtensionContextValid()) return;
  try {
    await chrome.storage.local.remove(key);
  } catch (error) {
    if (!isExtensionContextError(error)) throw error;
  }
}

function isExtensionContextValid() {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function isExtensionContextError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("Extension context invalidated") || message.includes("context invalidated");
}

function isStoredLiveDocSession(value: unknown): value is StoredLiveDocSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<StoredLiveDocSession>;
  return (
    typeof session.sessionId === "string" &&
    typeof session.publishToken === "string" &&
    typeof session.viewToken === "string" &&
    typeof session.viewUrl === "string" &&
    typeof session.chatConversationId === "string" &&
    typeof session.serverUrl === "string"
  );
}

function isHydratableTurn(value: unknown): value is HydratableConversationTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<HydratableConversationTurn>;
  return typeof turn.question === "string" && typeof turn.answer === "string";
}

function isStoredChatMessage(value: unknown): value is StoredChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<StoredChatMessage>;
  return (
    typeof message.key === "string" &&
    typeof message.order === "number" &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.text === "string" &&
    (message.images === undefined || Array.isArray(message.images)) &&
    (message.files === undefined || Array.isArray(message.files))
  );
}

function chatGptTurnToStoredMessage(turn: ChatGptConversationTurn): StoredChatMessage {
  return stripUndefined({
    key: turn.key,
    order: turn.order,
    role: turn.role,
    text: turn.text.trim(),
    html: turn.html,
    images: turn.images,
    files: turn.files,
    updatedAt: Date.now()
  });
}

function markerMetadata(markers: ChatGptConversationMarkers): StoredChatHistoryMetadata | undefined {
  if (markers.count === 0) return undefined;
  return stripUndefined({
    markerCount: markers.count,
    activeMarkerIndex: markers.activeIndex,
    markerSignature: markers.signature
  });
}

function turnsToStoredMessages(turns: HydratableConversationTurn[]) {
  const messages: StoredChatMessage[] = [];
  turns.forEach((turn, index) => {
    const order = index * 2;
    const createdAt = turn.createdAt || Date.now() + order;
    if (turn.question.trim() || turn.questionImages?.length || turn.questionFiles?.length) {
      messages.push({
        key: `legacy:user:${stableHistoryHash(turn.question || turn.questionImages?.map((image) => image.src).join("|") || turn.questionFiles?.map((file) => file.href || file.name).join("|") || "")}`,
        order,
        role: "user",
        text: turn.question,
        images: turn.questionImages,
        files: turn.questionFiles,
        updatedAt: createdAt
      });
    }

    if (turn.answer.trim() || turn.answerImages?.length || turn.answerFiles?.length) {
      messages.push({
        key: `legacy:assistant:${stableHistoryHash(turn.answer || turn.answerImages?.map((image) => image.src).join("|") || turn.answerFiles?.map((file) => file.href || file.name).join("|") || "")}`,
        order: order + 1,
        role: "assistant",
        text: turn.answer,
        html: turn.answerHtml,
        images: turn.answerImages,
        files: turn.answerFiles,
        updatedAt: createdAt + 1
      });
    }
  });

  return messages;
}

function mergeChatMessages(existing: StoredChatMessage[], incoming: StoredChatMessage[]) {
  const byKey = new Map<string, StoredChatMessage>();
  for (const message of existing) {
    byKey.set(message.key, message);
  }

  for (const message of incoming) {
    if (!message.text.trim() && !message.images?.length && !message.files?.length) continue;
    const current = byKey.get(message.key);
    if (!current) {
      byKey.set(message.key, message);
      continue;
    }

    byKey.set(message.key, {
      ...current,
      text: message.text.length >= current.text.length ? message.text : current.text,
      html: message.html || current.html,
      images: message.images?.length ? message.images : current.images,
      files: message.files?.length ? message.files : current.files,
      order: Math.min(current.order, message.order),
      updatedAt: Date.now()
    });
  }

  return dropOrphanAssistantMessages([...byKey.values()].sort((a, b) => a.order - b.order));
}

function dropOrphanAssistantMessages(messages: StoredChatMessage[]) {
  return messages.filter((message, index) => {
    if (message.role !== "assistant") return true;
    const previous = messages[index - 1];
    return previous?.role === "user";
  });
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)).filter((item) => item !== undefined) as T;
  }

  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    output[key] = stripUndefined(entry);
  }
  return output as T;
}

function stableHistoryHash(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeForHistory(value = "") {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function LiveAssistOverlay() {
  const adapter = useMemo(() => new ChatGptAdapter(), []);
  const engine = useMemo(() => new LiveAssistEngine(), []);
  const speechProvider = useMemo(() => new BrowserSpeechProvider(), []);
  const tabAudioProvider = useMemo(() => new TabAudioCaptureProvider(), []);
  const nativeBridge = useMemo(() => new NativeBridge(), []);
  const liveDocPublisher = useMemo(() => new LiveDocPublisher(), []);
  const [state, setState] = useState<ConversationState>(() => engine.snapshot());
  const [connection, setConnection] = useState<ChatGptConnectionState>({ status: "checking" });
  const [nativeStatus, setNativeStatus] = useState<NativeBridgeStatus>("disconnected");
  const [nativeEngine, setNativeEngine] = useState<TranscriptionEngine>("local");
  const [rollingQuestion, setRollingQuestion] = useState<RollingQuestionState>(() => createEmptyRollingQuestion());
  const [chunkTimingText, setChunkTimingText] = useState("10s starter · 5s collect");
  const [isOpen, setIsOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [readerViewMode, setReaderViewMode] = useState<ReaderViewMode>("reader");
  const [readerTheme, setReaderTheme] = useState<ReaderTheme>("dark");
  const [isListening, setIsListening] = useState(false);
  const [isCapturingTab, setIsCapturingTab] = useState(false);
  const [tabLevel, setTabLevel] = useState(0);
  const [typedText, setTypedText] = useState("");
  const [typedRole, setTypedRole] = useState<InputRole>("interviewer");
  const [starterMode, setStarterMode] = useState<StarterMode>("neutral-speculative");
  const [statusText, setStatusText] = useState("Ready");
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [captureTimeline, setCaptureTimeline] = useState<CaptureTimelineEntry[]>([]);
  const [isVoiceCapture, setIsVoiceCapture] = useState(true);
  const [latency, setLatency] = useState<LatencyState>({ status: "idle" });
  const [elapsedMs, setElapsedMs] = useState(0);
  const [promptSettings, setPromptSettings] = useState<PromptSettings>(DEFAULT_PROMPT_SETTINGS);
  const [draftPromptSettings, setDraftPromptSettings] = useState<PromptSettings>(DEFAULT_PROMPT_SETTINGS);
  const [promptSettingsMessage, setPromptSettingsMessage] = useState("Defaults loaded");
  const [promptSettingsWarnings, setPromptSettingsWarnings] = useState<string[]>([]);
  const [promptPreviewKind, setPromptPreviewKind] = useState<"starter" | "final">("starter");
  const [activeMarkerIndex, setActiveMarkerIndex] = useState(0);
  const [liveDocSession, setLiveDocSession] = useState<StoredLiveDocSession | undefined>();
  const [liveDocStatus, setLiveDocStatus] = useState<LiveDocPublisherStatus>("off");
  const [liveDocMessage, setLiveDocMessage] = useState("Not shared");
  const [liveDocServerUrl, setLiveDocServerUrl] = useState(() => defaultDocsServerUrl());
  const [draftLiveDocServerUrl, setDraftLiveDocServerUrl] = useState(() => defaultDocsServerUrl());
  const captureTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const docScrollRef = useRef<HTMLElement | null>(null);
  const silentDocScrollUntilRef = useRef(0);
  const autoFollowLatestRef = useRef(true);
  const lastDocScrollTopRef = useRef(0);
  const savedDocScrollTopRef = useRef(0);
  const saveScrollTimerRef = useRef<number | undefined>(undefined);
  const isRestoringScrollRef = useRef(false);
  const flowDebounceRef = useRef<number | undefined>(undefined);
  const focusIntervalRef = useRef<number | undefined>(undefined);
  const lastFlowSubmittedRef = useRef("");
  const nativeStatusRef = useRef<NativeBridgeStatus>("disconnected");
  const rollingQuestionRef = useRef<RollingQuestionState>(createEmptyRollingQuestion());
  const realtimeCaptureStartedAtRef = useRef<number | undefined>(undefined);
  const realtimeStarterTimerRef = useRef<number | undefined>(undefined);
  const finalizeAfterNextChunkRef = useRef(false);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const firstAnswerNotifiedForRequestRef = useRef<string | undefined>(undefined);
  const ledgerTurnsRef = useRef<StoredTurnLedgerEntry[]>([]);
  const activeLedgerTurnIdRef = useRef<string | undefined>(undefined);
  const answerStableTimerRef = useRef<number | undefined>(undefined);
  const stateRef = useRef<ConversationState>(engine.snapshot());
  const starterSentRef = useRef(false);
  const starterPolicyRef = useRef<StarterRequestPolicy>({ sentCount: 0, maxCount: 1 });
  const lastStarterQuestionSentRef = useRef("");
  const pendingStarterQuestionRef = useRef("");
  const pendingFinalSendRef = useRef(false);
  const [conversationId, setConversationId] = useState(() => getChatConversationId());
  const conversationIdRef = useRef(conversationId);

  function debug(message: string) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      message,
      createdAt: new Date().toLocaleTimeString()
    };
    setDebugEntries((entries) => [entry, ...entries].slice(0, 8));
  }

  function captureTimelineEvent(label: string, detail?: string) {
    const entry: CaptureTimelineEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      label,
      detail,
      createdAt: new Date().toLocaleTimeString()
    };
    setCaptureTimeline((entries) => [entry, ...entries].slice(0, 12));
  }

  function setLatencyCheckpoint(name: string, value = performance.now()) {
    setLatency((current) => ({
      ...current,
      checkpoints: {
        ...current.checkpoints,
        [name]: value
      }
    }));
  }

  function recordTurnLatencyCheckpoint(turnId: string, name: string, value = performance.now()) {
    setLatencyCheckpoint(name, value);
    updateLedgerTurn(
      turnId,
      (turn) => ({
        ...turn,
        latency: {
          ...turn.latency,
          checkpoints: {
            ...turn.latency?.checkpoints,
            [name]: value
          }
        }
      }),
      { hydrate: false }
    );
  }

  function chatGptSendTimings(turnId: string) {
    return {
      onComposerInsertStarted: () => recordTurnLatencyCheckpoint(turnId, "composerInsertStartedAt"),
      onComposerInsertCompleted: () => recordTurnLatencyCheckpoint(turnId, "composerInsertCompletedAt"),
      onSendClicked: () => {
        const now = performance.now();
        recordTurnLatencyCheckpoint(turnId, "sendClickedAt", now);
        captureTimelineEvent("sent", "Prompt submitted to ChatGPT");
      }
    };
  }

  function scrollLatestTurnIntoView(align: "start" | "end" = "start") {
    const scroll = docScrollRef.current;
    const latestTurn = scroll?.querySelector<HTMLElement>(".gptd-turn.latest, .gptd-turn:last-child");
    if (!scroll || !latestTurn) return;
    if (!autoFollowLatestRef.current) return;
    if (isRestoringScrollRef.current) return;

    const scrollRect = scroll.getBoundingClientRect();
    const turnRect = latestTurn.getBoundingClientRect();
    const top =
      align === "end"
        ? scroll.scrollTop + turnRect.bottom - scrollRect.bottom + 28
        : scroll.scrollTop + turnRect.top - scrollRect.top;
    silentDocScrollUntilRef.current = performance.now() + 700;
    scroll.scrollTo({ top: Math.max(0, top), behavior: "auto" });
    lastDocScrollTopRef.current = Math.max(0, top);
  }

  function restoreDocScrollTop(scrollTop: number) {
    const scroll = docScrollRef.current;
    if (!scroll) return;

    isRestoringScrollRef.current = true;
    silentDocScrollUntilRef.current = performance.now() + 900;
    const nextTop = Math.max(0, Math.min(scrollTop, scroll.scrollHeight - scroll.clientHeight));
    scroll.scrollTo({ top: nextTop, behavior: "auto" });
    savedDocScrollTopRef.current = nextTop;
    lastDocScrollTopRef.current = nextTop;
    updateActiveMarkerFromScroll();
    window.setTimeout(() => {
      isRestoringScrollRef.current = false;
    }, 180);
  }

  function scheduleSaveDocScrollTop() {
    const scroll = docScrollRef.current;
    if (!scroll) return;

    savedDocScrollTopRef.current = scroll.scrollTop;
    if (saveScrollTimerRef.current) window.clearTimeout(saveScrollTimerRef.current);
    saveScrollTimerRef.current = window.setTimeout(() => {
      void saveStoredScrollTop(conversationIdRef.current, savedDocScrollTopRef.current);
    }, 250);
  }

  function updateActiveMarkerFromScroll() {
    const scroll = docScrollRef.current;
    if (!scroll) return;

    const turns = Array.from(scroll.querySelectorAll<HTMLElement>(".gptd-turn"));
    if (turns.length === 0) {
      setActiveMarkerIndex(0);
      return;
    }

    const scrollRect = scroll.getBoundingClientRect();
    const targetTop = scrollRect.top + Math.min(160, scrollRect.height * 0.28);
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    turns.forEach((turn, index) => {
      const rect = turn.getBoundingClientRect();
      const distance = Math.abs(rect.top - targetTop);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    setActiveMarkerIndex(bestIndex);
  }

  function scrollToTurn(index: number) {
    const scroll = docScrollRef.current;
    const turn = scroll?.querySelectorAll<HTMLElement>(".gptd-turn")[index];
    if (!scroll || !turn) return;

    const scrollRect = scroll.getBoundingClientRect();
    const turnRect = turn.getBoundingClientRect();
    const top = scroll.scrollTop + turnRect.top - scrollRect.top - 24;
    autoFollowLatestRef.current = index >= stateRef.current.turns.length - 1;
    silentDocScrollUntilRef.current = performance.now() + 500;
    scroll.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    savedDocScrollTopRef.current = Math.max(0, top);
    setActiveMarkerIndex(index);
    void saveStoredScrollTop(conversationIdRef.current, savedDocScrollTopRef.current);
  }

  function closeOverlay() {
    const scroll = docScrollRef.current;
    if (scroll) {
      savedDocScrollTopRef.current = scroll.scrollTop;
      void saveStoredScrollTop(conversationIdRef.current, scroll.scrollTop);
    }
    setIsOpen(false);
  }

  function openOverlay() {
    setIsOpen(true);
    window.setTimeout(() => {
      restoreDocScrollTop(savedDocScrollTopRef.current);
    }, 80);
  }

  function latestAssistantText() {
    return adapter.readConversation().filter((turn) => turn.role === "assistant").at(-1)?.text || "";
  }

  function hydrateEngineFromLedger(turns = ledgerTurnsRef.current) {
    const hydratedTurns = turns.map(ledgerTurnToHydratable).filter((turn) => turn.question.trim());
    if (hydratedTurns.length === 0) {
      engine.reset();
      return;
    }
    engine.hydrateTurns(hydratedTurns);
  }

  function setLedgerTurns(nextTurns: StoredTurnLedgerEntry[], options: { hydrate?: boolean } = {}) {
    const sortedTurns = [...nextTurns].filter((turn) => turn.question.trim()).sort((a, b) => a.createdAt - b.createdAt);
    ledgerTurnsRef.current = sortedTurns;
    void saveTurnLedger(conversationIdRef.current, sortedTurns);
    if (options.hydrate) hydrateEngineFromLedger(sortedTurns);
  }

  function updateLedgerTurn(turnId: string, updater: (turn: StoredTurnLedgerEntry) => StoredTurnLedgerEntry, options: { hydrate?: boolean } = {}) {
    const nextTurns = ledgerTurnsRef.current.map((turn) => (turn.id === turnId ? stripUndefined(updater({ ...turn, updatedAt: Date.now() })) : turn));
    setLedgerTurns(nextTurns, options);
    return nextTurns.find((turn) => turn.id === turnId);
  }

  function ensureLedgerTurn(question: string) {
    const normalizedQuestion = question.trim();
    const activeTurn = activeLedgerTurnIdRef.current ? ledgerTurnsRef.current.find((turn) => turn.id === activeLedgerTurnIdRef.current) : undefined;
    if (activeTurn) {
      const updated = updateLedgerTurn(
        activeTurn.id,
        (turn) => ({
          ...turn,
          question: normalizedQuestion.length >= turn.question.length ? normalizedQuestion : turn.question
        }),
        { hydrate: false }
      );
      return updated || activeTurn;
    }

    const normalized = normalizeQuestionForLedger(normalizedQuestion);
    const recentDuplicate = [...ledgerTurnsRef.current]
      .reverse()
      .find((turn) => normalizeQuestionForLedger(turn.question) === normalized && Date.now() - turn.createdAt < 6000);
    if (recentDuplicate) {
      activeLedgerTurnIdRef.current = recentDuplicate.id;
      return recentDuplicate;
    }

    const turn = createLedgerTurn(conversationIdRef.current, normalizedQuestion);
    activeLedgerTurnIdRef.current = turn.id;
    setLedgerTurns([...ledgerTurnsRef.current, turn], { hydrate: true });
    return turn;
  }

  function updateAutoFollowFromManualScroll() {
    const scroll = docScrollRef.current;
    if (!scroll) return 0;

    const currentTop = scroll.scrollTop;
    const delta = currentTop - lastDocScrollTopRef.current;
    const isScrollingUp = currentTop < lastDocScrollTopRef.current - 8;
    const distanceFromBottom = scroll.scrollHeight - scroll.clientHeight - currentTop;

    if (isScrollingUp && distanceFromBottom > 140) {
      autoFollowLatestRef.current = false;
    } else if (distanceFromBottom < 90) {
      autoFollowLatestRef.current = true;
    }

    lastDocScrollTopRef.current = currentTop;
    return delta;
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
    window.setTimeout(updateActiveMarkerFromScroll, 80);
  }, [state]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const nextConversationId = getChatConversationId();
      if (nextConversationId !== conversationIdRef.current) {
        conversationIdRef.current = nextConversationId;
        setConversationId(nextConversationId);
      }
    }, 700);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      liveDocPublisher.disconnect();
      setLiveDocSession(undefined);
      setLiveDocStatus("off");
      setLiveDocMessage("Not shared");

      const ledgerTurns = await loadTurnLedger(conversationId);
      if (cancelled) return;

      ledgerTurnsRef.current = ledgerTurns;
      activeLedgerTurnIdRef.current = undefined;
      hydrateEngineFromLedger(ledgerTurns);
      debug(`Loaded local turn ledger: ${ledgerTurns.length} turns`);

      const storedScrollTop = await loadStoredScrollTop(conversationId);
      if (!cancelled && typeof storedScrollTop === "number") {
        savedDocScrollTopRef.current = storedScrollTop;
        window.setTimeout(() => restoreDocScrollTop(storedScrollTop), 120);
      }

      const storedLiveSession = await loadStoredLiveDocSession(conversationId);
      if (!cancelled && storedLiveSession) {
        setLiveDocSession(storedLiveSession);
        liveDocPublisher.connect(storedLiveSession);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, engine, liveDocPublisher]);

  useEffect(() => {
    liveDocPublisher.setStatusHandler((status, message) => {
      setLiveDocStatus(status);
      if (message) {
        setLiveDocMessage(message);
        debug(message);
      }
    });

    return () => {
      liveDocPublisher.disconnect();
    };
  }, [liveDocPublisher]);

  useEffect(() => {
    let cancelled = false;

    void loadPromptSettings().then((settings) => {
      if (cancelled) return;
      engine.setPromptSettings(settings);
      setPromptSettings(settings);
      setDraftPromptSettings(settings);
      setPromptSettingsWarnings(validatePromptSettings(settings).warnings);
      setPromptSettingsMessage("Prompt settings loaded");
    });

    return () => {
      cancelled = true;
    };
  }, [engine]);

  useEffect(() => {
    let cancelled = false;
    void loadStoredLiveDocServerUrl().then((serverUrl) => {
      if (cancelled) return;
      liveDocPublisher.setServerUrl(serverUrl);
      setLiveDocServerUrl(serverUrl);
      setDraftLiveDocServerUrl(serverUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [liveDocPublisher]);

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
      if (!activeRequest) {
        return;
      }
      if (answer.index < activeRequest.assistantStartCount && answer.text === activeRequest.ignoredAnswerText) return;

      const now = performance.now();
      const requestKey = `${activeRequest.kind}:${activeRequest.turnId}`;
      if (firstAnswerNotifiedForRequestRef.current !== requestKey) {
        firstAnswerNotifiedForRequestRef.current = requestKey;
        captureTimelineEvent("first answer", "ChatGPT response text detected");
      }
      setLatency((current) => ({
        ...current,
        status: "streaming",
        firstAnswerAt: current.firstAnswerAt ?? now,
        lastRenderAt: now,
        checkpoints: {
          ...current.checkpoints,
          firstAssistantDomTextAt: current.checkpoints?.firstAssistantDomTextAt ?? now,
          firstOverlayRenderAt: current.checkpoints?.firstOverlayRenderAt ?? now
        }
      }));
      if (activeRequest.kind === "starter") {
        updateLedgerTurn(
          activeRequest.turnId,
          (turn) => ({
            ...turn,
            starter: answer.text,
            status: "starter_streaming",
            requestKind: "starter",
            latency: {
              ...turn.latency,
              firstAnswerAt: turn.latency?.firstAnswerAt ?? now,
              lastRenderAt: now,
              checkpoints: {
                ...turn.latency?.checkpoints,
                firstAssistantDomTextAt: turn.latency?.checkpoints?.firstAssistantDomTextAt ?? now,
                firstOverlayRenderAt: turn.latency?.checkpoints?.firstOverlayRenderAt ?? now
              }
            }
          }),
          { hydrate: false }
        );
        engine.setStarterAnswer(answer.text, activeRequest.turnId);
      } else {
        updateLedgerTurn(
          activeRequest.turnId,
          (turn) => ({
            ...turn,
            answer: answer.text,
            answerHtml: answer.html,
            status: "final_streaming",
            requestKind: "final",
            latency: {
              ...turn.latency,
              firstAnswerAt: turn.latency?.firstAnswerAt ?? now,
              lastRenderAt: now,
              checkpoints: {
                ...turn.latency?.checkpoints,
                firstAssistantDomTextAt: turn.latency?.checkpoints?.firstAssistantDomTextAt ?? now,
                firstOverlayRenderAt: turn.latency?.checkpoints?.firstOverlayRenderAt ?? now
              }
            }
          }),
          { hydrate: false }
        );
        engine.setAssistantAnswer(answer.text, answer.html, activeRequest.turnId);
      }

      const stableDelayMs = activeRequest.kind === "starter" ? 650 : 1300;
      if (answerStableTimerRef.current) window.clearTimeout(answerStableTimerRef.current);
      answerStableTimerRef.current = window.setTimeout(() => {
        const answerStableAt = performance.now();
        const hadQueuedFollowUp = stateRef.current.queuedQuestions.length > 0;
        const completedRequest = activeRequestRef.current;
        activeRequestRef.current = null;
        if (completedRequest) {
          updateLedgerTurn(
            completedRequest.turnId,
            (turn) => ({
              ...turn,
              status: completedRequest.kind === "starter" ? "starter_done" : "done",
              requestKind: completedRequest.kind,
              latency: {
                ...turn.latency,
                lastRenderAt: answerStableAt,
                checkpoints: {
                  ...turn.latency?.checkpoints,
                  answerStableAt
                }
              }
            }),
            { hydrate: false }
          );
          if (completedRequest.kind === "final" && activeLedgerTurnIdRef.current === completedRequest.turnId) {
            activeLedgerTurnIdRef.current = undefined;
          }
        }
        engine.markIdle();
        setLatency((current) => ({
          ...current,
          status: "rendered",
          lastRenderAt: answerStableAt,
          checkpoints: {
            ...current.checkpoints,
            answerStableAt
          }
        }));
        setStatusText("Answer rendered");

        if (pendingFinalSendRef.current) {
          pendingFinalSendRef.current = false;
          pendingStarterQuestionRef.current = "";
          setStatusText("Starter rendered. Sending full answer prompt...");
          void sendToChatGpt();
        } else if (pendingStarterQuestionRef.current) {
          const nextStarterQuestion = pendingStarterQuestionRef.current;
          pendingStarterQuestionRef.current = "";
          setStatusText("Starter ready. Holding later chunks for final answer...");
          debug(`Held latest starter buffer locally: ${nextStarterQuestion.slice(0, 70)}`);
        } else if (hadQueuedFollowUp) {
          setStatusText("Sending queued follow-up to ChatGPT...");
          void sendToChatGpt();
        }
      }, stableDelayMs);
    });
  }, [adapter, engine]);

  useEffect(() => {
    if (latency.status !== "waiting" && latency.status !== "streaming") return;

    const interval = window.setInterval(() => {
      if (!latency.startedAt) return;
      setElapsedMs(performance.now() - latency.startedAt);
    }, 100);

    return () => window.clearInterval(interval);
  }, [adapter, latency.status, latency.startedAt]);

  useEffect(() => {
    if (state.phase !== "idle" || latency.status !== "streaming") return;
    setLatency((current) => ({ ...current, status: "rendered", lastRenderAt: performance.now() }));
  }, [state.phase, latency.status]);

  useEffect(() => {
    if (state.turns.length === 0) return;
    window.setTimeout(() => {
      scrollLatestTurnIntoView();
      updateActiveMarkerFromScroll();
    }, 80);
  }, [state.turns.length]);

  useEffect(() => {
    if (state.phase !== "generating") return;
    if (!state.currentAssistantAnswer.trim()) return;
    window.setTimeout(() => {
      scrollLatestTurnIntoView("end");
      updateActiveMarkerFromScroll();
    }, 30);
  }, [state.currentAssistantAnswer, state.phase]);

  useEffect(() => {
    const scroll = docScrollRef.current;
    if (!scroll) return;
    lastDocScrollTopRef.current = scroll.scrollTop;

    const handleScroll = () => {
      if (performance.now() < silentDocScrollUntilRef.current) return;
      updateAutoFollowFromManualScroll();
      scheduleSaveDocScrollTop();
      updateActiveMarkerFromScroll();
    };

    scroll.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      scroll.removeEventListener("scroll", handleScroll);
    };
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (flowDebounceRef.current) window.clearTimeout(flowDebounceRef.current);
      if (answerStableTimerRef.current) window.clearTimeout(answerStableTimerRef.current);
      if (saveScrollTimerRef.current) window.clearTimeout(saveScrollTimerRef.current);
      if (realtimeStarterTimerRef.current) window.clearTimeout(realtimeStarterTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isVoiceCapture) return;
    if (nativeStatusRef.current !== "disconnected" && nativeStatusRef.current !== "error") return;

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

  useEffect(() => {
    if (!liveDocSession) return;
    liveDocPublisher.publish(buildLiveDocSnapshot(liveDocSession));
  }, [
    liveDocSession,
    state,
    latency,
    elapsedMs,
    connection.status,
    nativeStatus,
    isVoiceCapture,
    readerTheme,
    readerViewMode,
    rollingQuestion.buffer,
    statusText,
    liveDocPublisher
  ]);

  function toggleVoiceCapture() {
    const next = !isVoiceCapture;
    setIsVoiceCapture(next);
    setTypedRole("interviewer");
    setStatusText(next ? "Dictara direct bridge ready. Start Dictara rolling mode." : "Dictara Capture stopped");
    debug(next ? "Dictara direct bridge enabled" : "Dictara Capture disabled");

    if (next) {
      nativeBridge.connect({
        onStatus: (status, message) => {
          nativeStatusRef.current = status;
          setNativeStatus(status);
          if (message) setStatusText(message);
        },
        onEvent: handleNativeEvent
      });

      if (nativeStatusRef.current === "disconnected" || nativeStatusRef.current === "error") {
        window.setTimeout(() => {
          const textarea = captureTextareaRef.current;
          textarea?.focus();
          const end = textarea?.value.length || 0;
          textarea?.setSelectionRange(end, end);
        }, 80);
      }
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
      captureTimelineEvent("listening", "Realtime capture started");
      setRollingQuestion(createEmptyRollingQuestion(event.sessionId));
      rollingQuestionRef.current = createEmptyRollingQuestion(event.sessionId);
      realtimeCaptureStartedAtRef.current = Date.now();
      if (realtimeStarterTimerRef.current) window.clearTimeout(realtimeStarterTimerRef.current);
      realtimeStarterTimerRef.current = undefined;
      activeLedgerTurnIdRef.current = undefined;
      setTypedText("");
      engine.clearPartialTranscript();
      setStatusText("Always listening. Fn sends, Control gets starter, long-hold Fn stops.");
      return;
    }

    if (event.type === "chunk_recording_started") {
      setNativeStatus("transcribing");
      nativeStatusRef.current = "transcribing";
      setStatusText(`Recording ${event.chunkId || "next chunk"}...`);
      return;
    }

    if (event.type === "transcript_delta") {
      setNativeStatus("capturing");
      nativeStatusRef.current = "capturing";
      captureTimelineEvent("transcript received");
      const text = event.text?.trim() || "";
      if (!text) return;

      const next: RollingQuestionState = {
        sessionId: event.sessionId || rollingQuestionRef.current.sessionId,
        chunks: [
          {
            chunkId: event.chunkId || `realtime-${Date.now()}`,
            text,
            completedAt: event.completedAt || Date.now()
          }
        ],
        buffer: text,
        starter: rollingQuestionRef.current.starter
      };
      rollingQuestionRef.current = next;
      setRollingQuestion(next);
      engine.ingestPartial("interviewer", next.buffer, starterMode);
      if (activeLedgerTurnIdRef.current && !activeRequestRef.current) {
        updateLedgerTurn(
          activeLedgerTurnIdRef.current,
          (turn) => ({ ...turn, question: next.buffer }),
          { hydrate: true }
        );
      }

      setTypedText("");
      setStatusText(starterPolicyRef.current.sentCount > 0 ? "Listening. Starter ready for this question." : "Listening. Press Fn to send or Control for starter.");
      return;
    }

    if (event.type === "chunk_transcribed" || event.type === "starter_updated") {
      setNativeStatus("capturing");
      nativeStatusRef.current = "capturing";
      setRollingQuestion((current) => {
        const next = event.type === "chunk_transcribed" ? appendTranscriptChunk(current, event) : { ...current, starter: event.starter || current.starter };
        if (next.buffer) {
          engine.ingestPartial("interviewer", next.buffer, starterMode);
        }
        return next;
      });
      if (event.type === "chunk_transcribed") setTypedText("");

      if (event.startedAt && event.completedAt) {
        setChunkTimingText(`last ${((event.completedAt - event.startedAt) / 1000).toFixed(1)}s · collect`);
      }
      setStatusText(starterPolicyRef.current.sentCount > 0 ? "Chunk transcribed. Holding for final answer." : "Chunk transcribed. Starter pending.");
      return;
    }

    if (event.type === "starter_requested") {
      const question = rollingQuestionRef.current.buffer.trim();
      if (!question) {
        setStatusText("No live question captured yet.");
        return;
      }
      void maybeSendStarterToChatGpt(question);
      return;
    }

    if (event.type === "question_finalized") {
      const eventReceivedAt = performance.now();
      const dictaraFinalTextAt = eventReceivedAt;
      setLatencyCheckpoint("extensionEventReceivedAt", eventReceivedAt);
      setLatencyCheckpoint("dictaraFinalTextAt", dictaraFinalTextAt);
      captureTimelineEvent("flushed", "Final question received from Dictara");
      const keepListening = nativeStatusRef.current === "capturing";
      if (realtimeStarterTimerRef.current) {
        window.clearTimeout(realtimeStarterTimerRef.current);
        realtimeStarterTimerRef.current = undefined;
      }
      if (!keepListening) realtimeCaptureStartedAtRef.current = undefined;
      setNativeStatus(keepListening ? "capturing" : "connected");
      nativeStatusRef.current = keepListening ? "capturing" : "connected";
      const question = event.text?.trim();
      if (!question) {
        setStatusText("No question text captured yet.");
        return;
      }

      starterSentRef.current = false;
      pendingStarterQuestionRef.current = "";
      lastStarterQuestionSentRef.current = "";
      const turn = ensureLedgerTurn(question);
      engine.finalizeActiveInterviewerQuestion(question, starterMode);
      updateLedgerTurn(
        turn.id,
        (current) => ({
          ...current,
          question,
          latency: {
            ...current.latency,
            checkpoints: {
              ...current.latency?.checkpoints,
              dictaraFinalTextAt,
              extensionEventReceivedAt: eventReceivedAt
            }
          }
        }),
        { hydrate: false }
      );
      const emptyQuestion = createEmptyRollingQuestion(event.sessionId);
      setRollingQuestion(emptyQuestion);
      rollingQuestionRef.current = emptyQuestion;
      starterPolicyRef.current = { sentCount: 0, maxCount: 1 };
      pendingStarterQuestionRef.current = "";

      if (activeRequestRef.current?.kind === "starter") {
        pendingFinalSendRef.current = true;
        setStatusText("Question finalized. Waiting for starter before full answer...");
      } else {
        setStatusText("Question finalized. Sending full answer to ChatGPT...");
        void sendToChatGpt();
      }
      return;
    }

    if (event.type === "buffer_cleared") {
      if (realtimeStarterTimerRef.current) {
        window.clearTimeout(realtimeStarterTimerRef.current);
        realtimeStarterTimerRef.current = undefined;
      }
      setRollingQuestion(createEmptyRollingQuestion(event.sessionId));
      rollingQuestionRef.current = createEmptyRollingQuestion(event.sessionId);
      starterSentRef.current = false;
      starterPolicyRef.current = { sentCount: 0, maxCount: 1 };
      pendingStarterQuestionRef.current = "";
      lastStarterQuestionSentRef.current = "";
      activeLedgerTurnIdRef.current = undefined;
      engine.clearPartialTranscript();
      setTypedText("");
      captureTimelineEvent("cleared", "Live question buffer cleared");
      setStatusText("Live buffer cleared. Still listening.");
      return;
    }

    if (event.type === "realtime_reconnecting") {
      setNativeStatus("transcribing");
      nativeStatusRef.current = "transcribing";
      captureTimelineEvent("reconnecting", event.error || "Realtime reconnecting");
      setStatusText("Realtime reconnecting...");
      return;
    }

    if (event.type === "realtime_reconnected") {
      setNativeStatus("capturing");
      nativeStatusRef.current = "capturing";
      captureTimelineEvent("connected", "Realtime transcription reconnected");
      setStatusText("Realtime reconnected. Still listening.");
      return;
    }

    if (event.type === "realtime_failed") {
      setNativeStatus("error");
      nativeStatusRef.current = "error";
      captureTimelineEvent("error", event.error || "Realtime failed");
      setStatusText(event.error || "Realtime transcription failed.");
      return;
    }

    if (event.type === "capture_stopped") {
      if (realtimeStarterTimerRef.current) {
        window.clearTimeout(realtimeStarterTimerRef.current);
        realtimeStarterTimerRef.current = undefined;
      }
      realtimeCaptureStartedAtRef.current = undefined;
      setNativeStatus("connected");
      nativeStatusRef.current = "connected";
      captureTimelineEvent("stopped", "Realtime capture stopped");
      setStatusText("Rolling capture stopped.");
      return;
    }

    if (event.type === "transcription_error") {
      if (realtimeStarterTimerRef.current) {
        window.clearTimeout(realtimeStarterTimerRef.current);
        realtimeStarterTimerRef.current = undefined;
      }
      realtimeCaptureStartedAtRef.current = undefined;
      setNativeStatus("error");
      nativeStatusRef.current = "error";
      captureTimelineEvent("error", event.error || "Native transcription failed");
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
    if (!hasFinalizeMarker && !finalizeAfterNextChunkRef.current) return;

    const text = extractNewDictaraText(value);
    if (!text && !hasFinalizeMarker) return;

    setStatusText("Dictara pasted a chunk. Adding it to the rolling question...");
    debug(`Dictara paste input: ${text.slice(0, 70)}`);

    const processDictaraPaste = () => {
      const rawChunkText = captureTextareaRef.current?.value || "";
      const shouldFinalize = rawChunkText.includes(LIVE_ASSIST_FINALIZE_MARKER) || finalizeAfterNextChunkRef.current;
      const chunkText = extractNewDictaraText(rawChunkText);
      if (!chunkText || chunkText === lastFlowSubmittedRef.current) {
        if (shouldFinalize) {
          setTypedText("");
          finalizeAfterNextChunkRef.current = false;
          finalizeRollingPasteQuestion();
        }
        return;
      }

      lastFlowSubmittedRef.current = chunkText;
      appendRollingPasteChunk(chunkText, { skipStarter: shouldFinalize });
      setTypedText("");
      setStatusText(shouldFinalize ? "Final Dictara chunk added. Sending..." : "Dictara chunk added. Continue speaking or press Finalize.");
      debug(`Dictara chunk added as ${typedRole}: ${chunkText.slice(0, 70)}`);

      if (shouldFinalize) {
        finalizeAfterNextChunkRef.current = false;
        finalizeRollingPasteQuestion();
      }

      if (isVoiceCapture) {
        window.setTimeout(() => {
          const textarea = captureTextareaRef.current;
          textarea?.focus();
          const end = textarea?.value.length || 0;
          textarea?.setSelectionRange(end, end);
        }, 120);
      }
    };

    if (hasFinalizeMarker || finalizeAfterNextChunkRef.current) {
      if (flowDebounceRef.current) window.clearTimeout(flowDebounceRef.current);
      flowDebounceRef.current = undefined;
      queueMicrotask(processDictaraPaste);
      return;
    }

    if (flowDebounceRef.current) window.clearTimeout(flowDebounceRef.current);
    flowDebounceRef.current = window.setTimeout(processDictaraPaste, 150);
  }

  function appendRollingPasteChunk(text: string, options: { skipStarter?: boolean } = {}) {
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
      if (typedRole === "interviewer" && !options.skipStarter) {
        void maybeSendStarterToChatGpt(next.buffer);
      }
    }
  }

  async function maybeSendStarterToChatGpt(partialQuestion: string) {
    const normalizedQuestion = partialQuestion.trim();
    if (normalizedQuestion.length < 10) return;
    if (starterPolicyRef.current.sentCount >= starterPolicyRef.current.maxCount) {
      setStatusText("Chunk added locally. Holding full question until release.");
      return;
    }
    if (normalizedQuestion === lastStarterQuestionSentRef.current) return;
    if (pendingFinalSendRef.current) return;
    if (activeRequestRef.current) {
      if (activeRequestRef.current.kind === "starter") {
        pendingStarterQuestionRef.current = normalizedQuestion;
        setStatusText("Starter is generating. Holding newer chunks locally.");
      }
      return;
    }

    starterSentRef.current = true;
    starterPolicyRef.current.sentCount += 1;
    lastStarterQuestionSentRef.current = normalizedQuestion;
    const promptBuildStartedAt = performance.now();
    const prompt = engine.buildStarterPromptForQuestion(normalizedQuestion);
    if (!prompt.ok) {
      starterSentRef.current = false;
      starterPolicyRef.current.sentCount = Math.max(0, starterPolicyRef.current.sentCount - 1);
      lastStarterQuestionSentRef.current = "";
      return;
    }

    const connectionState = adapter.checkConnection();
    setConnection(connectionState);
    if (connectionState.status !== "connected") {
      starterSentRef.current = false;
      starterPolicyRef.current.sentCount = Math.max(0, starterPolicyRef.current.sentCount - 1);
      lastStarterQuestionSentRef.current = "";
      setStatusText(connectionState.message || "ChatGPT page connection lost.");
      return;
    }

    try {
      const startedAt = performance.now();
      const assistantStartCount = adapter.assistantCount();
      const ignoredAnswerText = latestAssistantText();
      const turn = ensureLedgerTurn(prompt.question);
      activeRequestRef.current = {
        turnId: turn.id,
        question: prompt.question,
        assistantStartCount,
        kind: "starter",
        ignoredAnswerText
      };
      firstAnswerNotifiedForRequestRef.current = undefined;
      updateLedgerTurn(
        turn.id,
        (current) => ({
          ...current,
          question: prompt.question,
          status: "starter_waiting",
          requestKind: "starter",
          latency: {
            ...current.latency,
            startedAt,
            checkpoints: {
              ...current.latency?.checkpoints,
              promptBuildStartedAt
            }
          }
        }),
        { hydrate: true }
      );
      setElapsedMs(0);
      setLatency({ status: "waiting", startedAt, checkpoints: { promptBuildStartedAt } });
      engine.markGeneratingStarter(prompt.question, turn.id);
      setStatusText("Sending starter to ChatGPT...");
      await adapter.sendPrompt(prompt.prompt, chatGptSendTimings(turn.id));
      const submittedAt = performance.now();
      updateLedgerTurn(
        turn.id,
        (current) => ({
          ...current,
          latency: {
            ...current.latency,
            submittedAt
          }
        }),
        { hydrate: false }
      );
      setLatency((current) => ({ ...current, submittedAt }));
      setStatusText("Starter prompt sent to ChatGPT");
    } catch (error) {
      const failedRequest = activeRequestRef.current;
      activeRequestRef.current = null;
      if (failedRequest) {
        updateLedgerTurn(failedRequest.turnId, (turn) => ({ ...turn, status: "send_failed", error: error instanceof Error ? error.message : "Unable to send starter prompt" }), { hydrate: true });
      }
      starterSentRef.current = false;
      starterPolicyRef.current.sentCount = Math.max(0, starterPolicyRef.current.sentCount - 1);
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

    const rawPendingText = captureTextareaRef.current?.value.trim() || typedText.trim();
    const pendingText = isVoiceCapture ? extractNewDictaraText(rawPendingText) : rawPendingText;
    if (pendingText && pendingText !== lastFlowSubmittedRef.current) {
      lastFlowSubmittedRef.current = pendingText;
      appendRollingPasteChunk(pendingText, { skipStarter: true });
    }

    const question = rollingQuestionRef.current.buffer.trim();
    if (!question) {
      setStatusText("No Dictara chunks captured yet.");
      return;
    }

    if (typedRole === "interviewer") {
      const turn = ensureLedgerTurn(question);
      engine.finalizeActiveInterviewerQuestion(question, starterMode);
      updateLedgerTurn(
        turn.id,
        (current) => ({
          ...current,
          question,
          status: activeRequestRef.current?.kind === "starter" ? current.status : "draft"
        }),
        { hydrate: false }
      );
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
      starterPolicyRef.current = { sentCount: 0, maxCount: 1 };
      pendingStarterQuestionRef.current = "";
      if (activeRequestRef.current) {
        pendingFinalSendRef.current = true;
        setStatusText("Final question ready. Waiting for starter response to finish...");
      } else {
        void sendToChatGpt();
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

    const promptBuildStartedAt = performance.now();
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
      const turn = ensureLedgerTurn(prompt.question);
      activeRequestRef.current = {
        turnId: turn.id,
        question: prompt.question,
        assistantStartCount,
        kind: "final",
        ignoredAnswerText
      };
      firstAnswerNotifiedForRequestRef.current = undefined;
      updateLedgerTurn(
        turn.id,
        (current) => ({
          ...current,
          question: prompt.question,
          status: "final_waiting",
          requestKind: "final",
          latency: {
            ...current.latency,
            startedAt,
            checkpoints: {
              ...current.latency?.checkpoints,
              promptBuildStartedAt
            }
          }
        }),
        { hydrate: true }
      );
      setElapsedMs(0);
      setLatency({ status: "waiting", startedAt, checkpoints: { promptBuildStartedAt } });
      engine.markGenerating(prompt.question, turn.id);
      await adapter.sendPrompt(prompt.prompt, chatGptSendTimings(turn.id));
      const submittedAt = performance.now();
      updateLedgerTurn(
        turn.id,
        (current) => ({
          ...current,
          latency: {
            ...current.latency,
            submittedAt
          }
        }),
        { hydrate: false }
      );
      setLatency((current) => ({ ...current, submittedAt }));
      setStatusText("Prompt sent to ChatGPT");
      debug("Prompt sent to ChatGPT");
    } catch (error) {
      const failedRequest = activeRequestRef.current;
      activeRequestRef.current = null;
      if (failedRequest) {
        updateLedgerTurn(failedRequest.turnId, (turn) => ({ ...turn, status: "send_failed", error: error instanceof Error ? error.message : "Unable to send prompt" }), { hydrate: true });
      }
      engine.markIdle();
      debug(`Send exception: ${error instanceof Error ? error.message : String(error)}`);
      setStatusText(error instanceof Error ? error.message : "Unable to send prompt");
    }
  }

  async function savePromptSettingsDraft() {
    const validation = validatePromptSettings(draftPromptSettings);
    setPromptSettingsWarnings(validation.warnings);
    if (!validation.ok) {
      setPromptSettingsMessage(validation.errors.join(" "));
      return;
    }

    try {
      await savePromptSettings(draftPromptSettings);
      engine.setPromptSettings(draftPromptSettings);
      setPromptSettings(draftPromptSettings);
      setPromptSettingsMessage(validation.warnings.length ? `Saved with ${validation.warnings.length} warning${validation.warnings.length === 1 ? "" : "s"}.` : "Prompt settings saved.");
      debug("Prompt settings saved");
    } catch (error) {
      setPromptSettingsMessage(error instanceof Error ? error.message : "Unable to save prompt settings.");
    }
  }

  async function saveLiveDocServerUrlDraft() {
    const nextUrl = normalizeDocsServerUrl(draftLiveDocServerUrl);
    try {
      await saveStoredLiveDocServerUrl(nextUrl);
      liveDocPublisher.setServerUrl(nextUrl);
      setLiveDocServerUrl(nextUrl);
      setDraftLiveDocServerUrl(nextUrl);
      liveDocPublisher.disconnect();
      setLiveDocSession(undefined);
      setLiveDocStatus("off");
      setLiveDocMessage("Not shared");
      await clearStoredLiveDocSession(conversationIdRef.current);
      setStatusText("Share server URL saved. Create a new share link.");
      setPromptSettingsMessage("Share server URL saved.");
      debug(`Share server URL saved: ${nextUrl}`);
    } catch (error) {
      setPromptSettingsMessage(error instanceof Error ? error.message : "Unable to save share server URL.");
    }
  }

  function resetPromptSettingsDraft(kind: "starter" | "final" | "all") {
    setDraftPromptSettings((current) => {
      if (kind === "starter") return { ...current, starterPrompt: DEFAULT_PROMPT_SETTINGS.starterPrompt };
      if (kind === "final") return { ...current, finalPrompt: DEFAULT_PROMPT_SETTINGS.finalPrompt };
      return DEFAULT_PROMPT_SETTINGS;
    });
    setPromptSettingsMessage(kind === "all" ? "All prompt drafts reset. Save to apply." : "Prompt draft reset. Save to apply.");
    setPromptSettingsWarnings([]);
  }

  function promptPreviewText() {
    const values = {
      partialQuestion: rollingQuestion.buffer || state.partialTranscript?.text || "Can you walk me through how you would debug this login issue?",
      currentQuestion: state.currentQuestion || rollingQuestion.buffer || "Can you walk me through how you would debug this login issue?",
      starter: state.provisionalStarter?.text || "",
      candidateSpeech: state.lastCandidateSpeech || "Not captured yet."
    };

    return compilePromptTemplate(
      promptPreviewKind === "starter" ? draftPromptSettings.starterPrompt : draftPromptSettings.finalPrompt,
      values
    );
  }

  function footerSubmit() {
    const value = typedText.trim();
    if (!value) {
      setStatusText("Type a question first.");
      return;
    }

    void sendManualTextToChatGpt(value);
  }

  async function sendManualTextToChatGpt(text: string) {
    const question = text.trim();
    if (!question) return;

    const connectionState = adapter.checkConnection();
    setConnection(connectionState);
    if (connectionState.status !== "connected") {
      setStatusText(connectionState.message || "ChatGPT page connection lost.");
      return;
    }

    const turn = ensureLedgerTurn(question);
    const promptBuildStartedAt = performance.now();
    updateLedgerTurn(
      turn.id,
      (current) => ({
        ...current,
        question,
        status: "final_waiting",
        requestKind: "final",
        latency: {
          ...current.latency,
          startedAt: promptBuildStartedAt,
          checkpoints: {
            ...current.latency?.checkpoints,
            promptBuildStartedAt
          }
        }
      }),
      { hydrate: true }
    );

    try {
      const startedAt = performance.now();
      const assistantStartCount = adapter.assistantCount();
      const ignoredAnswerText = latestAssistantText();
      activeRequestRef.current = {
        turnId: turn.id,
        question,
        assistantStartCount,
        kind: "final",
        ignoredAnswerText
      };
      firstAnswerNotifiedForRequestRef.current = undefined;
      setTypedText("");
      setElapsedMs(0);
      setLatency({ status: "waiting", startedAt, checkpoints: { promptBuildStartedAt } });
      engine.markGenerating(question, turn.id);
      setStatusText("Sending direct message to ChatGPT...");
      await adapter.sendPrompt(question, chatGptSendTimings(turn.id));
      const submittedAt = performance.now();
      updateLedgerTurn(
        turn.id,
        (current) => ({
          ...current,
          latency: {
            ...current.latency,
            submittedAt
          }
        }),
        { hydrate: false }
      );
      setLatency((current) => ({ ...current, submittedAt }));
      setStatusText("Direct message sent to ChatGPT");
      debug("Manual direct message sent to ChatGPT");
    } catch (error) {
      activeRequestRef.current = null;
      updateLedgerTurn(turn.id, (current) => ({ ...current, status: "send_failed", error: error instanceof Error ? error.message : "Unable to send direct message" }), { hydrate: true });
      engine.markIdle();
      setStatusText(error instanceof Error ? error.message : "Unable to send direct message");
      debug(`Manual direct send exception: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function captureDisplayValue() {
    return typedText;
  }

  function extractNewDictaraText(rawValue: string) {
    const withoutMarker = rawValue.replaceAll(LIVE_ASSIST_FINALIZE_MARKER, "").trim();
    const currentBuffer = rollingQuestionRef.current.buffer.trim();

    if (!currentBuffer || !withoutMarker.startsWith(currentBuffer)) {
      return withoutMarker;
    }

    return withoutMarker.slice(currentBuffer.length).trim();
  }

  function clearSession() {
    engine.reset();
    starterPolicyRef.current = { sentCount: 0, maxCount: 1 };
    ledgerTurnsRef.current = [];
    activeLedgerTurnIdRef.current = undefined;
    void clearStoredChatTurns(conversationIdRef.current);
    void clearTurnLedger(conversationIdRef.current);
    setStatusText("Session cleared");
    debug("Session cleared");
  }

  async function shareLiveDocSession() {
    try {
      if (liveDocSession?.viewUrl) {
        await copyShareLink(liveDocSession.viewUrl);
        setStatusText("Share link copied");
        return;
      }

      const session = await liveDocPublisher.createSession(conversationIdRef.current);
      await saveStoredLiveDocSession(conversationIdRef.current, session);
      setLiveDocSession(session);
      liveDocPublisher.connect(session);
      liveDocPublisher.publish(buildLiveDocSnapshot(session));
      await copyShareLink(session.viewUrl);
      setStatusText("Share session created and link copied");
      debug(`Share session created: ${session.viewUrl}`);
    } catch (error) {
      setLiveDocStatus("error");
      setLiveDocMessage(error instanceof Error ? error.message : "Unable to create share session");
      setStatusText(error instanceof Error ? error.message : "Unable to create share session");
      debug(`Share session failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function copyShareLink(url: string) {
    await navigator.clipboard.writeText(url).catch(() => undefined);
  }

  function buildLiveDocSnapshot(session: StoredLiveDocSession): LiveDocSnapshot {
    return {
      schemaVersion: 1,
      sessionId: session.sessionId,
      chatConversationId: conversationIdRef.current,
      title: "Interview Notes",
      theme: readerTheme,
      viewMode: readerViewMode,
      turns: stateRef.current.turns.map(conversationTurnToLiveDocTurn),
      partialQuestion: stateRef.current.partialTranscript?.text || rollingQuestionRef.current.buffer || undefined,
      status: buildLiveDocStatus({
        connection,
        nativeStatus,
        isVoiceCapture,
        latency,
        statusText
      }),
      latency: buildLiveDocLatency(latency, elapsedMs),
      updatedAt: Date.now()
    };
  }

  if (!isOpen) {
    return (
      <button className="gptd-mini-tab" onClick={openOverlay} title="Open GPTDisguise Live Assist">
        <FileText size={18} />
      </button>
    );
  }

  const statuses = buildTopStatuses({
    nativeStatus,
    nativeEngine,
    isVoiceCapture,
    latency,
    rollingQuestion,
    liveDocStatus
  });
  const visibleTurns = state.turns;
  const liveQuestionText = rollingQuestion.buffer.trim();

  return (
    <section className={`gptd-shell ${readerTheme}`} aria-label="GPTDisguise interview reader">
      <header className="gptd-topbar">
        <div className="gptd-status-strip" aria-label="System status">
          {statuses.map((status) => (
            <div className="gptd-status-chip" key={status.name} title={status.title}>
              <span className={`gptd-status-light ${status.state}`} />
              <div>
                <span>{status.name}</span>
                <strong>{status.value}</strong>
              </div>
            </div>
          ))}
        </div>

        <SegmentedControl
          options={[
            { value: "reader", label: "Reader" },
            { value: "focus", label: "Focus" }
          ]}
          value={readerViewMode}
          onChange={setReaderViewMode}
        />

        <SegmentedControl
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" }
          ]}
          value={readerTheme}
          onChange={setReaderTheme}
        />

        <LatencyPill latency={latency} elapsedMs={elapsedMs} />
        <LatencyDetails latency={latency} />
        <button className={liveDocSession ? "gptd-top-action active" : "gptd-top-action"} onClick={() => void shareLiveDocSession()} title={liveDocSession?.viewUrl || liveDocMessage}>
          <Share2 size={14} />
          {liveDocSession ? "Copy link" : "Share session"}
        </button>
        <button className={isSettingsOpen ? "gptd-round-button active" : "gptd-round-button"} onClick={() => setIsSettingsOpen((current) => !current)} title="Prompt settings">
            <Settings size={18} />
        </button>
        <button className="gptd-top-action" onClick={clearSession}>Clear</button>
        <button className="gptd-round-button" onClick={closeOverlay} title="Reveal ChatGPT">
            <X size={18} />
        </button>
      </header>

      <main className="gptd-reader-scroll" ref={docScrollRef}>
        <section className={`gptd-reader-content ${readerViewMode}`}>
          {visibleTurns.length === 0 ? (
            <div className="gptd-empty">Waiting for the next question...</div>
          ) : (
            <>
              <TurnCards turns={visibleTurns} activeTurnId={state.activeTurnId} phase={state.phase} viewMode={readerViewMode} />
              {state.queuedQuestions.length > 0 && (
                <div className="gptd-queue">
                  <span>Queued follow-ups</span>
                  {state.queuedQuestions.map((question) => (
                    <p key={question.id}>{question.text}</p>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
        <QuestionMarkerRail turns={visibleTurns} activeIndex={activeMarkerIndex} onSelect={scrollToTurn} />
      </main>

      <NextQuestionPanel
        question={liveQuestionText}
        starter={state.provisionalStarter?.text}
        nativeStatus={nativeStatus}
        timeline={captureTimeline}
      />

      <footer className="gptd-compose">
        <div className="gptd-compose-inner">
          <textarea
            ref={captureTextareaRef}
            className={isVoiceCapture ? "flow-active" : ""}
            value={captureDisplayValue()}
            rows={1}
            onChange={(event) => handleCaptureTextChange(event.target.value)}
            onFocus={() => {
              if (isVoiceCapture) debug("Capture input focused");
            }}
            placeholder={isVoiceCapture ? "Dictara chunks appear here; type a follow-up or note..." : "Type a follow-up or note..."}
            onKeyDown={(event) => {
              if (event.altKey && event.key === "Enter") {
                event.preventDefault();
                finalizeAfterNextChunkRef.current = true;
                setStatusText("Waiting for Dictara to paste the final chunk...");
                debug("Dictara finalize requested; waiting for final paste");
                return;
              }

              if (event.key === "Enter" && !event.shiftKey) event.preventDefault();
            }}
          />
          <button className="gptd-send-button" onClick={footerSubmit} disabled={!typedText.trim() || latency.status === "waiting" || latency.status === "streaming"}>
            Send
          </button>
        </div>
      </footer>

      {isSettingsOpen && (
        <PromptSettingsDrawer
          draft={draftPromptSettings}
          saved={promptSettings}
          message={promptSettingsMessage}
          warnings={promptSettingsWarnings}
          liveDocServerUrl={draftLiveDocServerUrl}
          previewKind={promptPreviewKind}
          previewText={promptPreviewText()}
          onDraftChange={setDraftPromptSettings}
          onLiveDocServerUrlChange={setDraftLiveDocServerUrl}
          onSaveLiveDocServerUrl={() => void saveLiveDocServerUrlDraft()}
          onPreviewKindChange={setPromptPreviewKind}
          onSave={() => void savePromptSettingsDraft()}
          onReset={resetPromptSettingsDraft}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}
    </section>
  );
}

function PromptSettingsDrawer({
  draft,
  saved,
  message,
  warnings,
  liveDocServerUrl,
  previewKind,
  previewText,
  onDraftChange,
  onLiveDocServerUrlChange,
  onSaveLiveDocServerUrl,
  onPreviewKindChange,
  onSave,
  onReset,
  onClose
}: {
  draft: PromptSettings;
  saved: PromptSettings;
  message: string;
  warnings: string[];
  liveDocServerUrl: string;
  previewKind: "starter" | "final";
  previewText: string;
  onDraftChange: React.Dispatch<React.SetStateAction<PromptSettings>>;
  onLiveDocServerUrlChange: (value: string) => void;
  onSaveLiveDocServerUrl: () => void;
  onPreviewKindChange: (kind: "starter" | "final") => void;
  onSave: () => void;
  onReset: (kind: "starter" | "final" | "all") => void;
  onClose: () => void;
}) {
  const validation = validatePromptSettings(draft);
  const isDirty = draft.starterPrompt !== saved.starterPrompt || draft.finalPrompt !== saved.finalPrompt;

  return (
    <aside className="gptd-settings-drawer" aria-label="Prompt settings">
      <div className="gptd-settings-header">
        <div>
          <strong>Prompt settings</strong>
          <span>{isDirty ? "Unsaved changes" : "Saved locally"}</span>
        </div>
        <button className="gptd-icon-button" onClick={onClose} title="Close settings">
          <X size={18} />
        </button>
      </div>

      <div className="gptd-settings-body">
        <section className="gptd-prompt-editor">
          <div className="gptd-settings-section-title">
            <div>
              <strong>Share server URL</strong>
              <span>Use a tunnel or public docs server URL for external viewers.</span>
            </div>
            <button className="gptd-tool" onClick={onSaveLiveDocServerUrl}>Save URL</button>
          </div>
          <input
            value={liveDocServerUrl}
            onChange={(event) => onLiveDocServerUrlChange(event.target.value)}
            placeholder={defaultDocsServerUrl()}
            spellCheck={false}
          />
        </section>

        <PromptEditor
          title="Starter prompt"
          description="Sent once after the first 10 second chunk."
          value={draft.starterPrompt}
          onChange={(value) => onDraftChange((current) => ({ ...current, starterPrompt: value }))}
          onReset={() => onReset("starter")}
        />

        <PromptEditor
          title="Final answer prompt"
          description="Sent once when the full question is finalized."
          value={draft.finalPrompt}
          onChange={(value) => onDraftChange((current) => ({ ...current, finalPrompt: value }))}
          onReset={() => onReset("final")}
        />

        <section className="gptd-settings-preview">
          <div className="gptd-settings-section-title">
            <strong>Preview</strong>
            <div className="gptd-settings-segment">
              <button className={previewKind === "starter" ? "selected" : ""} onClick={() => onPreviewKindChange("starter")}>Starter</button>
              <button className={previewKind === "final" ? "selected" : ""} onClick={() => onPreviewKindChange("final")}>Final</button>
            </div>
          </div>
          <pre>{previewText}</pre>
        </section>

        <section className="gptd-settings-help">
          <strong>Variables</strong>
          <code>{"{{partialQuestion}}"}</code>
          <code>{"{{currentQuestion}}"}</code>
          <code>{"{{starter}}"}</code>
          <code>{"{{candidateSpeech}}"}</code>
        </section>
      </div>

      <div className="gptd-settings-footer">
        <div className={validation.ok ? "gptd-settings-message" : "gptd-settings-message error"}>
          {validation.ok ? message : validation.errors.join(" ")}
          {warnings.length > 0 && validation.ok ? ` ${warnings.join(" ")}` : ""}
        </div>
        <button className="gptd-tool" onClick={() => onReset("all")}>Reset all</button>
        <button className="gptd-tool primary" onClick={onSave} disabled={!validation.ok}>Save</button>
      </div>
    </aside>
  );
}

function PromptEditor({
  title,
  description,
  value,
  onChange,
  onReset
}: {
  title: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  return (
    <section className="gptd-prompt-editor">
      <div className="gptd-settings-section-title">
        <div>
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
        <button className="gptd-tool" onClick={onReset}>Reset</button>
      </div>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
    </section>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="gptd-segment-pill">
      {options.map((option) => (
        <button key={option.value} className={value === option.value ? "selected" : ""} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function buildTopStatuses({
  nativeStatus,
  nativeEngine,
  isVoiceCapture,
  latency,
  rollingQuestion,
  liveDocStatus
}: {
  nativeStatus: NativeBridgeStatus;
  nativeEngine: TranscriptionEngine;
  isVoiceCapture: boolean;
  latency: LatencyState;
  rollingQuestion: RollingQuestionState;
  liveDocStatus: LiveDocPublisherStatus;
}) {
  const bridgeValue = `${nativeStatusLabel(nativeStatus)} · ${nativeEngine}`;
  const questionValue = rollingQuestion.buffer ? `${rollingQuestion.chunks.length || 1} chunk${rollingQuestion.chunks.length === 1 ? "" : "s"}` : "waiting";

  return [
    {
      name: "Bridge",
      value: bridgeValue,
      title: `Dictara bridge — ${bridgeValue}`,
      state: nativeStatus === "connected" || nativeStatus === "capturing" ? "ok" : nativeStatus === "transcribing" || nativeStatus === "connecting" ? "warn" : nativeStatus === "error" ? "bad" : "off"
    },
    {
      name: "Capture",
      value: isVoiceCapture ? "direct" : "off",
      title: `Capture — ${isVoiceCapture ? "direct Dictara" : "off"}`,
      state: isVoiceCapture ? "ok" : "off"
    },
    {
      name: "Answer",
      value: answerStatusLabel(latency.status),
      title: `Answer — ${answerStatusLabel(latency.status)}`,
      state: latency.status === "waiting" || latency.status === "streaming" ? "pulse" : "off"
    },
    {
      name: "Question",
      value: questionValue,
      title: `Question — ${questionValue}`,
      state: rollingQuestion.buffer ? "warn" : "off"
    },
    {
      name: "Share",
      value: liveDocStatusLabel(liveDocStatus),
      title: `Share — ${liveDocStatusLabel(liveDocStatus)}`,
      state: liveDocStatus === "connected" ? "ok" : liveDocStatus === "creating" || liveDocStatus === "connecting" ? "warn" : liveDocStatus === "error" ? "bad" : "off"
    }
  ];
}

function conversationTurnToLiveDocTurn(turn: ConversationTurn) {
  return {
    id: turn.id,
    question: turn.question,
    starter: turn.starter,
    answer: turn.answer,
    answerHtml: turn.answerHtml,
    questionAttachments: [
      ...imageAttachmentsToLiveDoc(turn.questionImages),
      ...fileAttachmentsToLiveDoc(turn.questionFiles)
    ],
    answerAttachments: [
      ...imageAttachmentsToLiveDoc(turn.answerImages),
      ...fileAttachmentsToLiveDoc(turn.answerFiles)
    ],
    createdAt: turn.createdAt,
    updatedAt: Date.now()
  };
}

function imageAttachmentsToLiveDoc(images?: ChatGptImageAttachment[]): LiveDocAttachment[] {
  return (images || []).map((image) => {
    if (image.src.startsWith("blob:")) {
      return {
        type: "file",
        name: image.alt || "Private image attachment",
        kind: "Image"
      };
    }

    return {
      type: "image",
      src: image.src,
      alt: image.alt,
      width: image.width,
      height: image.height,
      name: image.alt || "Image attachment"
    };
  });
}

function fileAttachmentsToLiveDoc(files?: ChatGptFileAttachment[]): LiveDocAttachment[] {
  return (files || []).map((file) => ({
    type: "file",
    href: file.href,
    name: file.name,
    kind: file.kind
  }));
}

function buildLiveDocStatus({
  connection,
  nativeStatus,
  isVoiceCapture,
  latency,
  statusText
}: {
  connection: ChatGptConnectionState;
  nativeStatus: NativeBridgeStatus;
  isVoiceCapture: boolean;
  latency: LatencyState;
  statusText: string;
}): LiveDocStatus {
  return {
    chatGpt: connection.status,
    dictara: nativeStatus,
    capture: nativeStatus === "capturing" ? "capturing" : nativeStatus === "transcribing" ? "transcribing" : isVoiceCapture ? "ready" : "off",
    answer: latency.status,
    message: statusText
  };
}

function buildLiveDocLatency(latency: LatencyState, elapsedMs: number): LiveDocLatency {
  const submittedMs = latency.startedAt && latency.submittedAt ? latency.submittedAt - latency.startedAt : undefined;
  const firstAnswerMs = latency.startedAt && latency.firstAnswerAt ? latency.firstAnswerAt - latency.startedAt : undefined;
  const totalMs = latency.startedAt && latency.lastRenderAt ? latency.lastRenderAt - latency.startedAt : undefined;
  return {
    status: latency.status,
    elapsedMs: latency.status === "waiting" || latency.status === "streaming" ? elapsedMs : totalMs,
    submittedMs,
    firstAnswerMs,
    totalMs
  };
}

function liveDocStatusLabel(status: LiveDocPublisherStatus) {
  if (status === "creating") return "creating";
  if (status === "connecting") return "connecting";
  if (status === "connected") return "live";
  if (status === "error") return "offline";
  return "off";
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

function SystemStatusPanel({
  connection,
  nativeStatus,
  captureEnabled,
  latency,
  rollingQuestion,
  nativeEngine,
  chunkTimingText
}: {
  connection: ChatGptConnectionState;
  nativeStatus: NativeBridgeStatus;
  captureEnabled: boolean;
  latency: LatencyState;
  rollingQuestion: RollingQuestionState;
  nativeEngine: TranscriptionEngine;
  chunkTimingText: string;
}) {
  const items = [
    {
      label: "ChatGPT",
      value: connection.status === "connected" ? "connected" : connection.status === "checking" ? "checking" : "lost",
      state: connection.status === "connected" ? "ok" : connection.status === "checking" ? "pending" : "bad"
    },
    {
      label: "Dictara bridge",
      value: `${nativeStatusLabel(nativeStatus)} · ${nativeEngine}`,
      state: nativeStatus === "connected" || nativeStatus === "capturing" ? "ok" : nativeStatus === "transcribing" || nativeStatus === "connecting" ? "pending" : nativeStatus === "error" ? "bad" : "off"
    },
    {
      label: "Capture",
      value: captureEnabled ? `${chunkTimingText} · direct` : "off",
      state: captureEnabled ? "ok" : "off"
    },
    {
      label: "Answer",
      value: answerStatusLabel(latency.status),
      state: latency.status === "idle" || latency.status === "rendered" ? "ok" : "pending"
    },
    {
      label: "Question",
      value: rollingQuestion.buffer ? `${rollingQuestion.chunks.length || 1} chunk${rollingQuestion.chunks.length === 1 ? "" : "s"}` : "waiting",
      state: rollingQuestion.buffer ? "pending" : "off"
    }
  ];

  return (
    <section className="gptd-status-panel" aria-label="Connection status">
      <div className="gptd-panel-title">Status</div>
      {items.map((item) => (
        <div className="gptd-status-row" key={item.label}>
          <span className={`gptd-status-dot ${item.state}`} />
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
      {rollingQuestion.buffer && <p className="gptd-status-transcript">{rollingQuestion.buffer}</p>}
    </section>
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

function answerStatusLabel(status: LatencyState["status"]) {
  if (status === "waiting") return "waiting";
  if (status === "streaming") return "streaming";
  if (status === "rendered") return "rendered";
  return "idle";
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

function LatencyDetails({ latency }: { latency: LatencyState }) {
  const checkpoints = latency.checkpoints || {};
  const rows = [
    ["Dictara final text", checkpoints.dictaraFinalTextAt],
    ["Extension received", checkpoints.extensionEventReceivedAt],
    ["Prompt build", checkpoints.promptBuildStartedAt],
    ["Composer start", checkpoints.composerInsertStartedAt],
    ["Composer ready", checkpoints.composerInsertCompletedAt],
    ["Send click", checkpoints.sendClickedAt],
    ["First answer", latency.firstAnswerAt],
    ["Rendered", latency.lastRenderAt]
  ] as const;

  return (
    <details className="gptd-latency-details">
      <summary>Timing</summary>
      <div>
        {rows.map(([label, value]) => (
          <span key={label}>
            <strong>{label}</strong>
            <em>{formatRelativeTiming(value, latency.startedAt)}</em>
          </span>
        ))}
      </div>
    </details>
  );
}

function formatSeconds(ms?: number) {
  if (typeof ms !== "number" || Number.isNaN(ms)) return "--";
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRelativeTiming(value?: number, startedAt?: number) {
  if (typeof value !== "number" || typeof startedAt !== "number") return "--";
  return `+${formatSeconds(value - startedAt)}`;
}

function useTypewriterText(target: string, active: boolean) {
  const [displayed, setDisplayed] = useState(active ? "" : target);

  useEffect(() => {
    if (!active) {
      setDisplayed(target);
      return;
    }

    setDisplayed((current) => {
      if (!target) return "";
      if (target.startsWith(current) && target.length >= current.length) return current;
      return "";
    });
  }, [active, target]);

  useEffect(() => {
    if (!active || displayed.length >= target.length) return undefined;

    const timer = window.setTimeout(() => {
      setDisplayed((current) => {
        const remaining = target.length - current.length;
        const step = Math.max(2, Math.min(96, Math.ceil(remaining / 6)));
        return target.slice(0, current.length + step);
      });
    }, 16);

    return () => window.clearTimeout(timer);
  }, [active, displayed, target]);

  return displayed;
}

function PartialTranscript({ event, starter }: { event: ConversationEvent; starter?: string }) {
  const displayText = useTypewriterText(event.text, true);
  const isTyping = displayText.length < event.text.length;

  return (
    <div className="gptd-live-card">
      <div className="gptd-block-title">
        <FileText size={16} />
        <span>Live Capture</span>
      </div>
      <p>{displayText}{isTyping && <span className="gptd-type-caret" />}</p>
      {starter && (
        <div className="gptd-starter compact">
          <span>Starter</span>
          <p>{starter}</p>
        </div>
      )}
    </div>
  );
}

function NextQuestionPanel({
  question,
  starter,
  nativeStatus,
  timeline
}: {
  question: string;
  starter?: string;
  nativeStatus: NativeBridgeStatus;
  timeline: CaptureTimelineEntry[];
}) {
  const displayQuestion = useTypewriterText(question, Boolean(question));
  const isTypingQuestion = displayQuestion.length < question.length;
  const hasQuestion = Boolean(question.trim());

  return (
    <aside className={["gptd-next-question", hasQuestion ? "active" : "", nativeStatus].filter(Boolean).join(" ")}>
      <div className="gptd-next-question-header">
        <span>Next question</span>
        <strong>{hasQuestion ? "capturing" : nativeStatus === "capturing" ? "listening" : nativeStatus}</strong>
      </div>
      {hasQuestion ? (
        <p>{displayQuestion}{isTypingQuestion && <span className="gptd-type-caret" />}</p>
      ) : (
        <p className="gptd-muted">Live transcript will appear here while the current answer stays readable.</p>
      )}
      {starter && (
        <div className="gptd-starter compact">
          <span>Starter</span>
          <p>{starter}</p>
        </div>
      )}
      {timeline.length > 0 && (
        <details className="gptd-capture-timeline">
          <summary>Capture timeline</summary>
          {timeline.map((entry) => (
            <div key={entry.id}>
              <span>{entry.createdAt}</span>
              <strong>{entry.label}</strong>
              {entry.detail && <em>{entry.detail}</em>}
            </div>
          ))}
        </details>
      )}
    </aside>
  );
}

function DraftQuestionCard({
  question,
  starter,
  index,
  viewMode
}: {
  question: string;
  starter?: string;
  index: number;
  viewMode: ReaderViewMode;
}) {
  const displayQuestion = useTypewriterText(question, true);
  const isTypingQuestion = displayQuestion.length < question.length;

  return (
    <article className={["gptd-turn", viewMode, "active", "latest", "draft"].filter(Boolean).join(" ")}>
      <div className="gptd-turn-label">Current question {index + 1}</div>
      <section className="gptd-question-band">
        <div className="gptd-question-body">
          <div className="gptd-question-content">
            <p>{displayQuestion}{isTypingQuestion && <span className="gptd-type-caret" />}</p>
          </div>
        </div>
      </section>
      {starter && (
        <div className="gptd-starter compact">
          <span>Starter</span>
          <p>{starter}</p>
        </div>
      )}
      <section className="gptd-answer-band">
        <p className="gptd-muted">Listening. Press Fn to send, Control for starter, long-hold Fn to stop.</p>
      </section>
    </article>
  );
}

function TurnCards({
  turns,
  activeTurnId,
  phase,
  viewMode
}: {
  turns: ConversationTurn[];
  activeTurnId?: string;
  phase: string;
  viewMode: ReaderViewMode;
}) {
  const [expandedQuestions, setExpandedQuestions] = useState<Record<string, boolean>>({});

  if (turns.length === 0) {
    return <p className="gptd-muted">Waiting for the next question...</p>;
  }

  return (
    <div className="gptd-turn-list">
      {turns.map((turn, index) => {
        const isLatest = index === turns.length - 1;
        return (
          <TurnCard
            key={turn.id}
            turn={turn}
            index={index}
            isLatest={isLatest}
            isActive={turn.id === activeTurnId}
            phase={phase}
            viewMode={viewMode}
            isExpanded={Boolean(expandedQuestions[turn.id])}
            onToggleExpanded={() => setExpandedQuestions((current) => ({ ...current, [turn.id]: !current[turn.id] }))}
          />
        );
      })}
    </div>
  );
}

function TurnCard({
  turn,
  index,
  isLatest,
  isActive,
  phase,
  viewMode,
  isExpanded,
  onToggleExpanded
}: {
  turn: ConversationTurn;
  index: number;
  isLatest: boolean;
  isActive: boolean;
  phase: string;
  viewMode: ReaderViewMode;
  isExpanded: boolean;
  onToggleExpanded: () => void;
}) {
  const isAnswering = isActive && phase === "generating" && !turn.answer;
  const hasLongQuestion = turn.question.length > 260 || Boolean(turn.questionImages?.length) || Boolean(turn.questionFiles?.length);
  const shouldAnimateAnswer = isActive && phase === "generating" && Boolean(turn.answer);
  const displayAnswer = useTypewriterText(turn.answer || "", shouldAnimateAnswer);
  const isTypingAnswer = displayAnswer.length < (turn.answer || "").length;
  const showRichAnswer = Boolean(turn.answerHtml) && !isTypingAnswer;

  return (
    <article
      className={[
        "gptd-turn",
        viewMode,
        isActive ? "active" : "",
        isLatest ? "latest" : "",
        !isLatest && !isActive ? "historical" : ""
      ].filter(Boolean).join(" ")}
    >
      <div className="gptd-turn-label">Question {index + 1}</div>
      <section className="gptd-question-band">
        <div className="gptd-question-body">
          <div className={["gptd-question-content", hasLongQuestion && !isExpanded ? "collapsed" : ""].filter(Boolean).join(" ")}>
            {turn.question && <p>{turn.question}</p>}
            <ImageAttachments images={turn.questionImages} />
            <FileAttachments files={turn.questionFiles} />
          </div>
          {hasLongQuestion && (
            <button className="gptd-question-more" type="button" onClick={onToggleExpanded}>
              {isExpanded ? "Less" : "More"}
            </button>
          )}
        </div>
      </section>
      {turn.starter && (
        <div className="gptd-starter compact">
          <span>Starter</span>
          <p>{turn.starter}</p>
        </div>
      )}
      {isAnswering && <AnsweringIndicator />}
      <section className="gptd-answer-band">
        {showRichAnswer ? (
          <div className="gptd-rich-answer" dangerouslySetInnerHTML={{ __html: turn.answerHtml || "" }} />
        ) : (
          <p>{displayAnswer || (isAnswering ? "" : "Not generated yet.")}{isTypingAnswer && <span className="gptd-type-caret" />}</p>
        )}
        {!showRichAnswer && <ImageAttachments images={turn.answerImages} />}
        <FileAttachments files={turn.answerFiles} />
      </section>
    </article>
  );
}

function QuestionMarkerRail({
  turns,
  activeIndex,
  onSelect
}: {
  turns: ConversationTurn[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  if (turns.length <= 1) return null;

  return (
    <nav className="gptd-question-markers" aria-label="Question markers">
      {turns.map((turn, index) => (
        <button
          key={turn.id}
          className={index === activeIndex ? "active" : ""}
          type="button"
          onClick={() => onSelect(index)}
          title={`Question ${index + 1}`}
          aria-label={`Go to question ${index + 1}`}
        />
      ))}
    </nav>
  );
}

function FileAttachments({ files }: { files?: ChatGptFileAttachment[] }) {
  if (!files?.length) return null;

  return (
    <div className="gptd-file-grid">
      {files.map((file, index) => {
        const content = (
          <>
            <FileText size={16} />
            <span>{file.name}</span>
            {file.kind && <strong>{file.kind}</strong>}
          </>
        );

        return file.href ? (
          <a className="gptd-file-attachment" href={file.href} target="_blank" rel="noreferrer" key={`${file.href}-${index}`}>
            {content}
          </a>
        ) : (
          <div className="gptd-file-attachment" key={`${file.name}-${index}`}>
            {content}
          </div>
        );
      })}
    </div>
  );
}

function ImageAttachments({ images }: { images?: ChatGptImageAttachment[] }) {
  if (!images?.length) return null;

  return (
    <div className={images.length === 1 ? "gptd-image-grid single" : "gptd-image-grid"}>
      {images.map((image, index) => (
        <figure className="gptd-image-attachment" key={`${image.src}-${index}`}>
          <img src={image.src} alt={image.alt || `Attachment ${index + 1}`} loading="lazy" />
          {image.alt && <figcaption>{image.alt}</figcaption>}
        </figure>
      ))}
    </div>
  );
}

function AnsweringIndicator() {
  return (
    <div className="gptd-answering">
      <span>
        <i />
        <i />
        <i />
      </span>
      Answering
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
