import type { UIMessage } from 'ai';
import { Bot, Clock, Zap } from 'lucide-react';
import { memo, useId, useState } from 'react';
import type { Agent, Author } from '~/api/client';
import { AgentAvatar } from '~/components/agent/agent-avatar';
import { ApprovalCard } from '~/components/chat/approval-card';
import { MessageAttachments } from '~/components/chat/attachments';
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
import { MessageEditor } from '~/components/chat/message-editor';
import { RememberChip, rememberOf } from '~/components/chat/remember-chip';
import { ReplyFailureNote } from '~/components/chat/reply-outcome-note';
import { WorkBlock } from '~/components/chat/reply-work';
import type { ToolPart } from '~/components/chat/tool-steps';
import { useAgents } from '~/hooks/use-agents';
import { approvalOf, type ReplyMetadata } from '~/lib/chat-view';
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
  /**
   * A message of the person's: sends an edited version in a new conversation.
   * Answers an error to show, or null once on its way.
   */
  onEdit?: (messageId: string, text: string) => Promise<string | null>;
  /** A finished reply: a new conversation with everything up to it. */
  onBranch?: (messageId: string) => Promise<void>;
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

const STEER_NOTE = 'Steering: joins the reply in progress after its current step.';

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
  onEdit,
  onBranch,
}: MessageRowProps) {
  const text = textOf(message);
  const excerpt = messageExcerptOf(message) ?? undefined;
  const place = (excerpt && position) || undefined;
  const [editing, setEditing] = useState(false);
  const [branching, setBranching] = useState(false);

  if (message.role === 'user') {
    const metadata = message.metadata as ReplyMetadata | undefined;
    const pending = metadata?.pending;
    const steer = metadata?.steer === true;
    const attachments = metadata?.attachments ?? [];
    // Another agent, a schedule or a service wrote it: it must not read as the person's.
    if (metadata?.author)
      return (
        <SenderMessage
          message={message}
          author={metadata.author}
          text={text}
          excerpt={excerpt}
          place={place}
        />
      );
    if (editing && onEdit)
      return (
        <article
          className="flex flex-col items-end"
          aria-label="Your message, being edited"
          data-message-id={message.id}
          data-message-role="user"
        >
          <MessageEditor
            text={text}
            onCancel={() => setEditing(false)}
            onSubmit={(edited) => onEdit(message.id, edited)}
          />
        </article>
      );
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
          {text && <FoldedText text={text} />}
          <MessageAttachments attachments={attachments} className={text ? 'mt-2.5' : undefined} />
        </div>
        {pending ? (
          <p
            role="status"
            className="mt-1.5 flex items-center gap-1 text-xs text-[var(--text-muted)]"
          >
            {steer ? (
              <Zap className="size-3" aria-hidden="true" />
            ) : (
              <Clock className="size-3" aria-hidden="true" />
            )}
            {steer && pending === 'queued' ? STEER_NOTE : PENDING_NOTE[pending]}
          </p>
        ) : (
          <MessageActions
            text={text}
            position={place}
            onEdit={onEdit ? () => setEditing(true) : undefined}
            info={replyInfo(message.metadata as ReplyMetadata | undefined)}
          />
        )}
      </article>
    );
  }

  const branch = onBranch
    ? () => {
        setBranching(true);
        void onBranch(message.id).finally(() => setBranching(false));
      }
    : undefined;

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
        {streaming &&
        agent &&
        !text &&
        !reasoningOf(message) &&
        !message.parts.some(isToolPart) &&
        !(message.metadata as ReplyMetadata | undefined)?.approvals?.length ? (
          // Nothing of the reply yet: say so beside its avatar, instead of a second one below.
          <p role="status" className="flex h-7 items-center text-xs text-[var(--text-muted)]">
            <span className="text-shimmer">Thinking…</span>
          </p>
        ) : (
          <ReplyBody
            key={message.id}
            message={message}
            text={text}
            streaming={streaming}
            agentId={agent?.id}
          />
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
              onBranch={branch}
              branching={branching}
              info={replyInfo(message.metadata as ReplyMetadata | undefined)}
            />
          </>
        )}
      </div>
    </article>
  );
});

const KIND_LABEL: Record<Author['kind'], string> = {
  user: 'You',
  agent: 'Agent',
  trigger: 'Schedule',
  service_account: 'Service',
};

/** Who is speaking, beside a message that isn't the person's: the agent's own avatar, or an icon. */
function SenderAvatar({ author }: { author: Author }) {
  if (author.kind === 'agent') return <AgentSenderAvatar author={author} />;
  const Icon = author.kind === 'trigger' ? Clock : Bot;
  return (
    <span className="flex size-7 items-center justify-center rounded-full bg-[var(--bg-control-alt)] text-[var(--text-muted)]">
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}

function AgentSenderAvatar({ author }: { author: Author }) {
  const agent = useAgents().data?.find((candidate) => candidate.id === author.id);
  if (!agent)
    return (
      <span className="flex size-7 items-center justify-center rounded-full bg-[var(--bg-control-alt)] text-[var(--text-muted)]">
        <Bot className="size-4" aria-hidden="true" />
      </span>
    );
  return <AgentAvatar agent={agent} size={28} frozen />;
}

/**
 * A message another agent asked, a schedule sent, or a service sent: on the
 * left with its sender's avatar and name, as an agent's reply is, never as the
 * person's. It can be copied, not edited (an edit would be the person's).
 */
function SenderMessage({
  message,
  author,
  text,
  excerpt,
  place,
}: {
  message: UIMessage;
  author: Author;
  text: string;
  excerpt?: string;
  place?: string;
}) {
  const attachments = (message.metadata as ReplyMetadata | undefined)?.attachments ?? [];
  return (
    <article
      className="group flex gap-3"
      aria-label={`Message from ${author.name}`}
      data-excerpt={excerpt}
      data-position={place}
      data-message-id={message.id}
      data-message-role="user"
      data-author-kind={author.kind}
    >
      <div className="mt-px shrink-0">
        <SenderAvatar author={author} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-start">
        <p className="mb-1 flex items-center gap-1.5 text-xs">
          <span className="font-medium text-[var(--text-primary)]">{author.name}</span>
          <span className="text-[var(--text-muted)]">{KIND_LABEL[author.kind]}</span>
        </p>
        <div className="max-w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/50 px-4 py-3 text-[0.9375rem] leading-relaxed text-[var(--text-primary)]">
          {text && <FoldedText text={text} />}
          <MessageAttachments attachments={attachments} className={text ? 'mt-2.5' : undefined} />
        </div>
        <MessageActions
          text={text}
          position={place}
          info={replyInfo(message.metadata as ReplyMetadata | undefined)}
        />
      </div>
    </article>
  );
}

/**
 * A reply's work and text: one block with everything the agent did before
 * answering (reasoning and tool calls, in order), then the text.
 */
function ReplyBody({
  message,
  text,
  streaming,
  agentId,
}: {
  message: UIMessage;
  text: string;
  streaming: boolean;
  /** Whose reply it is: where an approval is sent. */
  agentId?: string;
}) {
  const layout = replyLayoutOf(
    message.parts as ToolPart[],
    isToolPart,
    // A call waiting for approval is a step of the work, and its card stays in sight below it.
    // What `remember` saved shows as a chip in sight, instead of a step.
    (part) => (rememberOf(part) ? 'result' : waitsForApproval(part) ? 'both' : 'work'),
    (part) => `tool-${part.toolCallId}`,
  );
  const orphans = (message.metadata as ReplyMetadata | undefined)?.approvals ?? [];
  return (
    <>
      {layout.work.length > 0 && (
        <WorkBlock messageId={message.id} layout={layout} streaming={streaming} />
      )}
      {layout.results.map((part) =>
        rememberOf(part) ? (
          <RememberChip key={`remember-${part.toolCallId}`} part={part} agentId={agentId} />
        ) : null,
      )}
      {agentId &&
        layout.results.map((part) => {
          const approval = approvalOf(part);
          return approval ? (
            <ApprovalCard
              key={`approval-${approval.id}`}
              agentId={agentId}
              approval={approval}
              args={part.input}
            />
          ) : null;
        })}
      {agentId &&
        orphans.map((approval) => (
          <ApprovalCard key={`approval-${approval.id}`} agentId={agentId} approval={approval} />
        ))}
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

const waitsForApproval = (part: ToolPart) =>
  part.state === 'approval-requested' && approvalOf(part)?.status === 'pending';

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
