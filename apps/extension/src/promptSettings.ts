export type PromptSettings = {
  starterPrompt: string;
  finalPrompt: string;
};

export type PromptTemplateValues = {
  partialQuestion?: string;
  currentQuestion?: string;
  starter?: string;
  candidateSpeech?: string;
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
  finalPrompt: [
    "The interviewer has now completed the question.",
    "",
    "Current complete question:",
    "{{currentQuestion}}",
    "",
    "Starter already shown to the candidate:",
    "{{starter}}",
    "",
    "Candidate actually said so far:",
    "{{candidateSpeech}}",
    "",
    "If this question is a follow-up to the previous answer, answer accordingly using the conversation context already visible in this ChatGPT chat.",
    "Continue naturally from the starter if present.",
    "Give a concise interview-ready answer."
  ].join("\n")
};

const STORAGE_KEY = "gptdisguise.promptSettings.v1";
const TEMPLATE_PATTERN = /\{\{\s*(partialQuestion|currentQuestion|starter|candidateSpeech)\s*\}\}/g;

export function compilePromptTemplate(template: string, values: PromptTemplateValues) {
  return template.replace(TEMPLATE_PATTERN, (_, key: keyof PromptTemplateValues) => values[key]?.trim() || "None");
}

export function validatePromptSettings(settings: PromptSettings): PromptValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!settings.starterPrompt.includes("{{partialQuestion}}")) {
    errors.push("Starter prompt must include {{partialQuestion}}.");
  }

  if (!settings.finalPrompt.includes("{{currentQuestion}}")) {
    errors.push("Final prompt must include {{currentQuestion}}.");
  }

  if (!settings.finalPrompt.includes("{{starter}}")) {
    warnings.push("Final prompt does not include {{starter}}, so it may not continue from the bridge line.");
  }

  if (!settings.finalPrompt.includes("{{candidateSpeech}}")) {
    warnings.push("Final prompt does not include {{candidateSpeech}}, so spoken candidate context will be omitted.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

export async function loadPromptSettings(): Promise<PromptSettings> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY] as Partial<PromptSettings> | undefined;
    if (!stored || typeof stored !== "object") return DEFAULT_PROMPT_SETTINGS;

    const settings: PromptSettings = {
      starterPrompt: typeof stored.starterPrompt === "string" ? stored.starterPrompt : DEFAULT_PROMPT_SETTINGS.starterPrompt,
      finalPrompt: typeof stored.finalPrompt === "string" ? stored.finalPrompt : DEFAULT_PROMPT_SETTINGS.finalPrompt
    };

    return validatePromptSettings(settings).ok ? settings : DEFAULT_PROMPT_SETTINGS;
  } catch {
    return DEFAULT_PROMPT_SETTINGS;
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
