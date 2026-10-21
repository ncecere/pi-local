import type { ActivityEntry, ActivityFilters, ActivityKind } from '~/api/client';

/** The audit log's words (docs/api.md, "Activity (v0.3)"). Pure. */

export const ACTIVITY_KINDS: readonly { id: ActivityKind; label: string }[] = [
  { id: 'tool', label: 'Tool calls' },
  { id: 'message', label: 'Messages' },
  { id: 'approval', label: 'Approvals' },
  { id: 'schedule', label: 'Schedules' },
  { id: 'ask', label: 'Asks between agents' },
  { id: 'sign_in', label: 'Sign-ins' },
  { id: 'budget', label: 'Budget refusals' },
  { id: 'error', label: 'Errors' },
];

export const KIND_LABEL: Record<ActivityKind, string> = {
  tool: 'Tool call',
  message: 'Message',
  approval: 'Approval',
  schedule: 'Schedule',
  ask: 'Ask',
  sign_in: 'Sign-in',
  budget: 'Budget',
  error: 'Error',
};

export const ACTIVITY_OUTCOMES: readonly { id: string; label: string }[] = [
  { id: 'ok', label: 'Done' },
  { id: 'error', label: 'Failed' },
  { id: 'denied', label: 'Denied' },
  { id: 'declined', label: 'Nobody decided' },
  { id: 'refused', label: 'Refused' },
  { id: 'cancelled', label: 'Cancelled' },
];

/** How an outcome reads in a badge (also for a step that isn't over: running, or waiting for a decision). */
export function outcomeLabel(outcome: string): string {
  if (outcome === 'running') return 'Running';
  if (outcome === 'waiting') return 'Waiting for you';
  return ACTIVITY_OUTCOMES.find((candidate) => candidate.id === outcome)?.label ?? outcome;
}

/** Whether an outcome is bad news (red), as opposed to done or a person's choice. */
export function outcomeTone(outcome: string): 'good' | 'bad' | 'neutral' {
  if (outcome === 'ok') return 'good';
  if (outcome === 'error' || outcome === 'refused') return 'bad';
  return 'neutral';
}

/** The query string of `GET /api/activity` (and its export), without a leading "?". */
export function activityQuery(
  filters: ActivityFilters,
  extra: { before?: string | undefined; limit?: number | undefined } = {},
): string {
  const params = new URLSearchParams();
  if (filters.agent) params.set('agent', filters.agent);
  if (filters.thread) params.set('thread', filters.thread);
  if (filters.kind?.length) params.set('kind', filters.kind.join(','));
  if (filters.outcome?.length) params.set('outcome', filters.outcome.join(','));
  if (filters.q?.trim()) params.set('q', filters.q.trim());
  if (filters.since) params.set('since', String(filters.since));
  if (extra.before) params.set('before', extra.before);
  if (extra.limit) params.set('limit', String(extra.limit));
  return params.toString();
}

/** "420 ms", "1.4 s", "38 s", "2 min 5 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${Number(seconds.toFixed(1))} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The arguments a tool was called with, as one short line: the one that says what it did, or all of them. */
export function argumentsLine(args: unknown, max = 140): string {
  if (typeof args !== 'object' || args === null) return '';
  const record = args as Record<string, unknown>;
  for (const key of ['command', 'path', 'url', 'query', 'pattern', 'text', 'message', 'name']) {
    const value = text(record[key]);
    if (value) return clip(value, max);
  }
  const keys = Object.keys(record);
  if (keys.length === 0) return '';
  return clip(
    keys
      .slice(0, 4)
      .map(
        (key) =>
          `${key}: ${typeof record[key] === 'string' ? record[key] : JSON.stringify(record[key])}`,
      )
      .join(', '),
    max,
  );
}

export function clip(value: string, max: number): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The second line of an entry: what the call was, what the message began with, why it failed. */
export function entryLine(entry: ActivityEntry): string {
  const detail = entry.detail ?? {};
  switch (entry.kind) {
    case 'tool':
      return argumentsLine(detail.arguments);
    case 'message':
      return text(detail.preview);
    case 'ask': {
      const preview = text(detail.preview);
      return preview ? `“${preview}”` : '';
    }
    case 'approval':
      return text(detail.reason) || text(detail.summary);
    default:
      return text(detail.error);
  }
}

/** What went wrong or why it was refused, when the entry says. */
export function entryProblem(entry: ActivityEntry): string {
  const error = text(entry.detail?.error);
  return error && entry.kind !== 'error' && entry.kind !== 'sign_in' ? error : '';
}

/** How a tool call's approval went, in words ("Approved by Bo after 12 s"); "" when it needed none. */
export function approvalNote(detail: Record<string, unknown> | undefined): string {
  const approval = detail?.approval;
  if (typeof approval !== 'object' || approval === null) return '';
  const { status, by, waitedMs, reason } = approval as {
    status?: string;
    by?: string;
    waitedMs?: number;
    reason?: string;
  };
  const who = by ? ` by ${by}` : '';
  const after =
    typeof waitedMs === 'number' && waitedMs >= 1000 ? ` after ${formatDuration(waitedMs)}` : '';
  const why = reason ? `: ${clip(reason, 120)}` : '';
  switch (status) {
    case 'approved':
      return `Approved${who}${after}`;
    case 'denied':
      return `Denied${who}${after}${why}`;
    case 'timed_out':
      return `Nobody decided${after}`;
    case 'cancelled':
      return 'The request was cancelled';
    default:
      return '';
  }
}
