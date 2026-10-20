import type { UIMessage } from 'ai';
import { memo, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '~/api/client';
import { AgentAvatar } from '~/components/agent/agent-avatar';
import { reasoningOf, textOf } from '~/components/chat/message-content';
import { MessageRow, messageExcerptOf } from '~/components/chat/message-row';
import { toolStepsOf } from '~/components/chat/tool-steps';
import { useWindowedRows } from '~/hooks/use-windowed-rows';
import { repeatedOpeningPositions } from '~/lib/message-excerpt';

interface MessageListProps {
  messages: UIMessage[];
  /** The reply the agent is writing now, if any. */
  liveReplyId: string | null;
  /** Something is on its way: a reply being written, or a sent message not taken up yet. */
  working: boolean;
  /** What the dots say while nothing of the reply is visible yet. */
  waitingLabel?: string;
  /** Whose replies these are, for the avatar beside each. */
  agent?: Pick<Agent, 'id' | 'enabled' | 'running'>;
  /** Sends the latest question again; offered on the latest reply. */
  onRetry?: () => void;
  /**
   * The conversation's scroller. With it, a very long transcript renders only
   * the rows near the view; without it every row is rendered.
   */
  scrollRef?: RefObject<HTMLElement | null>;
}

const estimates = new WeakMap<UIMessage, number>();
/**
 * A height for a row not rendered yet, from its text: lines of prose, code
 * blocks and diagrams. Only spacers use it, until the row is measured.
 */
function estimateMessage(message: UIMessage): number {
  const known = estimates.get(message);
  if (known !== undefined) return known;
  const text = textOf(message);
  const fences = (text.match(/^```/gm)?.length ?? 0) / 2;
  const lines = text
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 90)), 0);
  const height =
    message.role === 'user'
      ? 96 + Math.min(lines, 20) * 24
      : 88 + lines * 26 + fences * 48 + (text.includes('```mermaid') ? 260 : 0);
  estimates.set(message, height);
  return height;
}

/** Transcript composition only; presentation belongs to rows. */
export const MessageList = memo(function MessageList({
  messages,
  liveReplyId,
  working,
  waitingLabel,
  agent,
  onRetry,
  scrollRef,
}: MessageListProps) {
  const live = liveReplyId ? messages.find((message) => message.id === liveReplyId) : undefined;
  const lastReplyIndex = messages.findLastIndex((message) => message.role === 'assistant');
  const lastReplyId = lastReplyIndex >= 0 ? messages[lastReplyIndex]?.id : undefined;
  // Visible progress: text, reasoning or a tool step of the reply being written.
  const hasVisibleContent = Boolean(
    live && (textOf(live) || reasoningOf(live) || toolStepsOf(live).length > 0),
  );
  // The reply being written shows its own progress; a message waiting behind
  // it says so on its bubble.
  // A reply row with an avatar says it is working itself (MessageRow); this
  // indicator is for the moment before that row exists, so there is never a second avatar.
  const showDots =
    working && !hasVisibleContent && !(live && agent) && !(live && messages.at(-1) !== live);
  const dotsLabel = waitingLabel ?? (live && reasoningOf(live) ? 'Thinking' : 'Working');

  // Messages that open with the same words are also named by their place.
  const positions = useMemo(
    () =>
      repeatedOpeningPositions(
        messages.map((message) => ({ role: message.role, excerpt: messageExcerptOf(message) })),
      ),
    [messages],
  );

  const keys = useMemo(() => messages.map((message) => message.id), [messages]);
  const estimate = useCallback(
    (index: number) => {
      const message = messages[index];
      return message ? estimateMessage(message) : 120;
    },
    [messages],
  );

  // The row holding keyboard focus stays rendered, so focus is never dropped.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rows = rowsRef.current;
    if (!rows) return;
    const focusIn = (event: FocusEvent) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-row-key]');
      setFocusedKey(row?.dataset.rowKey ?? null);
    };
    const focusOut = (event: FocusEvent) => {
      if (!rows.contains(event.relatedTarget as Node | null)) setFocusedKey(null);
    };
    rows.addEventListener('focusin', focusIn);
    rows.addEventListener('focusout', focusOut);
    return () => {
      rows.removeEventListener('focusin', focusIn);
      rows.removeEventListener('focusout', focusOut);
    };
  }, []);
  // The reply being written is always rendered, so its progress is never a spacer.
  const forced = useMemo(() => [focusedKey, liveReplyId], [focusedKey, liveReplyId]);
  const { plan, measure, windowed } = useWindowedRows({
    keys,
    estimate,
    scrollRef,
    rowsRef,
    forced,
  });

  return (
    <div className="mx-auto flex w-full max-w-[46rem] flex-col px-4 pb-2 pt-4">
      <div ref={rowsRef} data-message-rows="" data-windowed={windowed ? '' : undefined}>
        {plan.map((entry) => {
          if (entry.type === 'spacer')
            return (
              <div
                key={entry.key}
                aria-hidden="true"
                data-row-spacer=""
                style={{ height: entry.height }}
              />
            );
          const message = messages[entry.index]!;
          return (
            <div key={message.id} data-row-key={message.id} ref={measure} className="pb-6">
              <MessageRow
                message={message}
                streaming={message.id === liveReplyId}
                onRetry={message.id === lastReplyId && !working ? onRetry : undefined}
                position={positions[entry.index]}
                agent={agent}
                latest={message.id === lastReplyId}
              />
            </div>
          );
        })}
      </div>

      {/* An empty reply is not visible progress: keep feedback until text,
          reasoning or a tool step arrives. */}
      {showDots && (
        <div className="pb-6">
          <div role="status" className="flex items-center gap-3" aria-label={dotsLabel}>
            {agent ? (
              <AgentAvatar agent={agent} size={28} />
            ) : (
              <span className="flex items-center gap-1.5 py-2">
                {[0, 1, 2].map((dot) => (
                  <span
                    key={dot}
                    className="size-1.5 animate-bounce rounded-full bg-[var(--text-muted)]"
                    style={{ animationDelay: `${dot * 0.15}s` }}
                  />
                ))}
              </span>
            )}
            {(waitingLabel || agent) && (
              <span className="text-xs text-[var(--text-muted)]">{waitingLabel ?? dotsLabel}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
