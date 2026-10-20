import type {
  ChatDocumentRef,
  ChatMessage,
  ChatPartial,
  ChatTool,
  ChatView,
} from '../../src/api/types.ts';
import { applyDelta, DELTA_VERSION, type DeltaEvent } from '../../src/lib/delta.ts';

/**
 * Test only: the server side of the delta format, mirroring the runtime's
 * DeltaStream (runtime/src/lib/delta.ts) closely enough to produce the event
 * sequences a client sees: a snapshot, then the differences between
 * successive views, and a new snapshot whenever they can't be expressed.
 * Tool timing (live metadata, not part of the view) is left out.
 */

type Change = DeltaEvent extends infer E ? (E extends DeltaEvent ? Omit<E, 'seq'> : never) : never;

/** The runtime's cursors are opaque; any string naming the message will do here. */
export const cursorFor = (id: string) => `m:${id}`;

/** The runtime's pageView for the latest `limit` messages: never starting with a tool result. */
export function latestPage(view: ChatView, limit: number): ChatView {
  const all = view.messages;
  let start = Math.max(0, all.length - limit);
  while (start > 0 && all[start]?.role === 'tool') start--;
  const { earlierCursor: _, ...rest } = view;
  return {
    ...rest,
    messages: all.slice(start),
    ...(start > 0 ? { earlierCursor: cursorFor(all[start]!.id) } : {}),
  };
}

function diffDocuments(
  held: Readonly<Record<string, ChatDocumentRef>> | undefined,
  now: Readonly<Record<string, ChatDocumentRef>> | undefined,
  changes: Change[],
): boolean {
  for (const kind of Object.keys(held ?? {})) if (now?.[kind] === undefined) return false;
  for (const [kind, ref] of Object.entries(now ?? {})) {
    if (held?.[kind]?.revision !== ref.revision)
      changes.push({ type: 'document.updated', kind, revision: ref.revision });
  }
  return true;
}

export class TestDeltaStream {
  private seq: number;
  private sent: ChatView | undefined;
  private sentJson: string[] = [];

  constructor(
    private readonly limit: number | undefined,
    lastSeq = 0,
  ) {
    this.seq = lastSeq;
  }

  next(view: ChatView): DeltaEvent[] {
    const sent = this.sent;
    if (sent === undefined) return [this.snapshot(view)];
    const changes: Change[] = [];
    if (!this.diffMessages(sent.messages, view.messages, changes)) return [this.snapshot(view)];
    this.diffPartial(sent.partial, view.partial, changes);
    if (!this.diffTools(sent.tools, view.tools, changes))
      changes.push({ type: 'tools.set', tools: view.tools });
    if (sent.busy !== view.busy) changes.push({ type: 'run', busy: view.busy });
    if (!diffDocuments(sent.documents, view.documents, changes)) return [this.snapshot(view)];
    if (JSON.stringify(sent.approvals ?? []) !== JSON.stringify(view.approvals ?? []))
      changes.push({ type: 'approvals.set', approvals: view.approvals ?? [] });
    if (changes.length === 0) return [];
    const events = changes.map((change) => ({ ...change, seq: ++this.seq }) as DeltaEvent);
    let held: ChatView | undefined = sent;
    for (const event of events) held = applyDelta(held, event);
    this.sent = held;
    return events;
  }

  private snapshot(view: ChatView): DeltaEvent {
    const windowed = this.limit === undefined ? view : latestPage(view, this.limit);
    this.sent = windowed;
    this.sentJson = windowed.messages.map((m) => JSON.stringify(m));
    return { type: 'snapshot', seq: ++this.seq, v: DELTA_VERSION, view: windowed };
  }

  private diffMessages(
    held: readonly ChatMessage[],
    all: readonly ChatMessage[],
    changes: Change[],
  ): boolean {
    let from = 0;
    if (held.length > 0) {
      from = all.findIndex((m) => m.id === held[0]!.id);
      if (from < 0) return false;
    } else if (this.sent?.earlierCursor !== undefined) {
      return false;
    }
    const now = all.slice(from);
    if (now.length < held.length) return false;
    const json: string[] = [];
    for (let i = 0; i < now.length; i++) {
      const message = now[i]!;
      if (i < held.length && message.id !== held[i]!.id) return false;
      const text = JSON.stringify(message);
      json.push(text);
      if (i >= held.length) changes.push({ type: 'message.added', message });
      else if (text !== this.sentJson[i]) changes.push({ type: 'message.updated', message });
    }
    this.sentJson = json;
    return true;
  }

  private diffPartial(
    held: ChatPartial | undefined,
    now: ChatPartial | undefined,
    changes: Change[],
  ): void {
    if (now === undefined) {
      if (held !== undefined) changes.push({ type: 'partial.cleared' });
      return;
    }
    if (
      held === undefined ||
      !now.text.startsWith(held.text) ||
      !now.thinking.startsWith(held.thinking)
    ) {
      changes.push({ type: 'partial.set', partial: now });
      return;
    }
    const text = now.text.slice(held.text.length);
    const thinking = now.thinking.slice(held.thinking.length);
    if (text === '' && thinking === '') return;
    changes.push({
      type: 'partial.appended',
      ...(text === '' ? {} : { text }),
      ...(thinking === '' ? {} : { thinking }),
    });
  }

  private diffTools(held: readonly ChatTool[], now: readonly ChatTool[], changes: Change[]) {
    const ids = new Set(now.map((t) => t.callId));
    const kept = held.filter((t) => ids.has(t.callId));
    if (!kept.every((t, i) => now[i]?.callId === t.callId)) return false;
    const out: Change[] = [];
    for (const t of held)
      if (!ids.has(t.callId)) out.push({ type: 'tool.removed', callId: t.callId });
    for (let i = 0; i < now.length; i++) {
      const tool = now[i]!;
      const before = kept[i];
      if (before === undefined) {
        out.push({ type: 'tool.started', tool });
        continue;
      }
      const change: {
        status?: string;
        output?: string | null;
        outputAppended?: string;
        details?: unknown;
        detailsOmitted?: boolean;
      } = {};
      if (tool.status !== before.status) change.status = tool.status;
      if (JSON.stringify(tool.details) !== JSON.stringify(before.details))
        change.details = tool.details === undefined ? null : tool.details;
      if ((tool.detailsOmitted === true) !== (before.detailsOmitted === true))
        change.detailsOmitted = tool.detailsOmitted === true;
      if (tool.output !== before.output) {
        if (tool.output === undefined) change.output = null;
        else if (before.output !== undefined && tool.output.startsWith(before.output))
          change.outputAppended = tool.output.slice(before.output.length);
        else change.output = tool.output;
      }
      if (Object.keys(change).length === 0) continue;
      out.push({
        type: change.status === 'done' ? 'tool.finished' : 'tool.updated',
        callId: tool.callId,
        ...change,
      });
    }
    changes.push(...out);
    return true;
  }
}
