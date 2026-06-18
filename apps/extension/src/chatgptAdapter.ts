export type ChatGptConnectionState =
  | { status: "checking"; message?: string }
  | { status: "connected"; message: string }
  | { status: "lost"; message: string };

export type ChatGptAnswerSnapshot = {
  text: string;
  html: string;
  index: number;
};

export type ChatGptConversationTurn = {
  role: "user" | "assistant";
  text: string;
  html?: string;
};

const composerSelectors = [
  "#prompt-textarea",
  "[contenteditable='true'][id='prompt-textarea']",
  "[contenteditable='true'][data-lexical-editor='true']",
  ".ProseMirror[contenteditable='true']",
  "textarea[data-id='root']",
  "textarea[placeholder*='Message']",
  "textarea",
  "[contenteditable='true']"
];

const submitSelectors = [
  "button[data-testid='send-button']",
  "button[data-testid='composer-submit-button']",
  "button[aria-label='Send prompt']",
  "button[aria-label='Send message']",
  "button[aria-label='Send']",
  "form button[type='submit']"
];

const answerSelectors = [
  "[data-message-author-role='assistant']",
  "[data-testid='conversation-turn-assistant']",
  ".markdown"
];

export class ChatGptAdapter {
  checkConnection(): ChatGptConnectionState {
    const composer = this.findComposer();
    if (!composer) {
      return {
        status: "lost",
        message: "ChatGPT page connection lost. Open a logged-in ChatGPT conversation."
      };
    }

    return { status: "connected", message: "ChatGPT composer is ready." };
  }

  assistantCount() {
    return this.assistantMessages().length;
  }

  readConversation(): ChatGptConversationTurn[] {
    const messageNodes: ChatGptConversationTurn[] = Array.from(document.querySelectorAll<HTMLElement>("[data-message-author-role]"))
      .filter(isVisible)
      .map((element) => {
        const role = element.getAttribute("data-message-author-role");
        if (role !== "user" && role !== "assistant") return undefined;
        const text = readableText(element);
        if (!text) return undefined;
        if (role === "assistant") return { role, text, html: sanitizeAnswerHtml(element) };
        return { role, text };
      })
      .filter(Boolean) as ChatGptConversationTurn[];

    return dedupeAdjacentTurns(messageNodes);
  }

  async sendPrompt(prompt: string) {
    const composer = this.findComposer();
    if (!composer) {
      throw new Error("ChatGPT composer was not found.");
    }

    await focusAndSetText(composer, prompt);
    await waitFor(() => readableText(composer).includes(prompt.slice(0, 40)) || composerText(composer).includes(prompt.slice(0, 40)), 1200);

    const submit = await waitFor(() => this.findSubmitButton(composer), 2500);
    if (submit) {
      submit.click();
      await wait(180);
      return;
    }

    if (!pressEnter(composer)) {
      throw new Error("ChatGPT send button was not found or stayed disabled.");
    }
    await wait(180);
  }

  observeLatestAnswer(onAnswer: (answer: ChatGptAnswerSnapshot) => void, options: { afterAssistantCount?: number } = {}) {
    let lastAnswer = "";
    let raf = 0;

    const read = () => {
      const answer = this.readLatestAnswer(options.afterAssistantCount);
      if (answer && answer.text !== lastAnswer) {
        lastAnswer = answer.text;
        onAnswer(answer);
      }
    };

    const observer = new MutationObserver(() => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(read);
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    read();

    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }

  private findComposer() {
    const candidates = composerSelectors.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)));
    return candidates
      .filter((element) => isVisible(element) && !isInsideExtension(element) && isLikelyComposer(element))
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
  }

  private findSubmitButton(composer?: HTMLElement) {
    const roots = [
      composer?.closest("form"),
      composer?.closest("[data-testid='composer-root']") as HTMLElement | null,
      composer?.parentElement,
      document.body
    ].filter((root): root is HTMLElement => Boolean(root));

    for (const root of roots) {
      for (const selector of submitSelectors) {
        const button = root.querySelector<HTMLButtonElement>(selector);
        if (button && isUsableButton(button)) return button;
      }
    }

    for (const selector of submitSelectors) {
      const button = document.querySelector<HTMLButtonElement>(selector);
      if (button && isUsableButton(button)) return button;
    }
    return null;
  }

  private readLatestAnswer(afterAssistantCount = 0): ChatGptAnswerSnapshot | undefined {
    const visible = this.assistantMessages();
    const eligible = afterAssistantCount > 0 ? visible.slice(afterAssistantCount) : visible;
    const latest = (eligible.length ? eligible : visible).at(-1);
    const index = latest ? visible.indexOf(latest) : -1;
    const text = readableText(latest);
    if (!latest || !text) return undefined;
    return { text, html: sanitizeAnswerHtml(latest), index };
  }

  private assistantMessages() {
    const candidates = answerSelectors.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)));
    const seen = new Set<HTMLElement>();
    const visible: HTMLElement[] = [];
    for (const candidate of candidates) {
      const message = candidate.closest<HTMLElement>("[data-message-author-role='assistant']") || candidate;
      if (seen.has(message) || !isVisible(message)) continue;
      seen.add(message);
      visible.push(message);
    }
    return visible;
  }
}

function dedupeAdjacentTurns(turns: ChatGptConversationTurn[]) {
  return turns.filter((turn, index) => {
    const previous = turns[index - 1];
    return !previous || previous.role !== turn.role || previous.text !== turn.text;
  });
}

function readableText(element?: HTMLElement) {
  const text = element?.innerText?.trim() || "";
  return text.replace(/\n{3,}/g, "\n\n");
}

function sanitizeAnswerHtml(element: HTMLElement) {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("button, svg, style, script, form, textarea, input").forEach((node) => node.remove());

  clone.querySelectorAll<HTMLElement>("*").forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      const allowed =
        attribute.name === "class" ||
        attribute.name === "data-language" ||
        attribute.name === "data-highlighted" ||
        attribute.name === "aria-label";
      if (!allowed) node.removeAttribute(attribute.name);
    });
  });

  return clone.innerHTML;
}

async function focusAndSetText(element: HTMLElement, text: string) {
  element.focus();

  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, text);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  await pasteTextIntoContentEditable(element, text);
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

function pressEnter(element: HTMLElement) {
  element.focus();
  const options: KeyboardEventInit = { key: "Enter", code: "Enter", bubbles: true, cancelable: true };
  const down = element.dispatchEvent(new KeyboardEvent("keydown", options));
  element.dispatchEvent(new KeyboardEvent("keyup", options));
  return down;
}

async function waitFor<T>(getter: () => T | null | undefined, timeoutMs: number) {
  const started = Date.now();
  let value = getter();
  while (!value && Date.now() - started < timeoutMs) {
    await wait(100);
    value = getter();
  }
  return value || null;
}

async function pasteTextIntoContentEditable(element: HTMLElement, text: string) {
  element.focus();
  document.execCommand("selectAll");

  try {
    dispatchTextPaste(element, text);
    await wait(60);
    if (readableText(element).includes(text.slice(0, 40))) return;

    const clipboard = await navigator.clipboard.readText().catch(() => "");
    await navigator.clipboard.writeText(text);
    document.execCommand("paste");
    await wait(80);
    if (!readableText(element).includes(text.slice(0, 40))) {
      document.execCommand("insertText", false, text);
    }
    if (clipboard) await navigator.clipboard.writeText(clipboard).catch(() => undefined);
  } catch {
    element.textContent = "";
    document.execCommand("insertText", false, text);
  }
}

function dispatchTextPaste(element: HTMLElement, text: string) {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertFromPaste", data: text }));
  document.execCommand("insertText", false, text);
}

function composerText(element: HTMLElement) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
  return readableText(element);
}

function isInsideExtension(element: HTMLElement) {
  return Boolean(element.closest("[data-gptd-mounted='true'], [data-gptd-react-root='true']"));
}

function isLikelyComposer(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  if (rect.top < window.innerHeight * 0.35) return false;
  const label = [element.getAttribute("aria-label"), element.getAttribute("placeholder"), element.id].filter(Boolean).join(" ").toLowerCase();
  return element.id === "prompt-textarea" || label.includes("message") || label.includes("prompt") || element.isContentEditable;
}

function isUsableButton(button: HTMLButtonElement) {
  if (!isVisible(button) || isInsideExtension(button)) return false;
  if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
  const label = `${button.getAttribute("aria-label") || ""} ${button.dataset.testid || ""}`.toLowerCase();
  return label.includes("send") || button.type === "submit";
}

function isVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
