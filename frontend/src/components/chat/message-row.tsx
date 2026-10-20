import type { UIMessage } from 'ai';
import { Clock } from 'lucide-react';
import { memo, useId, useState } from 'react';
import type { Agent } from '~/api/client';
import { AgentAvatar } from '~/components/agent/agent-avatar';
import { MARKDOWN_PROSE, Markdown } from '~/components/chat/markdown';
import { MessageActions } from '~/components/chat/message-actions';
import {
  failureOf,
  interruptionOf,
  reasoningOf,
  replyLayoutOf,
  stoppedNoteOf,
  stoppedOf,
  textOf,
} from '~/components/chat/message-content';
import { ReplyFailureNote } from '~/components/chat/reply-outcome-note';
import { WorkBlock } from '~/components/chat/reply-work';
import type { ToolPart } from '~/components/chat/tool-steps';
import type { ReplyMetadata } from '~/lib/chat-view';
import { messageExcerpt } from '~/lib/message-excerpt';
import { replyInfo } from '~/lib/reply-meta';
import { cn } from '~/lib/utils';
import { isToolPart } from '~/shared';

interface MessageRowProps {
  message: UIMessage;
  /** This reply is being written now. */
  streaming: boolean;
  /** Sends the question this reply answered again (the latest reply only). */
  onRetry?: () => void;
  /** Its place, when another message opens with the same words: "reply 3". */
  position?: string | null;
  /** Whose reply it is, for the avatar beside it. */
  agent?: Pick<Agent, 'id' | 'enabled' | 'running'>;
  /** The newest reply: its avatar shows what the agent is doing; earlier ones rest, still. */
  latest?: boolean;
}

/**
 * A message's opening words, as its row names it. Cached by message object:
 * unchanged messages keep their object (reuseUnchanged), so the list can work
 * out which openings repeat without reading every message on each update.
 */
const excerpts = new WeakMap<UIMessage, string | null>();
export function messageExcerptOf(message: UIMessage): string | null {
  let excerpt = excerpts.get(message);
  if (excerpt === undefined) {
    excerpt = messageExcerpt(textOf(message));
    excerpts.set(message, excerpt);
  }
  return excerpt;
}

const PENDING_NOTE: Record<NonNullable<ReplyMetadata['pending']>, string> = {
  sending: 'Sending…',
  queued: 'Queued: the agent takes it next.',
};

/** Memoized by object: unchanged messages are not re-rendered or re-parsed. */
export const MessageRow = memo(function MessageRow({
  message,
  streaming,
  onRetry,
  position,
  agent,
  latest = false,
}: MessageRowProps) {
  const text = textOf(message);
  const excerpt = messageExcerptOf(message) ?? undefined;
  const place = (excerpt && position) || undefined;

  if (message.role === 'user') {
    const pending = (message.metadata as ReplyMetadata | undefined)?.pending;
    return (
      <article
        className="group flex flex-col items-end"
        aria-label="Your message"
        data-excerpt={excerpt}
        data-position={place}
        data-message-id={message.id}
        data-message-role="user"
      >
        <div
          className={cn(
            'max-w-[85%] rounded-2xl border border-[var(--border-user-message)] bg-[var(--bg-user-message)] px-4 py-3 text-[0.9375rem] leading-relaxed text-[var(--text-primary)]',
            pending && 'opacity-80',
          )}
        >
          <FoldedText text={text} />
        </div>
        {pending ? (
          <p
            role="status"
            className="mt-1.5 flex items-center gap-1 text-xs text-[var(--text-muted)]"
          >
            <Clock className="size-3" aria-hidden="true" />
            {PENDING_NOTE[pending]}
          </p>
        ) : (
          <MessageActions
            text={text}
            position={place}
            info={replyInfo(message.metadata as ReplyMetadata | undefined)}
          />
        )}
      </article>
    );
  }

  const interruption = interruptionOf(message);
  const failure = streaming ? null : failureOf(message);
  const stopped = !streaming && stoppedOf(message);
  const limited = (message.metadata as ReplyMetadata | undefined)?.stopReason === 'length';

  return (
    <article
      className="group flex gap-3"
      aria-label="Agent message"
      data-excerpt={excerpt}
      data-position={place}
      data-message-id={message.id}
    >
      {agent && (
        <div className="mt-px shrink-0">
          {latest ? (
            <AgentAvatar agent={agent} size={28} />
          ) : (
            <AgentAvatar
              agent={agent}
              size={28}
              state={failureOf(message) ? 'error' : 'idle'}
              frozen
            />
          )}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {streaming && agent && !text && !reasoningOf(message) && !message.parts.some(isToolPart) ? (
          // Nothing of the reply yet: say so beside its avatar, instead of a second one below.
          <p role="status" className="flex h-7 items-center text-xs text-[var(--text-muted)]">
            <span className="text-shimmer">Thinking…</span>
          </p>
        ) : (
          <ReplyBody key={message.id} message={message} text={text} streaming={streaming} />
        )}
        {interruption && (
          <p role="note" className="mb-1 text-xs text-[var(--text-muted)]">
            {interruption}
          </p>
        )}
        {failure && (
          <ReplyFailureNote reason={failure} onRetry={onRetry} latest={Boolean(onRetry)} />
        )}
        {stopped && (
          <p role="note" className="mb-1 text-xs text-[var(--text-muted)]">
            {stoppedNoteOf(message, text)}
          </p>
        )}
        {!streaming && (
          <>
            {limited && (
              <p role="note" className="mb-1 text-xs text-[var(--text-muted)]">
                The model stopped at its length limit, so this reply may be cut short.
              </p>
            )}
            <MessageActions
              text={text}
              position={place}
              onRetry={onRetry}
              info={replyInfo(message.metadata as ReplyMetadata | undefined)}
            />
          </>
        )}
      </div>
    </article>
  );
});

/**
 * A reply's work and text: one block with everything the agent did before
 * answering (reasoning and tool calls, in order), then the text.
 */
function ReplyBody({
  message,
  text,
  streaming,
}: {
  message: UIMessage;
  text: string;
  streaming: boolean;
}) {
  const layout = replyLayoutOf(
    message.parts as ToolPart[],
    isToolPart,
    () => 'work',
    (part) => `tool-${part.toolCallId}`,
  );
  return (
    <>
      {layout.work.length > 0 && (
        <WorkBlock messageId={message.id} layout={layout} streaming={streaming} />
      )}
      {layout.text.map((group, index) => (
        <div
          key={group.key}
          data-reply-group="text"
          className={cn(
            'text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]',
            index < layout.text.length - 1 && 'mb-4',
          )}
        >
          <Markdown className={MARKDOWN_PROSE}>{text.slice(group.start, group.end)}</Markdown>
        </div>
      ))}
    </>
  );
}

/** A message longer than this many lines, or characters, is folded until asked. */
const FOLD_LINES = 12;
const FOLD_CHARS = 1_200;

/**
 * The person's own message. A long one (a pasted log, a document) folds to
 * its first lines with "Show more", so it does not push the reply off screen.
 */
function FoldedText({ text }: { text: string }) {
  const long = text.split('\n').length > FOLD_LINES || text.length > FOLD_CHARS;
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!long) return <Markdown math={false}>{text}</Markdown>;
  return (
    <>
      <div
        id={id}
        className={cn(
          !open &&
            'max-h-[18rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]',
        )}
      >
        <Markdown math={false}>{text}</Markdown>
      </div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="mt-1 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      >
        {open ? 'Show less' : 'Show more'}
      </button>
    </>
  );
}
