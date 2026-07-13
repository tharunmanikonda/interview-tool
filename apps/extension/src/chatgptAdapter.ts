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
  key: string;
  order: number;
  role: "user" | "assistant";
  text: string;
  html?: string;
  images?: ChatGptImageAttachment[];
  files?: ChatGptFileAttachment[];
};

export type ChatGptImageAttachment = {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
};

export type ChatGptFileAttachment = {
  name: string;
  href?: string;
  kind?: string;
};

export type ChatGptConversationMarker = {
  index: number;
  top: number;
  left: number;
  width: number;
  active: boolean;
};

export type ChatGptConversationMarkers = {
  count: number;
  activeIndex?: number;
  signature: string;
  markers: ChatGptConversationMarker[];
};

export type ChatGptSendTimings = {
  onComposerInsertStarted?: () => void;
  onComposerInsertCompleted?: () => void;
  onImageAttachStarted?: () => void;
  onImageAttachCompleted?: () => void;
  onSendClicked?: () => void;
};

export type ChatGptSendAttachments = {
  images?: ChatGptImageAttachment[];
  hasPreattachedImages?: boolean;
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

const stopSelectors = [
  "button[data-testid='stop-button']",
  "button[data-testid='composer-stop-button']",
  "button[aria-label='Stop generating']",
  "button[aria-label='Stop streaming']",
  "button[aria-label='Stop response']",
  "button[aria-label='Stop']"
];

const answerSelectors = [
  "[data-message-author-role='assistant']",
  "[data-testid='conversation-turn-assistant']",
  "[data-testid*='conversation-turn'][data-testid*='assistant']",
  ".markdown"
];

const conversationTurnSelectors = [
  "[data-message-author-role]",
  "[data-testid='conversation-turn-user']",
  "[data-testid='conversation-turn-assistant']",
  "[data-testid*='conversation-turn'][data-testid*='user']",
  "[data-testid*='conversation-turn'][data-testid*='assistant']"
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
    const messageNodes: ChatGptConversationTurn[] = uniqueElements(
      conversationTurnSelectors.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)))
    )
      .filter(isVisible)
      .map((element, order) => {
        const role = readTurnRole(element);
        if (!role) return undefined;
        const text = readableText(element);
        const images = readImageAttachments(element);
        const files = readFileAttachments(element);
        if (!text && images.length === 0 && files.length === 0) return undefined;
        const attachmentKey = [...images.map((image) => image.src), ...files.map((file) => file.href || file.name)].join("|");
        const key = readMessageKey(element, role, text || attachmentKey);
        if (role === "assistant") return { key, order, role, text, html: sanitizeAnswerHtml(element), images, files };
        return { key, order, role, text, images, files };
      })
      .filter(Boolean) as ChatGptConversationTurn[];

    return dedupeAdjacentTurns(messageNodes);
  }

  readConversationMarkers(): ChatGptConversationMarkers {
    const markers = findConversationMarkerElements().map((element, index, elements) => {
      const rect = element.getBoundingClientRect();
      return {
        index,
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        active: element === findActiveMarker(elements)
      };
    });

    const activeIndex = markers.find((marker) => marker.active)?.index;
    return {
      count: markers.length,
      activeIndex,
      signature: markers.map((marker) => `${marker.index}:${marker.top}:${marker.width}:${marker.active ? "1" : "0"}`).join("|"),
      markers
    };
  }

  async sendPrompt(prompt: string, timings: ChatGptSendTimings = {}, attachments: ChatGptSendAttachments = {}) {
    const composer = this.findComposer();
    if (!composer) {
      throw new Error("ChatGPT composer was not found.");
    }

    const safePrompt = cleanOutgoingPrompt(prompt);
    timings.onComposerInsertStarted?.();
    await focusAndSetText(composer, safePrompt);
    await waitFor(() => readableText(composer).includes(safePrompt.slice(0, 40)) || composerText(composer).includes(safePrompt.slice(0, 40)), 1200);
    timings.onComposerInsertCompleted?.();

    if (attachments.images?.length) {
      timings.onImageAttachStarted?.();
      await attachImagesToComposer(composer, attachments.images);
      timings.onImageAttachCompleted?.();
    }

    const submit = await waitFor(() => this.findSubmitButton(composer), attachments.images?.length || attachments.hasPreattachedImages ? 7000 : 2500);
    if (submit) {
      timings.onSendClicked?.();
      submit.click();
      await wait(180);
      return;
    }

    if (!pressEnter(composer)) {
      throw new Error("ChatGPT send button was not found or stayed disabled.");
    }
    timings.onSendClicked?.();
    await wait(180);
  }

  async attachImages(images: ChatGptImageAttachment[], timings: Pick<ChatGptSendTimings, "onImageAttachStarted" | "onImageAttachCompleted"> = {}) {
    if (!images.length) return;
    const composer = this.findComposer();
    if (!composer) {
      throw new Error("ChatGPT composer was not found.");
    }

    timings.onImageAttachStarted?.();
    await attachImagesToComposer(composer, images);
    timings.onImageAttachCompleted?.();
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

  isGenerating() {
    const composer = this.findComposer();
    const roots = [
      composer?.closest("form"),
      composer?.closest("[data-testid='composer-root']") as HTMLElement | null,
      composer?.parentElement,
      document.body
    ].filter((root): root is HTMLElement => Boolean(root));

    for (const root of roots) {
      for (const selector of stopSelectors) {
        const button = root.querySelector<HTMLButtonElement>(selector);
        if (button && isVisible(button) && !isInsideExtension(button) && !button.disabled) return true;
      }
    }

    if (composer && isComposerBusy(composer)) return true;

    return false;
  }

  scrollConversationToRatio(ratio: number) {
    const scroller = this.findConversationScroller();
    if (!scroller) return false;

    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = clamp(ratio, 0, 1) * maxScrollTop;
    return true;
  }

  scrollConversationByDelta(deltaY: number) {
    const scroller = this.findConversationScroller();
    if (!scroller) return false;

    scroller.scrollTop += deltaY;
    return true;
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
      const message =
        candidate.closest<HTMLElement>("[data-message-author-role='assistant']") ||
        candidate.closest<HTMLElement>("[data-testid='conversation-turn-assistant']") ||
        candidate.closest<HTMLElement>("[data-testid*='conversation-turn'][data-testid*='assistant']") ||
        candidate;
      if (seen.has(message) || !isVisible(message)) continue;
      seen.add(message);
      visible.push(message);
    }
    return visible;
  }

  private findConversationScroller() {
    const messageNodes = uniqueElements(
      conversationTurnSelectors.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)))
    ).filter(
      (element) => isVisible(element) && !isInsideExtension(element)
    );

    const candidates = new Set<HTMLElement>();
    for (const message of messageNodes) {
      let node: HTMLElement | null = message;
      while (node && node !== document.body) {
        if (isScrollable(node) && !isInsideExtension(node)) candidates.add(node);
        node = node.parentElement;
      }
    }

    const best = [...candidates].sort((a, b) => scoreScroller(b, messageNodes) - scoreScroller(a, messageNodes))[0];
    if (best) return best;

    const documentScroller = document.scrollingElement instanceof HTMLElement ? document.scrollingElement : document.documentElement;
    return documentScroller.scrollHeight > documentScroller.clientHeight ? documentScroller : null;
  }
}

function uniqueElements(elements: HTMLElement[]) {
  const seen = new Set<HTMLElement>();
  const unique: HTMLElement[] = [];

  for (const element of elements) {
    const turn =
      element.closest<HTMLElement>("[data-message-author-role]") ||
      element.closest<HTMLElement>("[data-testid*='conversation-turn']") ||
      element;
    if (seen.has(turn)) continue;
    seen.add(turn);
    unique.push(turn);
  }

  return unique;
}

function readTurnRole(element: HTMLElement): ChatGptConversationTurn["role"] | undefined {
  const role = element.getAttribute("data-message-author-role");
  if (role === "user" || role === "assistant") return role;

  const testId = element.getAttribute("data-testid")?.toLowerCase() || "";
  if (testId.includes("conversation-turn-user")) return "user";
  if (testId.includes("conversation-turn-assistant")) return "assistant";
  if (testId.includes("conversation-turn") && testId.includes("user")) return "user";
  if (testId.includes("conversation-turn") && testId.includes("assistant")) return "assistant";

  return undefined;
}

function dedupeAdjacentTurns(turns: ChatGptConversationTurn[]) {
  return turns.filter((turn, index) => {
    const previous = turns[index - 1];
    return !previous || previous.role !== turn.role || previous.text !== turn.text || imageSignature(previous.images) !== imageSignature(turn.images) || fileSignature(previous.files) !== fileSignature(turn.files);
  });
}

function imageSignature(images?: ChatGptImageAttachment[]) {
  return images?.map((image) => image.src).join("|") || "";
}

function fileSignature(files?: ChatGptFileAttachment[]) {
  return files?.map((file) => `${file.name}:${file.href || ""}`).join("|") || "";
}

function findConversationMarkerElements() {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>("button, div, span"))
    .filter((element) => !isInsideExtension(element) && isLikelyConversationMarker(element));

  const groups = new Map<HTMLElement, HTMLElement[]>();
  for (const candidate of candidates) {
    const parent = candidate.parentElement;
    if (!parent || isInsideExtension(parent)) continue;
    const group = groups.get(parent) || [];
    group.push(candidate);
    groups.set(parent, group);
  }

  const markerGroups = [...groups.values()]
    .map((group) => group.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top))
    .filter((group) => group.length >= 6 && markerGroupLooksVertical(group))
    .sort((a, b) => markerGroupScore(b) - markerGroupScore(a));

  return markerGroups[0] || [];
}

function isLikelyConversationMarker(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  if (rect.width < 12 || rect.width > 70) return false;
  if (rect.height < 1 || rect.height > 8) return false;
  if (rect.left < window.innerWidth * 0.45) return false;
  if (!isVisible(element)) return false;

  const style = window.getComputedStyle(element);
  const background = parseRgb(style.backgroundColor);
  const border = parseRgb(style.borderColor);
  const hasPaint = Boolean(background || border);
  if (!hasPaint) return false;

  const radius = Number.parseFloat(style.borderRadius || "0");
  return radius >= 0;
}

function markerGroupLooksVertical(group: HTMLElement[]) {
  const rects = group.map((element) => element.getBoundingClientRect());
  const lefts = rects.map((rect) => rect.left);
  const tops = rects.map((rect) => rect.top);
  const maxLeftDrift = Math.max(...lefts) - Math.min(...lefts);
  const verticalSpan = Math.max(...tops) - Math.min(...tops);
  return maxLeftDrift < 12 && verticalSpan > 90;
}

function markerGroupScore(group: HTMLElement[]) {
  const rects = group.map((element) => element.getBoundingClientRect());
  const verticalSpan = Math.max(...rects.map((rect) => rect.top)) - Math.min(...rects.map((rect) => rect.top));
  const rightBias = Math.max(...rects.map((rect) => rect.left));
  return group.length * 10000 + verticalSpan * 10 + rightBias;
}

function findActiveMarker(elements: HTMLElement[]) {
  return elements
    .map((element) => ({ element, brightness: markerBrightness(element), width: element.getBoundingClientRect().width }))
    .sort((a, b) => b.brightness - a.brightness || b.width - a.width)[0]?.element;
}

function markerBrightness(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  const color = parseRgb(style.backgroundColor) || parseRgb(style.borderColor);
  if (!color) return 0;
  return color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
}

function parseRgb(value: string) {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!match) return undefined;
  const alpha = match[4] === undefined ? 1 : Number.parseFloat(match[4]);
  if (alpha <= 0.05) return undefined;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: alpha
  };
}

function readMessageKey(element: HTMLElement, role: ChatGptConversationTurn["role"], text: string) {
  const source = findStableMessageAttribute(element);
  if (source) return `${role}:${source}`;

  const testId = element.getAttribute("data-testid");
  if (testId && testId !== `conversation-turn-${role}`) return `${role}:testid:${testId}`;

  return `${role}:text:${stableTextHash(text)}`;
}

function readImageAttachments(element: HTMLElement): ChatGptImageAttachment[] {
  const seen = new Set<string>();
  const root = element.closest<HTMLElement>("[data-testid*='conversation-turn'], article") || element;
  return Array.from(root.querySelectorAll<HTMLImageElement>("img"))
    .filter((image) => isLikelyContentImage(image))
    .map((image) => {
      const src = readImageSource(image);
      return {
        src,
        alt: image.alt || image.getAttribute("aria-label") || undefined,
        width: image.naturalWidth || Math.round(image.getBoundingClientRect().width) || undefined,
        height: image.naturalHeight || Math.round(image.getBoundingClientRect().height) || undefined
      };
    })
    .filter((image) => {
      if (!image.src || seen.has(image.src)) return false;
      seen.add(image.src);
      return true;
    });
}

function isLikelyContentImage(image: HTMLImageElement) {
  const src = readImageSource(image);
  if (!src) return false;
  if (src.startsWith("chrome-extension://")) return false;
  if (src.startsWith("data:image/svg")) return false;
  if (isInsideExtension(image)) return false;

  const rect = image.getBoundingClientRect();
  const width = image.naturalWidth || rect.width;
  const height = image.naturalHeight || rect.height;
  if (width < 18 || height < 18) return false;

  const containerLabel = `${image.closest("[aria-label]")?.getAttribute("aria-label") || ""} ${image.closest("[data-testid]")?.getAttribute("data-testid") || ""}`;
  const label = `${image.alt || ""} ${image.getAttribute("aria-label") || ""} ${image.className || ""} ${containerLabel}`.toLowerCase();
  if (label.includes("avatar") || label.includes("profile") || label.includes("icon")) return false;

  return isVisible(image) || Boolean(image.naturalWidth || image.getAttribute("src") || image.getAttribute("srcset"));
}

function readImageSource(image: HTMLImageElement) {
  const source = image.currentSrc || image.src || bestSrcsetCandidate(image.getAttribute("srcset") || "") || image.getAttribute("data-src") || "";
  if (source.startsWith("blob:")) return imagePreviewDataUrl(image) || source;
  return source;
}

function imagePreviewDataUrl(image: HTMLImageElement) {
  try {
    const width = image.naturalWidth || Math.round(image.getBoundingClientRect().width);
    const height = image.naturalHeight || Math.round(image.getBoundingClientRect().height);
    if (!width || !height) return undefined;

    const maxEdge = 920;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return undefined;
  }
}

function readFileAttachments(element: HTMLElement): ChatGptFileAttachment[] {
  const seen = new Set<string>();
  const root = element.closest<HTMLElement>("[data-testid*='conversation-turn'], article") || element;
  const candidates = Array.from(root.querySelectorAll<HTMLElement>("a[href], button, [data-testid*='file'], [aria-label*='file'], [aria-label*='document'], [aria-label*='attachment']"));
  const files: ChatGptFileAttachment[] = [];

  for (const candidate of candidates) {
    if (isInsideExtension(candidate) || !isVisible(candidate)) continue;
    const file = readFileAttachment(candidate);
    if (!file) continue;
    const key = `${file.href || ""}:${file.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(file);
  }

  return files;
}

function readFileAttachment(element: HTMLElement): ChatGptFileAttachment | undefined {
  const href = element instanceof HTMLAnchorElement ? element.href : element.querySelector<HTMLAnchorElement>("a[href]")?.href;
  const label = [
    element.innerText,
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-testid"),
    href
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!label || isLikelyControlLabel(label)) return undefined;

  const extension = label.match(/\b[\w .()-]+\.(pdf|docx?|xlsx?|pptx?|csv|txt|json|md|zip)\b/i)?.[0];
  const hasAttachmentSignal = /(file|document|attachment|uploaded|pdf|docx?|xlsx?|pptx?|csv|txt|json|markdown|zip)/i.test(label);
  if (!extension && !hasAttachmentSignal) return undefined;

  const name = cleanupFileName(extension || label);
  if (!name || name.length > 140) return undefined;

  return {
    name,
    href: href && !href.startsWith("javascript:") ? href : undefined,
    kind: inferFileKind(name, label)
  };
}

function cleanupFileName(value: string) {
  return value
    .replace(/\b(download|open|preview|uploaded|attached|file|document)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferFileKind(name: string, label: string) {
  const source = `${name} ${label}`.toLowerCase();
  const extension = source.match(/\.(pdf|docx?|xlsx?|pptx?|csv|txt|json|md|zip)\b/)?.[1];
  if (extension) return extension.toUpperCase();
  if (source.includes("pdf")) return "PDF";
  if (source.includes("spreadsheet")) return "Sheet";
  if (source.includes("presentation")) return "Slides";
  return "File";
}

function isLikelyControlLabel(label: string) {
  return /copy|share|thumb|regenerate|read aloud|edit|more|show more|send|stop|new chat/i.test(label);
}

function bestSrcsetCandidate(srcset: string) {
  return srcset
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean)
    .at(-1) || "";
}

function findStableMessageAttribute(element: HTMLElement) {
  const candidates = [
    "data-message-id",
    "data-message-author-id",
    "data-turn-id",
    "data-testid",
    "id"
  ];

  let node: HTMLElement | null = element;
  while (node && node !== document.body) {
    for (const attribute of candidates) {
      const value = node.getAttribute(attribute);
      if (value && isStableMessageAttribute(value)) return `${attribute}:${value}`;
    }
    node = node.parentElement;
  }

  return "";
}

function isStableMessageAttribute(value: string) {
  if (value === "conversation-turn-user" || value === "conversation-turn-assistant") return false;
  return /[0-9a-f]{8,}|message|turn|conversation/i.test(value);
}

function stableTextHash(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function readableText(element?: HTMLElement) {
  const text = element?.innerText?.trim() || "";
  return text.replace(/\n{3,}/g, "\n\n");
}

function sanitizeAnswerHtml(element: HTMLElement) {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("button, svg, style, script, form, textarea, input").forEach((node) => node.remove());
  clone.querySelectorAll("img").forEach((node) => {
    if (!(node instanceof HTMLImageElement) || !hasSafeImageSource(node)) node.remove();
  });
  prepareCodeBlocks(clone);

  clone.querySelectorAll<HTMLElement>("*").forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      const allowed =
        attribute.name === "class" ||
        attribute.name === "data-language" ||
        attribute.name === "data-highlighted" ||
        attribute.name === "aria-label" ||
        (node instanceof HTMLImageElement &&
          ["src", "alt", "width", "height", "loading", "decoding", "referrerpolicy"].includes(attribute.name));
      if (!allowed) node.removeAttribute(attribute.name);
    });
  });

  return clone.innerHTML;
}

function prepareCodeBlocks(root: HTMLElement) {
  flattenNestedCodeBlocks(root);
  root.querySelectorAll<HTMLElement>("pre").forEach((pre) => {
    if (!pre.isConnected || pre.querySelector("pre")) return;
    const code = pre.querySelector<HTMLElement>("code") || pre;
    const language = inferCodeLanguage(pre, code);
    pre.setAttribute("data-language", language);
    pre.classList.add("gptd-code-card");
    removeCodeBlockChrome(pre, language);

    const rawCode = compactCodeBlankLines(stripLeadingLanguageLine(code.textContent || "", language));
    code.textContent = "";
    code.classList.add("gptd-code");

    const lines = rawCode.split("\n");
    lines.forEach((line, index) => {
      const lineNode = document.createElement("span");
      lineNode.className = "gptd-code-line";
      appendHighlightedCode(lineNode, line);
      if (!line) lineNode.append(document.createTextNode("\u200B"));
      code.append(lineNode);
      if (index < lines.length - 1) code.append(document.createTextNode("\n"));
    });
  });
}

function flattenNestedCodeBlocks(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("pre").forEach((outerPre) => {
    const innerPre = outerPre.querySelector<HTMLElement>("pre");
    if (!innerPre) return;
    outerPre.replaceWith(innerPre);
  });
}

function removeCodeBlockChrome(pre: HTMLElement, language: string) {
  const parent = pre.parentElement;
  if (!parent) return;

  for (const node of Array.from(parent.childNodes)) {
    if (node === pre) continue;
    if (node.nodeType === Node.TEXT_NODE && isLanguageChromeText(node.textContent?.trim() || "", language)) {
      node.remove();
    }
  }

  for (const sibling of Array.from(parent.children)) {
    if (sibling === pre || sibling.contains(pre) || sibling.querySelector("pre, code, img")) continue;
    const text = (sibling.textContent || "").trim();
    if (isLanguageChromeText(text, language)) sibling.remove();
  }

  let previous = pre.previousElementSibling;
  while (previous && isLanguageChromeText((previous.textContent || "").trim(), language)) {
    const node = previous;
    previous = previous.previousElementSibling;
    node.remove();
  }
}

function isLanguageChromeText(text: string, language: string) {
  if (!text || text.length > 30) return false;
  const normalized = text.toLowerCase();
  const labels = new Set(["code", "sql", "go", "golang", "java", "python", "javascript", "typescript", "c++", "c#", language.toLowerCase()]);
  return labels.has(normalized);
}

function inferCodeLanguage(pre: HTMLElement, code: HTMLElement) {
  const text = code.textContent || "";
  const detected = detectCodeLanguage(text);
  const explicit =
    pre.getAttribute("data-language") ||
    code.getAttribute("data-language") ||
    [...pre.classList, ...code.classList]
      .map((className) => className.match(/(?:language|lang)-([a-z0-9+#.-]+)/i)?.[1])
      .find(Boolean);

  if (detected && (!explicit || shouldPreferDetectedLanguage(explicit, detected))) return detected;
  if (explicit) return formatLanguageLabel(explicit);
  return detected || "Code";
}

function detectCodeLanguage(text: string) {
  if (/\bpackage\s+main\b|\bfunc\s+\w+\s*\(|:=|\bfmt\./.test(text)) return "Go";
  if (/\bdef\s+\w+\s*\(|\bclass\s+\w+[:(]|\bimport\s+\w+/.test(text)) return "Python";
  if (/\bpublic\s+class\b|\bSystem\.out\.println\b/.test(text)) return "Java";
  if (/#include\s*<|std::|cout\s*<</.test(text)) return "C++";
  if (/\bfunction\s+\w+\s*\(|\bconst\s+\w+\s*=|=>/.test(text)) return "JavaScript";
  if (/\bSELECT\b|\bFROM\b|\bWHERE\b/i.test(text)) return "SQL";
  return "";
}

function shouldPreferDetectedLanguage(explicit: string, detected: string) {
  const label = formatLanguageLabel(explicit);
  if (label === detected) return false;
  if (label === "SQL" && /^(Go|Java|Python|C\+\+|JavaScript|TypeScript|React)$/.test(detected)) return true;
  if (label === "Code" && detected) return true;
  return false;
}

function stripLeadingLanguageLine(code: string, language: string) {
  const lines = code.replace(/\u200B/g, "").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  const firstLine = lines[0]?.trim().toLowerCase();
  const languageLine = language.toLowerCase();
  if (firstLine && isLanguageChromeText(firstLine, languageLine)) {
    lines.shift();
    while (lines.length && !lines[0].trim()) lines.shift();
  }
  return lines.join("\n");
}

function compactCodeBlankLines(code: string) {
  return code
    .split("\n")
    .filter((line, index, lines) => line.trim() || index === 0 || lines[index - 1]?.trim())
    .join("\n")
    .trimEnd();
}

function formatLanguageLabel(language: string) {
  const normalized = language.toLowerCase();
  const labels: Record<string, string> = {
    js: "JavaScript",
    jsx: "React",
    ts: "TypeScript",
    tsx: "React",
    py: "Python",
    python: "Python",
    go: "Go",
    golang: "Go",
    java: "Java",
    cpp: "C++",
    cplusplus: "C++",
    csharp: "C#",
    cs: "C#",
    sql: "SQL",
    json: "JSON",
    bash: "Bash",
    shell: "Shell",
    sh: "Shell"
  };
  return labels[normalized] || language.charAt(0).toUpperCase() + language.slice(1);
}

function appendHighlightedCode(parent: HTMLElement, line: string) {
  const tokenPattern =
    /(#.*$|\/\/.*$|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:class|def|return|if|elif|else|for|while|try|except|finally|with|as|import|from|pass|break|continue|lambda|in|is|not|and|or|public|private|protected|static|void|int|long|double|float|boolean|char|String|new|const|let|var|function|async|await|interface|type|extends|implements)\b|\b(?:True|False|None|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b|[{}()[\].,;:+\-*/%=<>!&|]+)/g;
  let cursor = 0;
  for (const match of line.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index || 0;
    if (index > cursor) parent.append(document.createTextNode(line.slice(cursor, index)));
    const span = document.createElement("span");
    span.className = codeTokenClass(token);
    span.textContent = token;
    parent.append(span);
    cursor = index + token.length;
  }
  if (cursor < line.length) parent.append(document.createTextNode(line.slice(cursor)));
}

function codeTokenClass(token: string) {
  if (/^(#|\/\/|\/\*)/.test(token)) return "gptd-code-comment";
  if (/^["'`]/.test(token)) return "gptd-code-string";
  if (/^\d/.test(token)) return "gptd-code-number";
  if (/^(True|False|None|true|false|null|undefined)$/.test(token)) return "gptd-code-literal";
  if (/^[{}()[\].,;:+\-*/%=<>!&|]+$/.test(token)) return "gptd-code-punctuation";
  return "gptd-code-keyword";
}

function hasSafeImageSource(image: HTMLImageElement) {
  const src = image.currentSrc || image.src || image.getAttribute("src") || "";
  return Boolean(src && !src.startsWith("chrome-extension://") && !src.startsWith("javascript:"));
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

function cleanOutgoingPrompt(prompt: string) {
  return prompt.replaceAll("[[GPTD_LIVE_ASSIST_FINALIZE]]", "").trim();
}

async function attachImagesToComposer(composer: HTMLElement, images: ChatGptImageAttachment[]) {
  const files = await Promise.all(images.map(imageAttachmentToFile));
  const validFiles = files.filter((file): file is File => Boolean(file));
  if (!validFiles.length) return;

  const root = composerRoot(composer);
  const beforeCount = attachmentSignalCount(root);

  if (await pasteFilesIntoComposer(composer, validFiles, beforeCount)) return;
  if (await setFilesOnUploadInput(root, validFiles, beforeCount)) return;

  throw new Error("Unable to attach pasted screenshot to ChatGPT composer.");
}

async function imageAttachmentToFile(image: ChatGptImageAttachment, index: number) {
  if (!image.src.startsWith("data:")) return undefined;

  const response = await fetch(image.src);
  const blob = await response.blob();
  const mime = blob.type || image.src.match(/^data:([^;,]+)/)?.[1] || "image/png";
  const extension = mime.split("/")[1] || "png";
  const safeName = (image.alt || `screenshot-${index + 1}.${extension}`).replace(/[^\w.\- ]+/g, "_");
  return new File([blob], safeName.includes(".") ? safeName : `${safeName}.${extension}`, { type: mime });
}

async function pasteFilesIntoComposer(composer: HTMLElement, files: File[], beforeCount: number) {
  composer.focus();
  const dataTransfer = new DataTransfer();
  files.forEach((file) => dataTransfer.items.add(file));

  const event = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: dataTransfer
  });

  if (!event.clipboardData || event.clipboardData.files.length === 0) {
    Object.defineProperty(event, "clipboardData", { value: dataTransfer });
  }

  const dispatched = composer.dispatchEvent(event);
  await wait(250);
  const attached = await waitFor(() => attachmentSignalCount(composerRoot(composer)) > beforeCount, 2500);
  return Boolean(attached);
}

async function setFilesOnUploadInput(root: HTMLElement, files: File[], beforeCount: number) {
  const inputs = (uniqueElements([
    ...Array.from(root.querySelectorAll<HTMLInputElement>("input[type='file']")),
    ...Array.from(document.querySelectorAll<HTMLInputElement>("input[type='file']"))
  ]) as HTMLInputElement[]).filter((input) => !isInsideExtension(input));

  for (const input of inputs) {
    const dataTransfer = new DataTransfer();
    files.forEach((file) => dataTransfer.items.add(file));
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const attached = await waitFor(() => attachmentSignalCount(composerRoot(root)) > beforeCount, 3500);
    if (attached) return true;
  }

  return false;
}

function composerRoot(composer: HTMLElement) {
  return (
    (composer.closest("form") as HTMLElement | null) ||
    (composer.closest("[data-testid='composer-root']") as HTMLElement | null) ||
    composer.parentElement ||
    composer
  );
}

function attachmentSignalCount(root: HTMLElement) {
  return root.querySelectorAll("img, [data-testid*='attachment'], [data-testid*='file'], [aria-label*='Attached'], [aria-label*='attachment'], [aria-label*='file']").length;
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
  clearEditableComposer(element);

  const probe = text.slice(0, 40);
  if (insertTextOnce(element, text, probe)) return;

  try {
    const clipboard = await navigator.clipboard.readText().catch(() => "");
    await navigator.clipboard.writeText(text);
    clearEditableComposer(element);
    document.execCommand("paste");
    await wait(100);
    if (readableText(element).includes(probe)) {
      if (clipboard) await navigator.clipboard.writeText(clipboard).catch(() => undefined);
      return;
    }
    if (clipboard) await navigator.clipboard.writeText(clipboard).catch(() => undefined);
  } catch {
    // Fall through to the DOM fallback below.
  }

  clearEditableComposer(element);
  element.textContent = text;
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

function clearEditableComposer(element: HTMLElement) {
  element.focus();

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand("delete");
  element.textContent = "";
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
}

function insertTextOnce(element: HTMLElement, text: string, probe: string) {
  element.focus();
  const inserted = document.execCommand("insertText", false, text);
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  return inserted && readableText(element).includes(probe);
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

function isComposerBusy(composer: HTMLElement) {
  const root =
    composer.closest("form") ||
    composer.closest("[data-testid='composer-root']") ||
    composer.parentElement ||
    composer;
  const busyValue = [
    composer.getAttribute("aria-busy"),
    root.getAttribute("aria-busy"),
    root.getAttribute("data-state"),
    root.getAttribute("data-status")
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return busyValue.includes("true") || busyValue.includes("busy") || busyValue.includes("stream") || busyValue.includes("generat");
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

function isScrollable(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  const canScrollY = /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`);
  return canScrollY && element.scrollHeight - element.clientHeight > 24;
}

function scoreScroller(element: HTMLElement, messages: HTMLElement[]) {
  const messageCount = messages.filter((message) => element.contains(message)).length;
  const scrollCapacity = Math.max(0, element.scrollHeight - element.clientHeight);
  const rect = element.getBoundingClientRect();
  const viewportFit = rect.height > window.innerHeight * 0.45 ? 1000 : 0;
  return messageCount * 10000 + viewportFit + scrollCapacity;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
