import type { ActivityEntry, ActivityKind, ChatMessage, ChatToolCall } from '~/api/client';
import {
  approvalNote,
  argumentsLine,
  clip,
  entryLine,
  entryTitle,
  formatDuration,
  humanToolName,
  previewLine,
} from '~/lib/activity';

/**
 * A conversation's "What happened" timeline: the steps of a conversation in order, from the view's own messages and
 * tool calls (`startedAt`, `endedAt`) and the audit log's entries for the thread (docs/api.md, "Activity (v0.3)").
 * The view says what was said and called; the log adds how each call ended, how long it ran, and what the person
 * decided, and covers what the view no longer carries (earlier pages) or never did (a budget refusal, an error).
 * Pure.
 */

/** How a step ended. `running` and `waiting` (for a person's decision) are not over. */
export type StepOutcome =
  | 'running'
  | 'waiting'
  | 'ok'
  | 'error'
  | 'denied'
  | 'declined'
  | 'refused';

export interface TimelineStep {
  /** Stable across rebuilds, for React. */
  id: string;
  /** Unix ms. */
  at: number;
  /** A message, a reply, a tool call, or the kind of log entry. */
  kind: 'message' | 'reply' | 'tool' | ActivityKind;
  title: string;
  /** What it was: the command, the words a message began with, why it failed. */
  line?: string;
  /** How its approval went; what the log says besides. */
  note?: string;
  durationMs?: number;
  outcome?: StepOutcome;
  /** Another conversation this step opened (an ask). */
  link?: { agentId: string; threadId: string };
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const OUTCOMES = new Set<string>(['ok', 'error', 'denied', 'declined', 'refused']);

function approvalFromView(call: ChatToolCall): string {
  const approval = call.approval;
  if (!approval || approval.status === 'pending') return '';
  const by = approval.decidedBy?.kind === 'system' ? '' : approval.decidedBy?.name;
  const waited =
    approval.decidedAt !== undefined
      ? Math.max(0, approval.decidedAt - approval.requestedAt)
      : undefined;
  return approvalNote({
    approval: { status: approval.status, by, waitedMs: waited, reason: approval.reason },
  });
}

/** The steps of a conversation, oldest first. `hasEarlier`: the view holds only its latest messages. */
export function buildTimeline(
  messages: readonly ChatMessage[],
  activity: readonly ActivityEntry[],
  { hasEarlier = false }: { hasEarlier?: boolean } = {},
): TimelineStep[] {
  const steps: (TimelineStep & { order: number })[] = [];
  const add = (step: TimelineStep) => steps.push({ ...step, order: steps.length });

  // The log's tool calls by call ID, oldest first: a provider may repeat an ID, and each call takes the next.
  const logged = new Map<string, ActivityEntry[]>();
  for (const entry of [...activity].sort((a, b) => a.at - b.at || a.id - b.id)) {
    if (entry.kind !== 'tool') continue;
    const callId = text(entry.detail?.callId);
    logged.set(callId, [...(logged.get(callId) ?? []), entry]);
  }
  const results = new Map<string, Extract<ChatMessage, { role: 'tool' }>>();
  for (const message of messages)
    if (message.role === 'tool') results.set(message.toolCallId, message);
  const erroredReplies = activity.some((entry) => entry.kind === 'error');
  const firstAt = messages.find((message) => message.at !== undefined)?.at;

  for (const message of messages) {
    if (message.role === 'user') {
      const author = message.author;
      const title =
        author?.kind === 'trigger'
          ? `Schedule “${author.name}” sent a message`
          : author?.kind === 'agent'
            ? `${author.name} asked`
            : 'You sent a message';
      add({
        id: message.id,
        at: message.at ?? 0,
        kind: 'message',
        title,
        line: previewLine(message.text, 160),
      });
    } else if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        const entry = logged.get(call.id)?.shift();
        const result = results.get(call.id);
        let outcome: StepOutcome;
        if (entry && OUTCOMES.has(entry.outcome)) outcome = entry.outcome as StepOutcome;
        else if (call.approval?.status === 'pending') outcome = 'waiting';
        else if (result)
          outcome = !result.isError
            ? 'ok'
            : result.text.includes('Tool call blocked')
              ? 'denied'
              : 'error';
        else outcome = call.endedAt !== undefined ? 'ok' : 'running';
        const spanned =
          call.startedAt !== undefined && call.endedAt !== undefined
            ? Math.max(0, call.endedAt - call.startedAt)
            : undefined;
        const durationMs = entry?.durationMs ?? (entry ? undefined : spanned);
        const note = (entry ? approvalNote(entry.detail) : '') || approvalFromView(call);
        // A call that asked says how it was decided (and why); what it was told is only added where that says less.
        const problem =
          (outcome === 'error' || outcome === 'denied') && !note ? text(entry?.detail?.error) : '';
        add({
          id: `call:${call.id}:${message.id}`,
          at: call.startedAt ?? (entry ? entry.at - (entry.durationMs ?? 0) : (message.at ?? 0)),
          kind: 'tool',
          title: humanToolName(call.name),
          line: argumentsLine(call.arguments),
          ...(note || problem ? { note: [note, problem].filter(Boolean).join(' · ') } : {}),
          ...(durationMs !== undefined && durationMs !== null ? { durationMs } : {}),
          outcome,
        });
      }
      if (message.error && !erroredReplies) {
        add({
          id: `err:${message.id}`,
          at: message.at ?? 0,
          kind: 'error',
          title: message.error === 'Interrupted' ? 'The reply was stopped' : 'The reply failed',
          line: message.error === 'Interrupted' ? '' : clip(message.error, 200),
          outcome: 'error',
        });
      } else if (!message.toolCalls?.length && message.text.trim() !== '') {
        add({
          id: message.id,
          at: message.at ?? 0,
          kind: 'reply',
          title: 'Replied',
          line: previewLine(message.text, 160),
        });
      }
    }
  }

  // What the view doesn't carry: calls and messages of earlier pages, and the other kinds of entry.
  for (const entry of [...activity].sort((a, b) => a.at - b.at || a.id - b.id)) {
    const base = {
      id: `log:${entry.id}`,
      at: entry.at,
      kind: entry.kind,
      title: entryTitle(entry),
      ...(entry.durationMs !== null ? { durationMs: entry.durationMs } : {}),
    };
    const outcome = OUTCOMES.has(entry.outcome) ? (entry.outcome as StepOutcome) : undefined;
    switch (entry.kind) {
      case 'tool': {
        if (![...logged.values()].some((rest) => rest.includes(entry))) break; // matched to a call above
        add({
          ...base,
          at: entry.at - (entry.durationMs ?? 0),
          line: entryLine(entry),
          ...(approvalNote(entry.detail) ? { note: approvalNote(entry.detail) } : {}),
          ...(outcome ? { outcome } : {}),
        });
        break;
      }
      case 'message':
        // Sent before the oldest message the view holds.
        if (
          firstAt === undefined ||
          (hasEarlier && entry.at < firstAt - 1000) ||
          messages.length === 0
        )
          add({ ...base, title: `${entry.actor || 'You'} sent a message`, line: entryLine(entry) });
        break;
      case 'approval':
        break; // each call says how it was decided
      case 'ask': {
        const agentId = text(entry.detail?.targetAgentId);
        const threadId = text(entry.detail?.targetThread);
        add({
          ...base,
          line: entryLine(entry),
          ...(outcome ? { outcome } : {}),
          ...(agentId && threadId ? { link: { agentId, threadId } } : {}),
        });
        break;
      }
      default:
        add({
          ...base,
          line: entryLine(entry) || text(entry.detail?.error),
          ...(outcome
            ? { outcome }
            : entry.outcome === 'refused'
              ? { outcome: 'error' as const }
              : {}),
        });
    }
  }

  return steps
    .sort((a, b) => a.at - b.at || a.order - b.order)
    .map(({ order: _order, ...step }) => step);
}

/** One line over the timeline: "7 steps · 1 failed · 1 denied · 38 s from first to last". */
export function timelineSummary(steps: readonly TimelineStep[]): string {
  const count = (outcome: StepOutcome) => steps.filter((step) => step.outcome === outcome).length;
  const parts = [`${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`];
  const failed = count('error');
  const denied = count('denied');
  const undecided = count('declined');
  const refused = count('refused');
  const running = count('running') + count('waiting');
  if (failed) parts.push(`${failed} failed`);
  if (denied) parts.push(`${denied} denied`);
  if (undecided) parts.push(`${undecided} not decided`);
  if (refused) parts.push(`${refused} refused`);
  if (running) parts.push(`${running} not finished`);
  const timed = steps.filter((step) => step.at > 0);
  if (timed.length > 1) {
    const span = timed[timed.length - 1]!.at - timed[0]!.at;
    if (span > 0) parts.push(`${formatDuration(span)} from first to last`);
  }
  return parts.join(' · ');
}
