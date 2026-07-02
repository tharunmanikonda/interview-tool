import {
  DEFAULT_PROMPT_SETTINGS,
  PromptSettings,
  compilePromptTemplate
} from "./promptSettings";

export type InputRole = "interviewer" | "candidate";
export type StarterMode = "neutral" | "neutral-speculative" | "off";
export type ConversationPhase = "idle" | "listening" | "generating";

export type ConversationEvent = {
  id: string;
  role: InputRole;
  text: string;
  final: boolean;
  createdAt: number;
};

export type ProvisionalStarter = {
  id: string;
  text: string;
  confidence: "low" | "medium";
  sourceQuestion: string;
};

export type QueuedQuestion = {
  id: string;
  text: string;
  createdAt: number;
};

export type ConversationTurn = {
  id: string;
  question: string;
  questionImages?: ConversationImageAttachment[];
  questionFiles?: ConversationFileAttachment[];
  starter?: string;
  answer: string;
  answerHtml?: string;
  answerImages?: ConversationImageAttachment[];
  answerFiles?: ConversationFileAttachment[];
  createdAt: number;
};

export type ConversationImageAttachment = {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
};

export type ConversationFileAttachment = {
  name: string;
  href?: string;
  kind?: string;
};

export type ConversationState = {
  phase: ConversationPhase;
  events: ConversationEvent[];
  turns: ConversationTurn[];
  activeTurnId?: string;
  partialTranscript?: ConversationEvent;
  currentQuestion?: string;
  previousQuestion?: string;
  previousAssistantAnswer?: string;
  currentAssistantAnswer: string;
  lastCandidateSpeech: string;
  queuedQuestions: QueuedQuestion[];
  provisionalStarter?: ProvisionalStarter;
};

export type HydratableConversationTurn = {
  id?: string;
  question: string;
  questionImages?: ConversationImageAttachment[];
  questionFiles?: ConversationFileAttachment[];
  answer: string;
  answerHtml?: string;
  answerImages?: ConversationImageAttachment[];
  answerFiles?: ConversationFileAttachment[];
  createdAt?: number;
};

type Listener = (state: ConversationState) => void;

export class LiveAssistEngine {
  private state: ConversationState = {
    phase: "idle",
    events: [],
    turns: [],
    currentAssistantAnswer: "",
    lastCandidateSpeech: "",
    queuedQuestions: []
  };
  private promptSettings: PromptSettings = DEFAULT_PROMPT_SETTINGS;

  private listeners = new Set<Listener>();

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): ConversationState {
    return structuredClone(this.state);
  }

  setPromptSettings(settings: PromptSettings) {
    this.promptSettings = settings;
  }

  ingestPartial(role: InputRole, text: string, starterMode: StarterMode) {
    const trimmed = normalizeText(text);
    if (!trimmed) return;

    this.state.phase = this.state.phase === "generating" ? "generating" : "listening";
    this.state.partialTranscript = {
      id: createId("partial"),
      role,
      text: trimmed,
      final: false,
      createdAt: Date.now()
    };

    if (role === "interviewer" && !this.state.provisionalStarter) {
      const starter = buildStarter(trimmed, starterMode);
      if (starter) this.state.provisionalStarter = starter;
    }

    this.emit();
  }

  ingestFinal(role: InputRole, text: string, starterMode: StarterMode) {
    const trimmed = normalizeText(text);
    if (!trimmed) return;

    const event: ConversationEvent = {
      id: createId(role),
      role,
      text: trimmed,
      final: true,
      createdAt: Date.now()
    };

    this.state.events.push(event);
    this.state.partialTranscript = undefined;

    if (role === "candidate") {
      this.state.lastCandidateSpeech = mergeRecentText(this.state.lastCandidateSpeech, trimmed);
    } else if (this.state.phase === "generating") {
      this.state.queuedQuestions.push({ id: event.id, text: trimmed, createdAt: event.createdAt });
    } else {
      this.state.currentQuestion = trimmed;
      const starter = buildStarter(trimmed, starterMode);
      this.state.provisionalStarter = starter || undefined;
      this.ensureTurn(trimmed, starter?.text);
    }

    this.state.phase = this.state.phase === "generating" ? "generating" : "listening";
    this.emit();
  }

  finalizeActiveInterviewerQuestion(text: string, starterMode: StarterMode) {
    const trimmed = normalizeText(text);
    if (!trimmed) return;

    const event: ConversationEvent = {
      id: createId("interviewer"),
      role: "interviewer",
      text: trimmed,
      final: true,
      createdAt: Date.now()
    };

    this.state.events.push(event);
    this.state.partialTranscript = undefined;
    this.state.currentQuestion = trimmed;
    this.state.provisionalStarter = this.reconcileStarter(trimmed) || buildStarter(trimmed, starterMode) || undefined;

    const active = this.activeTurn();
    if (active && this.state.phase === "generating") {
      active.question = trimmed;
      if (this.state.provisionalStarter?.text && !active.starter) active.starter = this.state.provisionalStarter.text;
    } else {
      this.ensureTurn(trimmed, this.state.provisionalStarter?.text);
    }

    this.state.phase = this.state.phase === "generating" ? "generating" : "listening";
    this.emit();
  }

  buildPromptForCurrentQuestion(): { ok: true; question: string; prompt: string } | { ok: false; reason: string } {
    const question = this.state.currentQuestion || this.latestInterviewerQuestion();
    if (!question) {
      return { ok: false, reason: "Add or capture an interviewer question first." };
    }
    return {
      ok: true,
      question,
      prompt: compilePromptTemplate(this.promptSettings.finalPrompt, {
        currentQuestion: question,
        starter: this.state.provisionalStarter?.text,
        candidateSpeech: this.state.lastCandidateSpeech
      })
    };
  }

  buildStarterPromptForQuestion(question: string): { ok: true; question: string; prompt: string } | { ok: false; reason: string } {
    const trimmed = normalizeText(question);
    if (!trimmed) {
      return { ok: false, reason: "No partial question captured yet." };
    }

    return {
      ok: true,
      question: trimmed,
      prompt: compilePromptTemplate(this.promptSettings.starterPrompt, {
        partialQuestion: trimmed
      })
    };
  }

  markGeneratingStarter(question: string) {
    const trimmed = normalizeText(question);
    if (!trimmed) return;

    this.state.currentQuestion = trimmed;
    this.state.currentAssistantAnswer = "";
    this.state.phase = "generating";
    this.state.provisionalStarter = undefined;
    const turn = this.ensureTurn(trimmed);
    this.state.activeTurnId = turn.id;
    turn.answer = "";
    turn.answerHtml = undefined;
    this.emit();
  }

  markGenerating(question: string) {
    if (this.state.currentAssistantAnswer.trim()) {
      this.state.previousAssistantAnswer = this.state.currentAssistantAnswer.trim();
    }

    if (this.state.currentQuestion || question) {
      this.state.previousQuestion = this.state.currentQuestion || question;
    }

    this.state.currentQuestion = question;
    this.state.currentAssistantAnswer = "";
    this.state.phase = "generating";
    this.state.provisionalStarter = this.reconcileStarter(question);
    const turn = this.ensureTurn(question, this.state.provisionalStarter?.text);
    this.state.activeTurnId = turn.id;
    turn.answer = "";
    turn.answerHtml = undefined;
    this.emit();
  }

  setAssistantAnswer(answer: string, answerHtml?: string) {
    this.state.currentAssistantAnswer = answer;
    const turn = this.activeTurn();
    if (turn) {
      turn.answer = answer;
      turn.answerHtml = answerHtml;
    }

    if (this.state.phase === "generating" && answer.trim().length > 0 && !looksLikeStreaming(answer)) {
      this.state.phase = "idle";
      this.promoteQueuedQuestion();
    }

    this.emit();
  }

  markIdle() {
    this.state.phase = "idle";
    this.promoteQueuedQuestion();
    this.emit();
  }

  reset() {
    this.state = {
      phase: "idle",
      events: [],
      turns: [],
      currentAssistantAnswer: "",
      lastCandidateSpeech: "",
      queuedQuestions: []
    };
    this.emit();
  }

  hydrateTurns(turns: HydratableConversationTurn[]) {
    const hydratedTurns = turns
      .map((turn) => ({
        id: turn.id || createId("turn"),
        question: normalizeText(turn.question),
        questionImages: turn.questionImages,
        questionFiles: turn.questionFiles,
        answer: normalizeText(turn.answer),
        answerHtml: turn.answerHtml,
        answerImages: turn.answerImages,
        answerFiles: turn.answerFiles,
        createdAt: turn.createdAt || Date.now()
      }))
      .filter((turn) => turn.question || turn.answer || turn.questionImages?.length || turn.answerImages?.length || turn.questionFiles?.length || turn.answerFiles?.length);

    if (hydratedTurns.length === 0) return;

    const latest = hydratedTurns.at(-1);
    this.state = {
      phase: "idle",
      events: hydratedTurns.flatMap((turn) =>
        turn.question
          ? [
              {
                id: createId("interviewer"),
                role: "interviewer" as const,
                text: turn.question,
                final: true,
                createdAt: turn.createdAt
              }
            ]
          : []
      ),
      turns: hydratedTurns,
      activeTurnId: undefined,
      currentQuestion: latest?.question,
      previousQuestion: latest?.question,
      previousAssistantAnswer: latest?.answer,
      currentAssistantAnswer: latest?.answer || "",
      lastCandidateSpeech: "",
      queuedQuestions: []
    };
    this.emit();
  }

  mergeHydratedTurns(turns: HydratableConversationTurn[]) {
    const hydratedTurns = turns
      .map((turn) => ({
        id: turn.id || createId("turn"),
        question: normalizeText(turn.question),
        questionImages: turn.questionImages,
        questionFiles: turn.questionFiles,
        answer: normalizeText(turn.answer),
        answerHtml: turn.answerHtml,
        answerImages: turn.answerImages,
        answerFiles: turn.answerFiles,
        createdAt: turn.createdAt || Date.now()
      }))
      .filter((turn) => turn.question || turn.answer || turn.questionImages?.length || turn.answerImages?.length || turn.questionFiles?.length || turn.answerFiles?.length);

    if (hydratedTurns.length === 0) return false;

    if (this.state.turns.length === 0) {
      this.hydrateTurns(turns);
      return true;
    }

    const existingByKey = new Map(this.state.turns.map((turn) => [turnKey(turn), turn]));
    let changed = false;
    const merged: ConversationTurn[] = [];

    for (const hydrated of hydratedTurns) {
      const key = turnKey(hydrated);
      const existing = existingByKey.get(key) || findSimilarExistingTurn(this.state.turns, hydrated);

      if (existing) {
        if (hydrated.question.length > existing.question.length && hydrated.question.includes(existing.question)) {
          existing.question = hydrated.question;
          changed = true;
        }
        if (hydrated.questionImages?.length && hydrated.questionImages.length !== existing.questionImages?.length) {
          existing.questionImages = hydrated.questionImages;
          changed = true;
        }
        if (hydrated.questionFiles?.length && hydrated.questionFiles.length !== existing.questionFiles?.length) {
          existing.questionFiles = hydrated.questionFiles;
          changed = true;
        }
        if (hydrated.answer && existing.answer !== hydrated.answer) {
          existing.answer = hydrated.answer;
          existing.answerHtml = hydrated.answerHtml;
          existing.answerImages = hydrated.answerImages;
          existing.answerFiles = hydrated.answerFiles;
          changed = true;
        }
        merged.push(existing);
      } else {
        merged.push(hydrated);
        changed = true;
      }
    }

    const hydratedKeys = new Set(merged.map((turn) => turnKey(turn)));
    for (const turn of this.state.turns) {
      const key = turnKey(turn);
      if (!hydratedKeys.has(key)) merged.push(turn);
    }

    if (!changed) return false;

    const latest = merged.at(-1);
    this.state.turns = merged;
    this.state.currentQuestion = latest?.question || this.state.currentQuestion;
    this.state.previousQuestion = latest?.question || this.state.previousQuestion;
    this.state.previousAssistantAnswer = latest?.answer || this.state.previousAssistantAnswer;
    this.state.currentAssistantAnswer = latest?.answer || this.state.currentAssistantAnswer;
    this.state.events = merged.flatMap((turn) =>
      turn.question
        ? [
            {
              id: createId("interviewer"),
              role: "interviewer" as const,
              text: turn.question,
              final: true,
              createdAt: turn.createdAt
            }
          ]
        : []
    );
    this.emit();
    return true;
  }

  private latestInterviewerQuestion() {
    return [...this.state.events].reverse().find((event) => event.role === "interviewer")?.text;
  }

  private promoteQueuedQuestion() {
    const next = this.state.queuedQuestions.shift();
    if (next) {
      this.state.currentQuestion = next.text;
      this.state.provisionalStarter = buildStarter(next.text, "neutral-speculative") || undefined;
      const turn = this.ensureTurn(next.text, this.state.provisionalStarter?.text);
      this.state.activeTurnId = turn.id;
    }
  }

  private ensureTurn(question: string, starter?: string) {
    const existing = this.state.phase === "generating" && this.state.activeTurnId ? this.state.turns.find((turn) => turn.id === this.state.activeTurnId) : undefined;
    if (existing) {
      existing.question = question;
      if (starter && !existing.starter) existing.starter = starter;
      return existing;
    }

    const turn: ConversationTurn = {
      id: createId("turn"),
      question,
      starter,
      answer: "",
      createdAt: Date.now()
    };
    this.state.turns = [...this.state.turns, turn];
    return turn;
  }

  private activeTurn() {
    return this.state.turns.find((turn) => turn.id === this.state.activeTurnId);
  }

  private reconcileStarter(question: string) {
    const current = this.state.provisionalStarter;
    if (!current) return undefined;

    if (isStarterContradicted(current.text, question)) {
      return {
        ...current,
        text: "I’d be careful there. The right answer depends on the constraint and the tradeoff.",
        confidence: "low" as const,
        sourceQuestion: question
      };
    }

    return { ...current, sourceQuestion: question };
  }

  private emit() {
    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

function buildStarter(text: string, mode: StarterMode): ProvisionalStarter | undefined {
  if (mode === "off") return undefined;

  const lower = text.toLowerCase();
  const isYesNo = /^(would|do|does|did|can|could|should|is|are|will|wouldn't|don't|doesn't)\b/.test(lower);
  const mentionsTradeoff = /(redis|cache|database|index|api|scale|latency|consistency|security|auth|queue|event|microservice)/.test(lower);

  let starter = "That’s a good question. I’d approach it by first clarifying the main constraint.";
  let confidence: ProvisionalStarter["confidence"] = "low";

  if (mode === "neutral-speculative" && isYesNo && mentionsTradeoff) {
    starter = "Yes, I’d consider it, but I’d frame the answer around the tradeoff and constraints first.";
    confidence = "medium";
  } else if (mode === "neutral-speculative" && mentionsTradeoff) {
    starter = "The way I’d think about that is by separating the core requirement from the implementation tradeoff.";
    confidence = "medium";
  }

  return {
    id: createId("starter"),
    text: starter,
    confidence,
    sourceQuestion: text
  };
}

function turnKey(turn: Pick<ConversationTurn, "question" | "answer" | "questionImages" | "answerImages" | "questionFiles" | "answerFiles">) {
  const question = normalizeText(turn.question);
  if (question) return `q:${question}`;
  const questionAttachmentKey = attachmentKey(turn.questionImages, turn.questionFiles);
  if (questionAttachmentKey) return `qa:${questionAttachmentKey}`;
  const answer = normalizeText(turn.answer).slice(0, 500);
  if (answer) return `a:${answer}`;
  return `aa:${attachmentKey(turn.answerImages, turn.answerFiles)}`;
}

function findSimilarExistingTurn(turns: ConversationTurn[], hydrated: Pick<ConversationTurn, "question" | "answer" | "questionImages" | "questionFiles">) {
  const question = normalizeText(hydrated.question);
  if (!question) {
    const hydratedAttachments = attachmentKey(hydrated.questionImages, hydrated.questionFiles);
    if (!hydratedAttachments) return undefined;
    return turns.find((turn) => attachmentKey(turn.questionImages, turn.questionFiles) === hydratedAttachments);
  }

  return turns.find((turn) => {
    const existing = normalizeText(turn.question);
    if (!existing) return false;
    return existing === question || existing.includes(question) || question.includes(existing);
  });
}

function attachmentKey(images?: ConversationImageAttachment[], files?: ConversationFileAttachment[]) {
  return [
    ...(images?.map((image) => image.src) || []),
    ...(files?.map((file) => file.href || file.name) || [])
  ].join("|");
}

function isStarterContradicted(starter: string, question: string) {
  const lowerStarter = starter.toLowerCase();
  const lowerQuestion = question.toLowerCase();
  return lowerStarter.startsWith("yes") && /(source of truth|financial transaction|password|secret|private key|never|not use)/.test(lowerQuestion);
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function mergeRecentText(existing: string, next: string) {
  return [existing, next].filter(Boolean).join("\n").slice(-2000);
}

function looksLikeStreaming(answer: string) {
  return answer.endsWith("…") || answer.length < 40;
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
