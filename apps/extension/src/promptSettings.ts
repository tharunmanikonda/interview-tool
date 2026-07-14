export type PromptSettings = {
  starterPrompt: string;
  generalPrompt: string;
  clarifyPrompt: string;
  approachPrompt: string;
  codePrompt: string;
  debugPrompt: string;
  debuggingPrompt: string;
  upgradePrompt: string;
};

export type ResponsePromptKind = "general" | "clarify" | "approach" | "code" | "debug" | "debugging" | "upgrade";
export type PromptPreviewKind = "starter" | ResponsePromptKind;

export type PromptTemplateValues = {
  partialQuestion?: string;
  currentQuestion?: string;
  starter?: string;
  candidateSpeech?: string;
  discussionSoFar?: string;
  intent?: string;
};

export type PromptValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export const DEFAULT_PROMPT_SETTINGS: PromptSettings = {
  starterPrompt: [
    "The interviewer is still asking a question. This may be a follow-up to the previous answer.",
    "",
    "Write one short bridge sentence the candidate can say while waiting for the full question.",
    "Do not answer fully yet.",
    "",
    "Partial question so far:",
    "{{partialQuestion}}",
    "",
    "Return only the bridge sentence."
  ].join("\n"),
  generalPrompt: [
    "Discussion so far:",
    "{{discussionSoFar}}",
    "",
    "Answer the interviewer’s latest question naturally and concisely.",
    "",
    "Use the existing ChatGPT conversation context if this is a follow-up.",
    "Match the interview tone: clear, confident, senior-level, and practical.",
    "Do not over-explain unless the question asks for detail."
  ].join("\n"),
  clarifyPrompt: [
    "The interviewer has shared a coding/problem question.",
    "",
    "Current question, typed notes, and/or attached screenshot(s):",
    "{{currentQuestion}}",
    "",
    "Ask the most useful clarification questions before solving.",
    "Keep it concise and interview-ready."
  ].join("\n"),
  approachPrompt: [
    "Understand the discussion so far and provide the final solution approach.",
    "",
    "Discussion so far:",
    "{{discussionSoFar}}",
    "",
    "Based on the clarified requirements, provide the final solution approach.",
    "",
    "Include:",
    "",
    "- Approach",
    "- Key trade-off",
    "- Time & space complexity",
    "",
    "Do not write code.",
    "Keep it concise and senior-level."
  ].join("\n"),
  codePrompt: [
    "Understand the discussion so far and write the coding answer.",
    "",
    "Discussion so far:",
    "{{discussionSoFar}}",
    "",
    "Write clean, production-quality, interview-ready code using the agreed approach.",
    "",
    "Handle edge cases.",
    "Use meaningful names.",
    "",
    "Write comment for imports why we need this in the code.",
    "Keep comments for every line why we use it.",
    "Do not over-engineer."
  ].join("\n"),
  debugPrompt: [
    "Understand the discussion so far. It contains a debugging issue with code, behavior, errors, and/or shared screenshots.",
    "",
    "Discussion so far:",
    "{{discussionSoFar}}",
    "",
    "Carefully inspect the shared code, screenshots, and explanation.",
    "",
    "Get directly to the real problem.",
    "Find the root cause and provide the smallest correct fix.",
    "Keep it concise and interview-ready."
  ].join("\n"),
  debuggingPrompt: [
    "Discussion so far:",
    "{{discussionSoFar}}",
    "",
    "Analyze the discussion above and any attached inputs. Continue the debugging workflow using existing and newly provided context.",
    "",
    "If ready, give the next step. If a command is needed, include the exact cd path and command.",
    "",
    "If more context is needed, tell me exactly what to share next.",
    "",
    "Keep it short and interview-ready."
  ].join("\n"),
  upgradePrompt: [
    "Understand the discussion so far. It contains the upgrade or enhancement request for the current solution/code.",
    "",
    "Discussion so far:",
    "{{discussionSoFar}}",
    "",
    "Update the existing solution with the smallest required change."
  ].join("\n")
};

const STORAGE_KEY = "gptdisguise.promptSettings.v4";
const PREVIOUS_STORAGE_KEY = "gptdisguise.promptSettings.v3";
const V2_STORAGE_KEY = "gptdisguise.promptSettings.v2";
const LEGACY_STORAGE_KEY = "gptdisguise.promptSettings.v1";
const TEMPLATE_PATTERN = /\{\{\s*(partialQuestion|currentQuestion|starter|candidateSpeech|discussionSoFar|intent)\s*\}\}/g;

const OLD_APPROACH_PROMPT = [
  "The interviewer has shared a coding/problem question.",
  "",
  "Current question, typed notes, and/or attached screenshot(s):",
  "{{currentQuestion}}",
  "",
  "Starter already shown to the candidate:",
  "{{starter}}",
  "",
  "Candidate actually said so far:",
  "{{candidateSpeech}}",
  "",
  "Explain assumptions, one or two possible approaches, and recommend the approach to use."
].join("\n");

export const RESPONSE_PROMPT_KINDS: Array<{ kind: ResponsePromptKind; label: string; field: keyof PromptSettings; description: string }> = [
  { kind: "general", label: "General", field: "generalPrompt", description: "Behavioral, resume, project, and normal technical answers." },
  { kind: "clarify", label: "Clarify", field: "clarifyPrompt", description: "Ask useful clarification questions before solving." },
  { kind: "approach", label: "Approach", field: "approachPrompt", description: "Explain assumptions, approaches, and tradeoffs." },
  { kind: "code", label: "Code", field: "codePrompt", description: "Produce the full coding answer." },
  { kind: "debug", label: "Debug", field: "debugPrompt", description: "Find the root cause and smallest correct fix." },
  { kind: "debugging", label: "Debugging", field: "debuggingPrompt", description: "Continue the screenshot-driven repo debugging workflow." },
  { kind: "upgrade", label: "Upgrade", field: "upgradePrompt", description: "Update the existing solution with the smallest required change." }
];

export function responsePromptField(kind: ResponsePromptKind): keyof PromptSettings {
  return RESPONSE_PROMPT_KINDS.find((entry) => entry.kind === kind)?.field || "generalPrompt";
}

export function promptKindLabel(kind: PromptPreviewKind) {
  if (kind === "starter") return "Starter";
  return RESPONSE_PROMPT_KINDS.find((entry) => entry.kind === kind)?.label || "General";
}

export function promptTemplateForKind(settings: PromptSettings, kind: PromptPreviewKind) {
  if (kind === "starter") return settings.starterPrompt;
  return settings[responsePromptField(kind)];
}

export function compilePromptTemplate(template: string, values: PromptTemplateValues) {
  return template.replace(TEMPLATE_PATTERN, (_, key: keyof PromptTemplateValues) => values[key]?.trim() || "None");
}

export function buildDiscussionSoFar(currentQuestion?: string, starter?: string, candidateSpeech?: string) {
  return [
    currentQuestion?.trim() ? `Current question / notes:\n${currentQuestion.trim()}` : "",
    starter?.trim() ? `Starter already shown:\n${starter.trim()}` : "",
    candidateSpeech?.trim() ? `Candidate/interviewer discussion captured so far:\n${candidateSpeech.trim()}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function validatePromptSettings(settings: PromptSettings): PromptValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!settings.starterPrompt.includes("{{partialQuestion}}")) {
    errors.push("Starter prompt must include {{partialQuestion}}.");
  }

  for (const prompt of RESPONSE_PROMPT_KINDS) {
    const template = settings[prompt.field];
    if (
      prompt.kind === "general" ||
      prompt.kind === "approach" ||
      prompt.kind === "code" ||
      prompt.kind === "debug" ||
      prompt.kind === "debugging" ||
      prompt.kind === "upgrade"
    ) {
      if (!template.includes("{{discussionSoFar}}")) {
        errors.push(`${prompt.label} prompt must include {{discussionSoFar}}.`);
      }
      continue;
    }
    if (!template.includes("{{currentQuestion}}")) {
      errors.push(`${prompt.label} prompt must include {{currentQuestion}}.`);
    }
    if (!template.includes("{{starter}}") && prompt.kind !== "clarify" && prompt.kind !== "debug" && prompt.kind !== "upgrade") {
      warnings.push(`${prompt.label} prompt does not include {{starter}}.`);
    }
    if (!template.includes("{{candidateSpeech}}")) {
      warnings.push(`${prompt.label} prompt does not include {{candidateSpeech}}.`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export async function loadPromptSettings(): Promise<PromptSettings> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY] as Partial<PromptSettings> | undefined;
    if (!stored || typeof stored !== "object") return loadLegacyPromptSettings();

    const settings: PromptSettings = {
      starterPrompt: typeof stored.starterPrompt === "string" ? stored.starterPrompt : DEFAULT_PROMPT_SETTINGS.starterPrompt,
      generalPrompt: typeof stored.generalPrompt === "string" ? stored.generalPrompt : DEFAULT_PROMPT_SETTINGS.generalPrompt,
      clarifyPrompt: typeof stored.clarifyPrompt === "string" ? stored.clarifyPrompt : DEFAULT_PROMPT_SETTINGS.clarifyPrompt,
      approachPrompt: typeof stored.approachPrompt === "string" ? stored.approachPrompt : DEFAULT_PROMPT_SETTINGS.approachPrompt,
      codePrompt: typeof stored.codePrompt === "string" ? stored.codePrompt : DEFAULT_PROMPT_SETTINGS.codePrompt,
      debugPrompt: typeof stored.debugPrompt === "string" ? stored.debugPrompt : DEFAULT_PROMPT_SETTINGS.debugPrompt,
      debuggingPrompt: typeof stored.debuggingPrompt === "string" ? stored.debuggingPrompt : DEFAULT_PROMPT_SETTINGS.debuggingPrompt,
      upgradePrompt: typeof stored.upgradePrompt === "string" ? stored.upgradePrompt : DEFAULT_PROMPT_SETTINGS.upgradePrompt
    };

    return validatePromptSettings(settings).ok ? settings : DEFAULT_PROMPT_SETTINGS;
  } catch {
    return DEFAULT_PROMPT_SETTINGS;
  }
}

async function loadLegacyPromptSettings(): Promise<PromptSettings> {
  const previous = await loadPreviousPromptSettings();
  if (previous) return previous;

  try {
    const result = await chrome.storage.local.get(LEGACY_STORAGE_KEY);
    const stored = result[LEGACY_STORAGE_KEY] as Partial<PromptSettings & { finalPrompt?: string }> | undefined;
    if (!stored || typeof stored !== "object") return DEFAULT_PROMPT_SETTINGS;
    const legacyFinal = typeof stored.finalPrompt === "string" ? stored.finalPrompt : DEFAULT_PROMPT_SETTINGS.codePrompt;
    const settings: PromptSettings = {
      starterPrompt: typeof stored.starterPrompt === "string" ? stored.starterPrompt : DEFAULT_PROMPT_SETTINGS.starterPrompt,
      generalPrompt: DEFAULT_PROMPT_SETTINGS.generalPrompt,
      clarifyPrompt: DEFAULT_PROMPT_SETTINGS.clarifyPrompt,
      approachPrompt: legacyFinal,
      codePrompt: legacyFinal,
      debugPrompt: DEFAULT_PROMPT_SETTINGS.debugPrompt,
      debuggingPrompt: DEFAULT_PROMPT_SETTINGS.debuggingPrompt,
      upgradePrompt: legacyFinal
    };
    return validatePromptSettings(settings).ok ? settings : DEFAULT_PROMPT_SETTINGS;
  } catch {
    return DEFAULT_PROMPT_SETTINGS;
  }
}

async function loadPreviousPromptSettings(): Promise<PromptSettings | undefined> {
  try {
    const result = await chrome.storage.local.get([PREVIOUS_STORAGE_KEY, V2_STORAGE_KEY]);
    const stored = (result[PREVIOUS_STORAGE_KEY] || result[V2_STORAGE_KEY]) as Partial<PromptSettings & { followUpPrompt?: string }> | undefined;
    if (!stored || typeof stored !== "object") return undefined;
    const previousFollowUp = typeof stored.followUpPrompt === "string" ? stored.followUpPrompt : DEFAULT_PROMPT_SETTINGS.upgradePrompt;
    const previousApproach =
      typeof stored.approachPrompt === "string" && stored.approachPrompt !== OLD_APPROACH_PROMPT
        ? stored.approachPrompt
        : DEFAULT_PROMPT_SETTINGS.approachPrompt;
    const settings: PromptSettings = {
      starterPrompt: typeof stored.starterPrompt === "string" ? stored.starterPrompt : DEFAULT_PROMPT_SETTINGS.starterPrompt,
      generalPrompt: typeof stored.generalPrompt === "string" ? stored.generalPrompt : DEFAULT_PROMPT_SETTINGS.generalPrompt,
      clarifyPrompt: typeof stored.clarifyPrompt === "string" ? stored.clarifyPrompt : DEFAULT_PROMPT_SETTINGS.clarifyPrompt,
      approachPrompt: previousApproach,
      codePrompt: typeof stored.codePrompt === "string" ? stored.codePrompt : DEFAULT_PROMPT_SETTINGS.codePrompt,
      debugPrompt: typeof stored.debugPrompt === "string" ? stored.debugPrompt : DEFAULT_PROMPT_SETTINGS.debugPrompt,
      debuggingPrompt: typeof stored.debuggingPrompt === "string" ? stored.debuggingPrompt : DEFAULT_PROMPT_SETTINGS.debuggingPrompt,
      upgradePrompt: typeof stored.upgradePrompt === "string" ? stored.upgradePrompt : previousFollowUp
    };
    return validatePromptSettings(settings).ok ? settings : undefined;
  } catch {
    return undefined;
  }
}

export async function savePromptSettings(settings: PromptSettings) {
  try {
    if (!chrome?.runtime?.id) return;
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (!message.includes("Extension context invalidated") && !message.includes("context invalidated")) {
      throw error;
    }
  }
}
