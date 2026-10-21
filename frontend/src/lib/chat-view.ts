import type { DynamicToolUIPart, UIMessage } from 'ai';
import type {
  Attachment,
  Author,
  ChatApproval,
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatView,
} from '~/api/client';
import { splitAttachmentBlock } from '~/lib/attachments';
import { stripHarness } from '~/lib/diagnostics';
import { type ElicitationOutcome, waitedForDeclined } from '~/lib/elicitation-outcomes';

/**
 * Turns the platform's ChatView (pi's transcript plus the reply in progress)
 * into the AI SDK messages the Open Chat Interface renderers draw.
 *
 * Pi records a reply as a run of messages: an assistant message per model
 * step (thinking, text, tool calls), each followed by the tool results. The
 * interface shows a reply as one message whose parts keep that order, so
 * everything after a user message, up to the next one, becomes one assistant
 * message: reasoning, text, and a `dynamic-tool` part per call (its state and
 * output from the matching result). While the agent works, the step being
 * generated (`partial`) and the running tools' output (`tools`) are added to
 * the last reply.
 *
 * A reply cut off by the runtime being killed (the app quit mid-reply) is
 * recorded as an assistant step with `error: "Interrupted"`; when the runtime
 * comes back it writes the reply again, in full, as a later step of the same
 * turn. The cut-off step is then left out (see supersededSteps), so the turn
 * shows only the finished reply. An Interrupted step that is the last of its
 * turn is a reply someone stopped, and is shown as cancelled.
 */

/** A message sent from this tab that is not in the transcript yet. */
export interface PendingMessage {
  /** Also the platform's idempotency key, so resending it cannot submit it twice. */
  requestId: string;
  text: string;
  /**
   * `sending`: the request is in flight. `queued`: accepted, waiting for the
   * agent to take it (after the reply it is working on). `failed`: refused or
   * unreachable; the text is back in the composer. `confirmed`: the transcript
   * has it; the entry stays so the message keeps the same identity (and DOM
   * row) as it moves from "sent from this tab" to "in the transcript".
   */
  state: 'sending' | 'queued' | 'failed' | 'confirmed';
  /**
   * For transcripts that don't carry request IDs (older runtimes): user
   * messages with this text and no request ID when it was sent, so the n-th
   * such message after them is this one.
   */
  baseline: number;
  /** Sent to steer the reply in progress (`whenBusy: "steer"`) rather than queued after it. */
  steer?: boolean;
  /** The files sent with it. */
  attachments?: Attachment[];
  /** The transcript's id for it, once `confirmed`. */
  matchedId?: string;
}

/** The id a message sent from this tab keeps for its whole life on screen. */
export const pendingIdOf = (message: Pick<PendingMessage, 'requestId'>) =>
  `pending-${message.requestId}`;

/** Metadata on a reply, read by the renderers through metadataOf(). */
export interface ReplyMetadata {
  /** `cancelled` with no message: stopped. `error`: the model request failed. */
  status?: 'cancelled' | 'error' | 'streaming';
  errorMessage?: string;
  /** For a user message from this tab: where it is. */
  pending?: Exclude<PendingMessage['state'], 'failed' | 'confirmed'>;
  /** For a user message from this tab: sent to steer the reply in progress. */
  steer?: boolean;
  /** For a user message: the files sent with it. */
  attachments?: Attachment[];
  /** For a user message that isn't a person's (another agent, a schedule, a service): who sent it. */
  author?: Author;
  /** When the message was sent, or the reply began (Unix ms), as the platform records it. */
  at?: number;
  /** For a reply: the model that wrote it (its last step's). */
  model?: string;
  /** For a reply: tokens used, summed over its steps. */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** For a reply: why its last step ended (`length`: it hit the model's output limit). */
  stopReason?: string;
  /**
   * For the latest reply: requests waiting for approval whose call is not one
   * of its steps (a subagent's call, or one the transcript doesn't show yet).
   */
  approvals?: ChatApproval[];
}

export type AgentUIMessage = UIMessage<ReplyMetadata>;
type Part = AgentUIMessage['parts'][number];

/**
 * The id of the reply to a user message, from the id that message has on
 * screen: stable from the first token to the last (a message sent from this
 * tab keeps its id when the transcript has it), and when earlier pages are
 * put before it (a turn's position would change then).
 */
const replyIdFor = (questionId: string | null) =>
  questionId === null ? 'reply-start' : `reply-${questionId}`;

/** Whether a message is one sent from this tab and not in the transcript yet. */
export const isPendingMessage = (message: { metadata?: unknown }) =>
  Boolean((message.metadata as ReplyMetadata | undefined)?.pending);

/** The output a tool part carries: pi's result text. */
export interface ToolOutput {
  text: string;
}

/** Live output of a running tool, kept on the part until its result arrives. */
export function liveOutputOf(part: { toolMetadata?: unknown }): string | null {
  const live = (part.toolMetadata as { liveOutput?: unknown } | undefined)?.liveOutput;
  return typeof live === 'string' ? live : null;
}

/**
 * A tool's `details` (pi-durable's channel for UIs: an `ask_agent` call's
 * `{agentId, agentName, threadId}`), kept on the part's metadata; undefined when none.
 */
export function toolDetailsOf(part: { toolMetadata?: unknown }): unknown {
  return (part.toolMetadata as { details?: unknown } | undefined)?.details;
}

/**
 * The approval request on a tool part (pending, or how it was decided), kept
 * on its metadata; null when the call needed none. A pending one carries the
 * redacted arguments the view's `approvals` list gives.
 */
export function approvalOf(part: object): ChatApproval | null {
  const metadata = (part as { toolMetadata?: unknown }).toolMetadata;
  const approval = (metadata as { approval?: unknown } | undefined)?.approval;
  return approval &&
    typeof approval === 'object' &&
    typeof (approval as ChatApproval).id === 'string'
    ? (approval as ChatApproval)
    : null;
}

type Metadata = NonNullable<DynamicToolUIPart['toolMetadata']>;

/**
 * A tool part with its approval: on the metadata, and in its state. Waiting:
 * `approval-requested`. Denied, timed out or cancelled: `output-denied` (it
 * was not run). Approved: the call goes on as any other.
 */
function withApproval(part: DynamicToolUIPart, approval: ChatApproval): DynamicToolUIPart {
  const toolMetadata: Metadata = {
    ...(part.toolMetadata ?? {}),
    approval: approval as unknown as Metadata[string],
  };
  const base = {
    type: 'dynamic-tool' as const,
    toolName: part.toolName,
    toolCallId: part.toolCallId,
    input: part.input ?? {},
    toolMetadata,
  };
  if (approval.status === 'pending')
    return { ...base, state: 'approval-requested', approval: { id: approval.id } };
  if (approval.status === 'approved') return { ...part, toolMetadata } as DynamicToolUIPart;
  return {
    ...base,
    state: 'output-denied',
    approval: {
      id: approval.id,
      approved: false,
      ...(approval.reason ? { reason: approval.reason } : {}),
    },
  };
}

/** Whether a tool's details were too large for the view (and left out). */
export function toolDetailsOmittedOf(part: { toolMetadata?: unknown }): boolean {
  return (part.toolMetadata as { detailsOmitted?: unknown } | undefined)?.detailsOmitted === true;
}

/** The metadata with a tool's details added (or that they were left out), when it has any. */
function withDetails(
  metadata: DynamicToolUIPart['toolMetadata'],
  details: unknown,
  omitted?: boolean,
): DynamicToolUIPart['toolMetadata'] {
  if (omitted === true) return { ...(metadata ?? {}), detailsOmitted: true };
  if (details === undefined || details === null) return metadata;
  return { ...(metadata ?? {}), details: details as NonNullable<typeof metadata>[string] };
}

/** A tool result's text, or the live output while it runs. */
export function toolOutputText(part: Record<string, unknown>): string | null {
  const output = part.output as Partial<ToolOutput> | undefined;
  const text =
    typeof output?.text === 'string'
      ? output.text
      : typeof part.errorText === 'string'
        ? part.errorText
        : liveOutputOf(part as { toolMetadata?: unknown });
  // The harness's wrapper around diagnostics is for the model, not for people.
  return text === null ? null : stripHarness(text);
}

interface Reply {
  message: AgentUIMessage;
  /** All occurrences, keyed by stable source identity, not reusable provider ID. */
  tools: Map<string, DynamicToolUIPart>;
  /** Step-local presentation fallback, never approvals. null means duplicate/ambiguous provider ID. */
  round: Map<string, string | null>;
  /** What the steps recorded, accumulated: merged into the reply's metadata after each step. */
  recorded: Pick<ReplyMetadata, 'at' | 'model' | 'usage' | 'stopReason'>;
}

/**
 * `outcomes`: the questions from MCP servers the person declined in this
 * conversation (lib/elicitation-outcomes.ts): a call that waited for one and
 * failed is marked, so its step reads "Declined" rather than "failed".
 */
export function viewToMessages(
  view: ChatView | null,
  pending: readonly PendingMessage[] = [],
  outcomes: readonly ElicitationOutcome[] = [],
): AgentUIMessage[] {
  const messages: AgentUIMessage[] = [];
  const replies: Reply[] = [];
  let reply: Reply | null = null;
  /** The on-screen id of the latest user message: the next reply answers it. */
  let question: string | null = null;
  // Transcript id -> the id the message already has on screen.
  const alias = new Map<string, string>();
  for (const message of pending)
    if (message.state === 'confirmed' && message.matchedId)
      alias.set(message.matchedId, pendingIdOf(message));

  const currentReply = (): Reply => {
    if (!reply) {
      reply = {
        message: { id: replyIdFor(question), role: 'assistant', parts: [], metadata: {} },
        tools: new Map(),
        round: new Map(),
        recorded: {},
      };
      messages.push(reply.message);
      replies.push(reply);
    }
    return reply;
  };

  const transcript = view?.messages ?? [];
  const skip = supersededSteps(transcript, Boolean(view?.busy && hasPartial(view)));
  for (const message of transcript) {
    if (skip.has(message)) continue;
    if (message.role === 'user') {
      reply = null;
      question = alias.get(message.id) ?? message.id;
      const { text, attachments } = userContentOf(message);
      const metadata: ReplyMetadata = {
        ...(typeof message.at === 'number' ? { at: message.at } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        // A person's own messages carry no author line; the others say who wrote them.
        ...(message.author && message.author.kind !== 'user' ? { author: message.author } : {}),
      };
      messages.push({
        id: question,
        role: 'user',
        parts: [{ type: 'text', text }],
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
    } else if (message.role === 'assistant') {
      addAssistantStep(currentReply(), message);
    } else if (message.role === 'tool') {
      addToolResult(currentReply(), message);
    }
  }

  if (view?.busy) {
    const live = currentReply();
    const parts = live.message.parts;
    const thinking = view.partial?.thinking ?? '';
    const text = view.partial?.text ?? '';
    if (thinking) parts.push({ type: 'reasoning', text: thinking, state: 'streaming' });
    if (text) parts.push({ type: 'text', text, state: 'streaming' });
    for (const slot of view.tools ?? []) {
      const key =
        slot.instanceId ??
        (slot.taskId ? `task:${slot.taskId}` : live.round.get(slot.callId)) ??
        `live:${slot.callId}`;
      const part = live.tools.get(key);
      if (part && part.state === 'input-available') {
        if (slot.taskId) part.toolMetadata = { ...(part.toolMetadata ?? {}), taskId: slot.taskId };
        if (slot.output)
          part.toolMetadata = { ...(part.toolMetadata ?? {}), liveOutput: slot.output };
        const metadata = withDetails(part.toolMetadata, slot.details, slot.detailsOmitted);
        if (metadata) part.toolMetadata = metadata;
      } else if (!part) {
        const metadata = withDetails(
          {
            ...(slot.output ? { liveOutput: slot.output } : {}),
            ...(slot.taskId ? { taskId: slot.taskId } : {}),
          },
          slot.details,
          slot.detailsOmitted,
        );
        // A tool running whose call is not committed yet: show it anyway.
        const added: DynamicToolUIPart = {
          type: 'dynamic-tool',
          toolName: slot.name,
          toolCallId: slot.instanceId ?? key,
          state: 'input-available',
          input: {},
          ...(metadata ? { toolMetadata: metadata } : {}),
        };
        live.tools.set(key, added);
        parts.push(added);
      }
    }
    // A reply being written carries no failure from an earlier step.
    live.message.metadata = { status: 'streaming' };
  }

  // Requests waiting for approval: on their call's step, with the redacted
  // arguments; any whose call is not in the transcript, on the latest reply.
  const orphans: ChatApproval[] = [];
  for (const approval of view?.approvals ?? []) {
    if (approval.status !== 'pending') continue;
    // Match the durable request/task, never the first (or last) reuse of a provider ID.
    const matches = replies.flatMap((owner) =>
      [...owner.tools.values()]
        .filter(
          (part) =>
            approvalOf(part)?.id === approval.id ||
            (approval.taskId !== undefined && part.toolMetadata?.taskId === approval.taskId),
        )
        .map((part) => ({ owner, part })),
    );
    const match = matches.length === 1 ? matches[0] : undefined;
    const owner = match?.owner;
    const part = match?.part;
    if (
      !owner ||
      !part ||
      part.state === 'output-available' ||
      part.state === 'output-error' ||
      (approvalOf(part)?.status === 'pending' && approvalOf(part)?.id !== approval.id)
    ) {
      // Even an inconsistent completed snapshot must not silently discard a pending record.
      orphans.push(approval);
      continue;
    }
    const next = withApproval(part, { ...(approvalOf(part) ?? {}), ...approval });
    replacePart(owner, part, next);
  }
  if (orphans.length > 0) {
    const last = replies.at(-1) ?? currentReply();
    last.message.metadata = { ...(last.message.metadata ?? {}), approvals: orphans };
  }

  if (outcomes.length > 0)
    for (const owner of replies)
      for (const part of [...owner.tools.values()]) {
        if (part.state !== 'output-error') continue;
        if (!waitedForDeclined(part.toolName, part.toolMetadata, outcomes)) continue;
        replacePart(owner, part, {
          ...part,
          toolMetadata: { ...(part.toolMetadata ?? {}), elicitation: 'declined' },
        });
      }

  for (const message of pending) {
    if (message.state === 'failed' || message.state === 'confirmed') continue;
    messages.push({
      id: pendingIdOf(message),
      role: 'user',
      parts: [{ type: 'text', text: message.text }],
      metadata: {
        pending: message.state,
        ...(message.steer ? { steer: true } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      },
    });
  }

  return messages;
}

/**
 * A user message's words and files. From v0.2 they come apart (`text`,
 * `attachments`); before, the files were a block at the end of the text.
 */
function userContentOf(message: Extract<ChatMessage, { role: 'user' }>): {
  text: string;
  attachments: Attachment[];
} {
  const text = message.text ?? '';
  if (message.attachments && message.attachments.length > 0)
    return { text, attachments: message.attachments };
  return splitAttachmentBlock(text);
}

const isInterrupted = (message: ChatMessage): message is ChatAssistantMessage =>
  message.role === 'assistant' && message.error === 'Interrupted';

const hasPartial = (view: ChatView) => Boolean(view.partial?.text || view.partial?.thinking);

/**
 * The messages of interrupted partial replies that a later step of the same
 * turn replaced: an assistant step with `error: "Interrupted"` followed, before
 * the next user message, by another assistant step; and the results of the
 * tool calls it made, which belong to the abandoned attempt. An Interrupted
 * step that is the last of its turn stays (a reply that was stopped), unless
 * `streamingAgain`: the runtime is writing the reply again right now (the
 * view is busy with a partial), so the new attempt follows it in this turn.
 */
export function supersededSteps(
  messages: readonly ChatMessage[],
  streamingAgain = false,
): Set<ChatMessage> {
  const skip = new Set<ChatMessage>();
  const replaced: ChatAssistantMessage[] = [];
  let candidates: ChatAssistantMessage[] = [];
  const settle = (superseded: boolean) => {
    if (superseded) replaced.push(...candidates);
    candidates = [];
  };
  for (const message of messages) {
    if (message.role === 'user') settle(false);
    else if (message.role === 'assistant') {
      // A later step of the same turn: every Interrupted step before it was replaced.
      settle(true);
      if (isInterrupted(message)) candidates.push(message);
    }
  }
  settle(streamingAgain);
  const abandonedCalls = new Set<string>();
  const abandonedLegacyResults = new Set<ChatMessage>();
  let round: ChatAssistantMessage | undefined;
  for (const message of messages) {
    if (message.role === 'user') round = undefined;
    if (message.role === 'assistant') round = message;
    if (
      message.role === 'tool' &&
      !message.instanceId &&
      round &&
      replaced.includes(round) &&
      round.toolCalls?.some((call) => call.id === message.toolCallId)
    )
      abandonedLegacyResults.add(message);
  }
  for (const step of replaced) {
    skip.add(step);
    for (const call of step.toolCalls ?? [])
      if (call.instanceId) abandonedCalls.add(call.instanceId);
  }
  for (const message of messages)
    if (
      message.role === 'tool' &&
      ((message.instanceId && abandonedCalls.has(message.instanceId)) ||
        abandonedLegacyResults.has(message))
    )
      skip.add(message);
  return skip;
}

function addAssistantStep(reply: Reply, message: ChatAssistantMessage) {
  const parts = reply.message.parts;
  if (message.thinking) parts.push({ type: 'reasoning', text: message.thinking, state: 'done' });
  if (message.text) parts.push({ type: 'text', text: message.text, state: 'done' });
  reply.round.clear();
  for (const [index, call] of (message.toolCalls ?? []).entries()) {
    const source = call.instanceId ?? `${message.id}/tool/${encodeURIComponent(call.id)}`;
    const key = reply.tools.has(source) ? `${source}/duplicate/${index}` : source;
    // Results can lack task provenance even when their assistant call has a source identity. Only an
    // unambiguous call in THIS step may supply that missing link; approvals never use this index.
    reply.round.set(call.id, reply.round.has(call.id) ? null : key);
    const metadata = {
      ...(call.taskId ? { taskId: call.taskId } : {}),
      ...(call.startedAt !== undefined ? { startedAt: call.startedAt, endedAt: call.endedAt } : {}),
    };
    const plain: DynamicToolUIPart = {
      type: 'dynamic-tool',
      toolName: call.name,
      toolCallId:
        key !== source
          ? key
          : (call.instanceId ??
            ([...reply.tools.values()].some((part) => part.toolCallId === call.id)
              ? key
              : call.id)),
      state: 'input-available',
      input: call.arguments ?? {},
      ...(Object.keys(metadata).length > 0 ? { toolMetadata: metadata } : {}),
    };
    const part = call.approval ? withApproval(plain, call.approval) : plain;
    reply.tools.set(key, part);
    parts.push(part);
  }
  // The latest step decides how the reply ended: a failure, then a retry that
  // worked, is a reply that worked.
  reply.message.metadata = {
    ...(message.error
      ? message.error === 'Interrupted'
        ? { status: 'cancelled' as const }
        : { status: 'error' as const, errorMessage: message.error }
      : {}),
    ...recordStep(reply, message),
  };
}

/** Adds one step's `at`, model, tokens and stop reason to the reply's record, and returns the record. */
function recordStep(reply: Reply, message: ChatAssistantMessage): Reply['recorded'] {
  const recorded = reply.recorded;
  if (typeof message.at === 'number' && recorded.at === undefined) recorded.at = message.at;
  if (message.model?.id) recorded.model = message.model.id;
  if (message.usage) {
    const sum = recorded.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    recorded.usage = {
      input: sum.input + (message.usage.input ?? 0),
      output: sum.output + (message.usage.output ?? 0),
      cacheRead: sum.cacheRead + (message.usage.cacheRead ?? 0),
      cacheWrite: sum.cacheWrite + (message.usage.cacheWrite ?? 0),
      total: sum.total + (message.usage.total ?? 0),
    };
  }
  if (message.stopReason) recorded.stopReason = message.stopReason;
  return { ...recorded };
}

function addToolResult(reply: Reply, message: ChatToolMessage) {
  const id = message.instanceId ?? reply.round.get(message.toolCallId) ?? `result:${message.id}`;
  const text = message.text ?? '';
  const existing = reply.tools.get(id);
  // Its timing, from the call, stays with it when the result arrives; its details come with the result.
  const metadata = withDetails(existing?.toolMetadata, message.details, message.detailsOmitted);
  const base = {
    type: 'dynamic-tool' as const,
    toolName: existing?.toolName ?? message.name ?? 'tool',
    toolCallId: existing?.toolCallId ?? message.instanceId ?? id,
    input: existing?.input ?? {},
    ...(metadata ? { toolMetadata: metadata } : {}),
  };
  const approval = existing ? approvalOf(existing) : null;
  const refused =
    approval !== null && approval.status !== 'approved' && approval.status !== 'pending';
  const done: DynamicToolUIPart = refused
    ? withApproval({ ...base, state: 'input-available' }, approval)
    : message.isError
      ? { ...base, state: 'output-error', errorText: text || 'The tool failed.' }
      : { ...base, state: 'output-available', output: { text } satisfies ToolOutput };
  if (existing) replacePart(reply, existing, done);
  else {
    reply.message.parts.push(done);
    reply.tools.set(id, done);
  }
}

/** Puts `next` where `previous` was in the reply's parts and tool index. */
function replacePart(reply: Reply, previous: DynamicToolUIPart, next: DynamicToolUIPart) {
  const parts = reply.message.parts as Part[];
  const index = parts.indexOf(previous);
  if (index >= 0) parts[index] = next;
  else parts.push(next);
  const key = [...reply.tools].find(([, part]) => part === previous)?.[0];
  if (key !== undefined) reply.tools.set(key, next);
}

/**
 * The new messages, keeping the previous object for every message whose
 * content is unchanged. The renderers memoize rows by object identity, so a
 * transcript re-sent on every token only re-renders the reply being written.
 */
export function reuseUnchanged(
  previous: readonly AgentUIMessage[],
  next: AgentUIMessage[],
): AgentUIMessage[] {
  if (previous.length === 0) return next;
  const byId = new Map(previous.map((message) => [message.id, message]));
  let changed = previous.length !== next.length;
  const merged = next.map((message, index) => {
    const before = byId.get(message.id);
    if (before && sameMessage(before, message)) {
      if (previous[index] !== before) changed = true;
      return before;
    }
    changed = true;
    return message;
  });
  return changed ? merged : (previous as AgentUIMessage[]);
}

const signatures = new WeakMap<AgentUIMessage, string>();
function signature(message: AgentUIMessage): string {
  let value = signatures.get(message);
  if (value === undefined) {
    value = JSON.stringify(message);
    signatures.set(message, value);
  }
  return value;
}
const sameMessage = (a: AgentUIMessage, b: AgentUIMessage) => signature(a) === signature(b);

/**
 * How many user messages in the transcript have exactly this text and no
 * request ID: the ones a message sent now could be confused with when the
 * transcript does not say which request a message came from.
 */
export function userMessagesWithText(
  view: Pick<ChatView, 'messages'> | null,
  text: string,
): number {
  const wanted = text.trim();
  return (view?.messages ?? []).filter(
    (message) =>
      message.role === 'user' && !message.requestId && (message.text ?? '').trim() === wanted,
  ).length;
}
