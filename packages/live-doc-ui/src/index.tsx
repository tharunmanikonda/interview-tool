import React, { useEffect, useMemo, useRef, useState } from "react";
import { LiveDocAttachment, LiveDocLatency, LiveDocSnapshot, LiveDocTurn } from "@gptdisguise/protocol";

export type LiveDocShellProps = {
  snapshot?: LiveDocSnapshot;
  connectionTitle?: string;
  connectionDetail?: string;
  connectionState?: "ok" | "warn" | "bad";
  classNamePrefix?: "doc" | "gptd";
};

export function LiveDocShell({
  snapshot,
  connectionTitle = "Connecting",
  connectionDetail = "Loading live session",
  connectionState = "warn",
  classNamePrefix = "doc"
}: LiveDocShellProps) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [expandedQuestions, setExpandedQuestions] = useState<Record<string, boolean>>({});
  const [animatedTurnIds, setAnimatedTurnIds] = useState<Set<string>>(() => new Set());
  const previousActiveTurnId = useRef<string | undefined>();
  const liveAnchorTurnId = useRef<string | undefined>();
  const knownTurnIds = useRef<Set<string> | undefined>();
  const latestLiveTurnId = useMemo(() => liveTurnId(snapshot), [snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    const nextIds = new Set(snapshot.turns.map((turn) => turn.id));
    const known = knownTurnIds.current;
    if (!known) {
      knownTurnIds.current = nextIds;
      return;
    }

    const newIds = snapshot.turns.filter((turn) => !known.has(turn.id)).map((turn) => turn.id);
    knownTurnIds.current = nextIds;
    if (newIds.length === 0) return;
    if (!["waiting", "streaming"].includes(snapshot.status.answer) && newIds.length > 1) return;
    setAnimatedTurnIds((current) => {
      const next = new Set(current);
      newIds.forEach((id) => next.add(id));
      return next;
    });
  }, [snapshot]);

  useEffect(() => {
    const active = latestLiveTurnId;
    if (!active || active === previousActiveTurnId.current) return;
    previousActiveTurnId.current = active;
    liveAnchorTurnId.current = active;
    requestAnimationFrame(() => scrollToTurn(active, "auto"));
  }, [latestLiveTurnId]);

  useEffect(() => {
    const anchor = latestLiveTurnId || liveAnchorTurnId.current;
    if (!anchor || !snapshot || !["waiting", "streaming"].includes(snapshot.status.answer)) return;
    requestAnimationFrame(() => scrollToTurn(anchor, "auto"));
  }, [snapshot, latestLiveTurnId]);

  useEffect(() => {
    if (!snapshot?.turns.length) return;
    const active = snapshot.turns.findIndex((turn) => turn.id === latestLiveTurnId);
    setActiveIndex(active >= 0 ? active : snapshot.turns.length - 1);
  }, [snapshot?.turns, latestLiveTurnId]);

  function onScroll() {
    const scroll = scrollRef.current;
    if (!scroll) return;

    const turns = Array.from(scroll.querySelectorAll<HTMLElement>(`.${classNamePrefix}-turn`));
    const scrollRect = scroll.getBoundingClientRect();
    let bestIndex = activeIndex;
    let bestDistance = Number.POSITIVE_INFINITY;
    turns.forEach((turn, index) => {
      const distance = Math.abs(turn.getBoundingClientRect().top - scrollRect.top - 28);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    setActiveIndex(bestIndex);
  }

  function scrollToTurn(turnId: string, behavior: ScrollBehavior = "smooth") {
    const scroll = scrollRef.current;
    const node = scroll?.querySelector<HTMLElement>(`.${classNamePrefix}-turn[data-turn-id="${cssEscape(turnId)}"]`);
    if (!scroll || !node) return;
    const scrollRect = scroll.getBoundingClientRect();
    const turnRect = node.getBoundingClientRect();
    scroll.scrollTo({ top: Math.max(0, scroll.scrollTop + turnRect.top - scrollRect.top + 8), behavior });
  }

  const theme = snapshot?.theme || "dark";
  const mode = snapshot?.viewMode || "reader";
  const turns = snapshot?.turns || [];

  return (
    <main className={`${classNamePrefix}-shell ${theme}`}>
      <header className={`${classNamePrefix}-topbar`}>
        <div className={`${classNamePrefix}-status`}>
          <span className={`status-dot ${connectionState}`} />
          <div>
            <strong>{connectionTitle}</strong>
            <span>{connectionDetail}</span>
          </div>
        </div>
        <Latency latency={snapshot?.latency} prefix={classNamePrefix} />
      </header>
      <section className={`${classNamePrefix}-reader-scroll`} ref={scrollRef} onScroll={onScroll}>
        <div className={`${classNamePrefix}-reader-content ${mode}`}>
          {!snapshot ? (
            <div className={`${classNamePrefix}-empty`}>Opening live document...</div>
          ) : turns.length === 0 && !snapshot.partialQuestion ? (
            <div className={`${classNamePrefix}-empty`}>Waiting for the next question...</div>
          ) : (
            <>
              {snapshot.partialQuestion && <PartialQuestion text={snapshot.partialQuestion} prefix={classNamePrefix} />}
              <div className={`${classNamePrefix}-turn-list`}>
                {turns.map((turn, index) => (
                  <TurnCard
                    key={turn.id}
                    turn={turn}
                    index={index}
                    prefix={classNamePrefix}
                    viewMode={mode}
                    isActive={turn.id === latestLiveTurnId}
                    isLatest={index === turns.length - 1}
                    shouldAnimateAnswer={turn.id === latestLiveTurnId || animatedTurnIds.has(turn.id)}
                    isExpanded={Boolean(expandedQuestions[turn.id])}
                    onToggleExpanded={() => setExpandedQuestions((current) => ({ ...current, [turn.id]: !current[turn.id] }))}
                  />
                ))}
              </div>
            </>
          )}
        </div>
        <QuestionMarkerRail turns={turns} activeIndex={activeIndex} prefix={classNamePrefix} onSelect={(index) => {
          const turn = turns[index];
          if (turn) scrollToTurn(turn.id);
        }} />
      </section>
    </main>
  );
}

function PartialQuestion({ text, prefix }: { text: string; prefix: "doc" | "gptd" }) {
  const displayText = useTypewriterText(text, true);
  const isTyping = displayText.length < text.length;

  return (
    <article className={`${prefix}-live-card ${prefix}-partial`}>
      <div className={`${prefix}-block-title`}>Live Capture</div>
      <section className={`${prefix}-question-band ${prefix}-question`}>
        <div className={`${prefix}-question-body`}>
          <div className={`${prefix}-question-content`}>
            <p>{displayText}{isTyping && <span className={`${prefix}-type-caret`} />}</p>
          </div>
        </div>
      </section>
    </article>
  );
}

function TurnCard({
  turn,
  index,
  prefix,
  viewMode,
  isActive,
  isLatest,
  shouldAnimateAnswer,
  isExpanded,
  onToggleExpanded
}: {
  turn: LiveDocTurn;
  index: number;
  prefix: "doc" | "gptd";
  viewMode: "reader" | "focus";
  isActive: boolean;
  isLatest: boolean;
  shouldAnimateAnswer: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
}) {
  const questionAttachments = turn.questionAttachments || [];
  const answerAttachments = turn.answerAttachments || [];
  const hasLongQuestion = turn.question.length > 260 || questionAttachments.length > 0;
  const hasRichAnswer = Boolean(turn.answerHtml);
  const displayAnswer = useTypewriterText(turn.answer || "", !hasRichAnswer && shouldAnimateAnswer && Boolean(turn.answer));
  const isTypingAnswer = displayAnswer.length < (turn.answer || "").length;
  const showRichAnswer = hasRichAnswer;

  return (
    <article data-turn-id={turn.id} className={[`${prefix}-turn`, viewMode, isActive ? "active" : "", isLatest ? "latest" : ""].filter(Boolean).join(" ")}>
      <div className={`${prefix}-turn-label`}>Question {index + 1}</div>
      <section className={`${prefix}-question-band`}>
        <div className={`${prefix}-question-body`}>
          <div className={[`${prefix}-question-content`, hasLongQuestion && !isExpanded ? "collapsed" : ""].filter(Boolean).join(" ")}>
            {turn.question && <p>{turn.question}</p>}
            <Attachments attachments={questionAttachments} prefix={prefix} />
          </div>
          {hasLongQuestion && <button className={`${prefix}-question-more`} type="button" onClick={onToggleExpanded}>{isExpanded ? "Less" : "More"}</button>}
        </div>
      </section>
      {turn.starter && <div className={`${prefix}-starter compact`}><span>Starter</span><p>{turn.starter}</p></div>}
      {isActive && !turn.answer && <AnsweringIndicator prefix={prefix} />}
      <section className={`${prefix}-answer-band`}>
        {showRichAnswer ? <div className={`${prefix}-rich-answer`} dangerouslySetInnerHTML={{ __html: turn.answerHtml || "" }} /> : <p>{displayAnswer || (isActive ? "" : "Not generated yet.")}{isTypingAnswer && <span className={`${prefix}-type-caret`} />}</p>}
        {!showRichAnswer && <Attachments attachments={answerAttachments} prefix={prefix} />}
      </section>
    </article>
  );
}

function useTypewriterText(target: string, active: boolean) {
  const [displayed, setDisplayed] = useState(active ? "" : target);

  const shouldAnimate = active || (displayed.length > 0 && target.startsWith(displayed) && displayed.length < target.length);

  useEffect(() => {
    setDisplayed((current) => {
      if (!target) return "";
      if (target.startsWith(current) && target.length >= current.length) return current;
      return active ? "" : target;
    });
  }, [active, target]);

  useEffect(() => {
    if (!shouldAnimate || displayed.length >= target.length) return undefined;

    const timer = window.setTimeout(() => {
      setDisplayed((current) => {
        const remaining = target.length - current.length;
        const step = Math.max(1, Math.min(96, Math.ceil(remaining / 12)));
        return target.slice(0, current.length + step);
      });
    }, 24);

    return () => window.clearTimeout(timer);
  }, [shouldAnimate, displayed, target]);

  return displayed;
}

function QuestionMarkerRail({ turns, activeIndex, prefix, onSelect }: { turns: LiveDocTurn[]; activeIndex: number; prefix: "doc" | "gptd"; onSelect: (index: number) => void }) {
  if (turns.length <= 1) return null;
  return (
    <nav className={`${prefix}-question-markers`} aria-label="Question markers">
      {turns.map((turn, index) => <button key={turn.id} className={index === activeIndex ? "active" : ""} type="button" onClick={() => onSelect(index)} aria-label={`Go to question ${index + 1}`} />)}
    </nav>
  );
}

function Attachments({ attachments, prefix }: { attachments: LiveDocAttachment[]; prefix: "doc" | "gptd" }) {
  const images = attachments.filter((item) => item.type === "image" && isRenderableImage(item.src));
  const files = attachments.filter((item) => item.type === "file" || !isRenderableImage(item.src));
  return (
    <>
      {images.length > 0 && <div className={images.length === 1 ? `${prefix}-image-grid single` : `${prefix}-image-grid`}>
        {images.map((image, index) => <figure className={`${prefix}-image-attachment`} key={`${image.src}-${index}`}><img src={image.src} alt={image.alt || `Attachment ${index + 1}`} loading="lazy" />{image.alt && <figcaption>{image.alt}</figcaption>}</figure>)}
      </div>}
      {files.length > 0 && <div className={`${prefix}-file-grid`}>
        {files.map((file, index) => {
          const inner = <><span>{file.name || "Attachment"}</span>{file.kind && <strong>{file.kind}</strong>}</>;
          return file.href ? <a className={`${prefix}-file-attachment ${prefix}-file`} href={file.href} target="_blank" rel="noreferrer" key={`${file.href}-${index}`}>{inner}</a> : <div className={`${prefix}-file-attachment ${prefix}-file`} key={`${file.name}-${index}`}>{inner}</div>;
        })}
      </div>}
    </>
  );
}

function isRenderableImage(src?: string) {
  return Boolean(src && (/^https?:\/\//.test(src) || src.startsWith("data:image/") || src.startsWith("blob:")));
}

function AnsweringIndicator({ prefix }: { prefix: "doc" | "gptd" }) {
  return <div className={`${prefix}-answering`}><span><i /><i /><i /></span>Answering</div>;
}

function Latency({ latency, prefix }: { latency?: LiveDocLatency; prefix: "doc" | "gptd" }) {
  if (!latency || latency.status === "idle") return <span className={`${prefix}-latency idle`}>Timer --</span>;
  if (latency.status === "waiting") return <span className={`${prefix}-latency waiting`}>Waiting {formatSeconds(latency.elapsedMs)} · sent {formatSeconds(latency.submittedMs)}</span>;
  if (latency.status === "streaming") return <span className={`${prefix}-latency streaming`}>Streaming {formatSeconds(latency.elapsedMs)} · first {formatSeconds(latency.firstAnswerMs)}</span>;
  return <span className={`${prefix}-latency rendered`}>Rendered {formatSeconds(latency.totalMs)} · first {formatSeconds(latency.firstAnswerMs)}</span>;
}

function liveTurnId(snapshot?: LiveDocSnapshot) {
  if (!snapshot || !["waiting", "streaming"].includes(snapshot.status.answer)) return undefined;
  return snapshot.turns.at(-1)?.id;
}

function formatSeconds(ms?: number) {
  return typeof ms === "number" && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : "--";
}

function cssEscape(value: string) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return value.replace(/"/g, "\\\"");
}
