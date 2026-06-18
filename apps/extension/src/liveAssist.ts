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
  starter?: string;
  answer: string;
  answerHtml?: string;
  createdAt: number;
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

  private listeners = new Set<Listener>();

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): ConversationState {
    return structuredClone(this.state);
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
    const priorAnswer = this.state.previousAssistantAnswer || this.state.currentAssistantAnswer || "None yet";

    return {
      ok: true,
      question,
      prompt: [
        "You are helping draft a concise live interview answer.",
        "",
        "Use the context below, continue naturally from what the candidate already said, and avoid repeating the entire previous answer.",
        "Answer in a way the candidate can read aloud. Be direct first, then add the key reasoning.",
        "",
        `Previous interviewer question:\n${this.state.previousQuestion || "None yet"}`,
        "",
        `Previous ChatGPT answer or starter response:\n${priorAnswer}`,
        "",
        `Candidate actually said/read aloud:\n${this.state.lastCandidateSpeech || "Unknown or not captured"}`,
        "",
        `Current interviewer question:\n${question}`,
        "",
        `Provisional starter already shown to the candidate:\n${this.state.provisionalStarter?.text || "None"}`,
        "",
        `If a starter response exists above, continue from it naturally and replace it with a complete answer for the full question.`,
        "",
        "Draft the next answer now."
      ].join("\n")
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
      prompt: [
        "You are helping with a live interview. The interviewer is still asking a question, so do not answer fully yet.",
        "",
        "Write only one short natural bridge sentence the candidate can say now while the full question is still forming.",
        "Keep it neutral, safe, and useful. Do not mention that this is a partial transcript.",
        "Keep the response around 50 words or fewer. This limit applies only to this starter response.",
        "",
        `Partial interviewer question so far:\n${trimmed}`,
        "",
        "Return only the bridge sentence."
      ].join("\n")
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

  hydrateTurns(turns: Array<{ question: string; answer: string; answerHtml?: string }>) {
    const hydratedTurns = turns
      .map((turn) => ({
        id: createId("turn"),
        question: normalizeText(turn.question),
        answer: normalizeText(turn.answer),
        answerHtml: turn.answerHtml,
        createdAt: Date.now()
      }))
      .filter((turn) => turn.question || turn.answer);

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
    const existing = [...this.state.turns].reverse().find((turn) => turn.question === question);
    if (existing) {
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
    this.state.turns.push(turn);
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
