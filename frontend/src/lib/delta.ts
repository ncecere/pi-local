import type { ChatApproval, ChatMessage, ChatPartial, ChatTool, ChatView } from '~/api/types';

/**
 * The thread event stream's delta format (`GET …/threads/{t}/events?format=delta&v=1`):
 * a snapshot of the chat view, then only what changed. A port of the runtime's
 * reference (runtime/src/lib/delta.ts): `applyDelta` must keep its exact
 * semantics, so applying every event of a stream in order gives the view the
 * stream's next snapshot would send.
 *
 * Unchanged parts keep their objects (`message.added` appends to a copy of
 * the list holding the same message objects), so what is drawn from them can
 * be reused by identity.
 */
export const DELTA_VERSION = 1;

/** Live metadata of a tool event, not part of the view: when the call started (Unix ms) and how long ago. */
export type ToolTiming = { startedAt?: number; elapsedMs?: number };

export type DeltaEvent =
  /** The whole view (windowed when the stream was opened with `limit`); replaces whatever the client had. */
  | { type: 'snapshot'; seq: number; v: typeof DELTA_VERSION; view: ChatView }
  /** A message appended to the transcript. */
  | { type: 'message.added'; seq: number; message: ChatMessage }
  /** A message of the transcript changed: replace it, matched by id. */
  | { type: 'message.updated'; seq: number; message: ChatMessage }
  /** The reply in progress started over or appeared: replace it. */
  | { type: 'partial.set'; seq: number; partial: ChatPartial }
  /** Text and thinking appended to the reply in progress (either may be absent). */
  | { type: 'partial.appended'; seq: number; text?: string; thinking?: string }
  /** No reply in progress any more. */
  | { type: 'partial.cleared'; seq: number }
  /** A tool call of the current round appeared. */
  | ({ type: 'tool.started'; seq: number; tool: ChatTool } & ToolTiming)
  /**
   * A tool call's status, output or details changed: `outputAppended` extends
   * the output, `output` replaces it (null: none); `details` replaces the
   * details (null: none) and `detailsOmitted` says whether they were too large.
   * `tool.finished` is the same change when the status becomes done.
   */
  | ({
      type: 'tool.updated' | 'tool.finished';
      seq: number;
      callId: string;
      status?: string;
      output?: string | null;
      outputAppended?: string;
      details?: unknown;
      detailsOmitted?: boolean;
    } & ToolTiming)
  /** The current round's tool call is gone (the round ended). */
  | { type: 'tool.removed'; seq: number; callId: string }
  /** The tool list was reordered (rare): replace it. */
  | { type: 'tools.set'; seq: number; tools: ChatTool[] }
  /** The run state: busy while the agent works on a message. */
  | { type: 'run'; seq: number; busy: boolean }
  /** An exposed document of the thread changed (or appeared): its new revision. */
  | { type: 'document.updated'; seq: number; kind: string; revision: string }
  /** The thread's pending approvals changed: replace the list (`[]`: none left). */
  | { type: 'approvals.set'; seq: number; approvals: ChatApproval[] };

export type DeltaType = DeltaEvent['type'];

/** Every event type of version 1. */
export const DELTA_TYPES: ReadonlySet<string> = new Set<DeltaType>([
  'snapshot',
  'message.added',
  'message.updated',
  'partial.set',
  'partial.appended',
  'partial.cleared',
  'tool.started',
  'tool.updated',
  'tool.finished',
  'tool.removed',
  'tools.set',
  'run',
  'document.updated',
  'approvals.set',
]);

/**
 * Applies one event to a view and returns the new view (the input is not
 * changed). A faithful port of the runtime's `applyDelta`.
 */
export function applyDelta(view: ChatView | undefined, event: DeltaEvent): ChatView | undefined {
  if (event.type === 'snapshot') return event.view;
  if (view === undefined) return undefined;
  switch (event.type) {
    case 'message.added':
      return { ...view, messages: [...view.messages, event.message] };
    case 'message.updated':
      return {
        ...view,
        messages: view.messages.map((m) => (m.id === event.message.id ? event.message : m)),
      };
    case 'partial.set':
      return { ...view, partial: event.partial };
    case 'partial.appended': {
      const partial = view.partial ?? { text: '', thinking: '' };
      return {
        ...view,
        partial: {
          text: partial.text + (event.text ?? ''),
          thinking: partial.thinking + (event.thinking ?? ''),
        },
      };
    }
    case 'partial.cleared': {
      const { partial: _, ...rest } = view;
      return rest;
    }
    case 'tool.started':
      return { ...view, tools: [...view.tools, event.tool] };
    case 'tool.updated':
    case 'tool.finished':
      return {
        ...view,
        tools: view.tools.map((tool) => {
          if (tool.callId !== event.callId) return tool;
          const next: ChatTool = {
            ...tool,
            ...(event.status === undefined ? {} : { status: event.status }),
          };
          if (event.output === null) delete next.output;
          else if (event.output !== undefined) next.output = event.output;
          if (event.outputAppended !== undefined)
            next.output = (next.output ?? '') + event.outputAppended;
          if (event.details === null) delete next.details;
          else if (event.details !== undefined) next.details = event.details;
          if (event.detailsOmitted === true) next.detailsOmitted = true;
          else if (event.detailsOmitted === false) delete next.detailsOmitted;
          return next;
        }),
      };
    case 'tool.removed':
      return { ...view, tools: view.tools.filter((tool) => tool.callId !== event.callId) };
    case 'tools.set':
      return { ...view, tools: event.tools };
    case 'run':
      return { ...view, busy: event.busy };
    case 'document.updated':
      return {
        ...view,
        documents: { ...(view.documents ?? {}), [event.kind]: { revision: event.revision } },
      };
    case 'approvals.set': {
      const { approvals: _, ...rest } = view;
      return event.approvals.length === 0 ? rest : { ...rest, approvals: event.approvals };
    }
  }
}

/** What a client following a delta stream holds: the view, and the sequence of the last event applied. */
export interface DeltaState {
  view: ChatView | undefined;
  /** The last event's `seq` (sent back as Last-Event-ID on reconnect); 0 before any. */
  seq: number;
}

export const EMPTY_DELTA_STATE: DeltaState = { view: undefined, seq: 0 };

/**
 * One event applied to what the client holds, with the stream's sequence
 * checked: `gap` when an event is missing (or there is no snapshot to apply it
 * to), so the client must reconnect for a new snapshot. A snapshot always
 * applies, whatever its number. Events of a type this version does not know
 * are skipped (their number still counts).
 */
export function followDelta(
  state: DeltaState,
  event: DeltaEvent,
): { state: DeltaState; gap: false } | { state: DeltaState; gap: true } {
  if (event.type === 'snapshot') return { state: { view: event.view, seq: event.seq }, gap: false };
  if (state.view === undefined || event.seq !== state.seq + 1) return { state, gap: true };
  if (!DELTA_TYPES.has(event.type)) return { state: { ...state, seq: event.seq }, gap: false };
  return { state: { view: applyDelta(state.view, event), seq: event.seq }, gap: false };
}

/** Whether an event can change the transcript (and what was sent from this tab should be matched again). */
export const changesMessages = (event: DeltaEvent) =>
  event.type === 'snapshot' || event.type === 'message.added' || event.type === 'message.updated';

/** Reads one event's data; null for anything that isn't a delta event. */
export function parseDeltaEvent(data: string): DeltaEvent | null {
  try {
    const value = JSON.parse(data) as Partial<DeltaEvent> | null;
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') return null;
    if (typeof value.seq !== 'number') return null;
    if (value.type === 'snapshot' && (typeof value.view !== 'object' || value.view === null))
      return null;
    return value as DeltaEvent;
  } catch {
    return null;
  }
}
