/**
 * Tool steps as every renderer describes them. A reply's tool calls are AI SDK
 * `dynamic-tool` parts (see lib/chat-view.ts); this reduces one to a state and
 * a one-line summary, never the raw result.
 */

export type ToolStepState =
  | 'running'
  | 'awaiting-approval'
  | 'approved'
  | 'done'
  | 'error'
  | 'denied';

export interface ToolStepSummary {
  toolCallId: string;
  toolId: string;
  label: string;
  state: ToolStepState;
  /** One line, e.g. "Used bash". */
  summary: string;
  /** Set while the step waits for the person's answer. */
  approvalId: string | null;
  /** Denial reason, if any. */
  reason: string | null;
}

type PartLike = Record<string, unknown>;

/** True for an SDK tool part (`tool-<id>` or `dynamic-tool`). */
export function isToolPart(part: unknown): part is PartLike & { type: string; toolCallId: string } {
  if (typeof part !== 'object' || part === null) return false;
  const candidate = part as PartLike;
  return (
    typeof candidate.type === 'string' &&
    (candidate.type.startsWith('tool-') || candidate.type === 'dynamic-tool') &&
    typeof candidate.toolCallId === 'string'
  );
}

export function toolIdOfPart(part: PartLike): string {
  if (part.type === 'dynamic-tool') return typeof part.toolName === 'string' ? part.toolName : '';
  return String(part.type).slice('tool-'.length);
}

function stepState(part: PartLike): ToolStepState {
  switch (part.state) {
    case 'approval-requested':
      return 'awaiting-approval';
    case 'approval-responded':
      return (part.approval as { approved?: unknown } | undefined)?.approved === true
        ? 'approved'
        : 'denied';
    case 'output-available':
      return 'done';
    case 'output-error':
      return 'error';
    case 'output-denied':
      return 'denied';
    default:
      return 'running';
  }
}

export function summarizeToolPart(part: PartLike): ToolStepSummary {
  const toolId = toolIdOfPart(part);
  const label =
    typeof part.title === 'string' && part.title.trim() ? part.title.trim().slice(0, 120) : toolId;
  const state = stepState(part);
  const approval = part.approval as { id?: unknown; reason?: unknown } | undefined;
  const reason = typeof approval?.reason === 'string' ? approval.reason : null;
  let summary =
    state === 'done'
      ? `Used ${label}`
      : state === 'error'
        ? `${label} failed`
        : state === 'denied'
          ? `${label} was not run`
          : state === 'awaiting-approval'
            ? `${label} is waiting for your approval`
            : `Using ${label}`;
  if (state === 'denied' && reason) summary = `${summary} (${reason})`;
  return {
    toolCallId: String(part.toolCallId),
    toolId,
    label,
    state,
    summary,
    approvalId:
      state === 'awaiting-approval' && typeof approval?.id === 'string' ? approval.id : null,
    reason,
  };
}
