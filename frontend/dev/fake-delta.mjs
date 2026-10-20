// The delta format of a thread's event stream (docs/api.md "Chat features"), for the fake API only: a plain-JS
// copy of the runtime's DeltaStream and pageView (runtime/src/lib/delta.ts, view.ts), without tool timing.

export const DELTA_VERSION = 1;

export const cursorOf = (id) => Buffer.from(`m:${id}`, 'utf8').toString('base64url');
export const cursorMessage = (cursor) => {
  try {
    const raw = Buffer.from(String(cursor), 'base64url').toString('utf8');
    return raw.startsWith('m:') ? raw.slice(2) : undefined;
  } catch {
    return undefined;
  }
};

/** The view with one page of its messages: the `limit` before `before` (the newest when absent). */
export function pageView(view, { before, limit }) {
  const all = view.messages;
  const end = before === undefined ? all.length : all.findIndex((m) => m.id === before);
  if (end < 0) return { ...view, messages: [] };
  let start = Math.max(0, end - limit);
  while (start > 0 && all[start]?.role === 'tool') start--;
  const { earlierCursor: _, ...rest } = view;
  return {
    ...rest,
    messages: all.slice(start, end),
    ...(start > 0 ? { earlierCursor: cursorOf(all[start].id) } : {}),
  };
}

export function applyDelta(view, event) {
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
      const p = view.partial ?? { text: '', thinking: '' };
      return {
        ...view,
        partial: {
          text: p.text + (event.text ?? ''),
          thinking: p.thinking + (event.thinking ?? ''),
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
          const next = { ...tool, ...(event.status === undefined ? {} : { status: event.status }) };
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
      return { ...view, tools: view.tools.filter((t) => t.callId !== event.callId) };
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
  return view;
}

export class DeltaStream {
  constructor(limit, lastSeq = 0) {
    this.limit = limit;
    this.seq = lastSeq;
    this.sent = undefined;
    this.sentJson = [];
  }

  next(input) {
    // The fake mutates its views in place: work on a copy.
    const view = structuredClone(input);
    const sent = this.sent;
    if (sent === undefined) return [this.snapshot(view)];
    const changes = [];
    if (!this.diffMessages(sent.messages, view.messages, changes)) return [this.snapshot(view)];
    this.diffPartial(sent.partial, view.partial, changes);
    if (!this.diffTools(sent.tools, view.tools, changes))
      changes.push({ type: 'tools.set', tools: view.tools });
    if (sent.busy !== view.busy) changes.push({ type: 'run', busy: view.busy });
    for (const kind of Object.keys(sent.documents ?? {}))
      if (view.documents?.[kind] === undefined) return [this.snapshot(view)];
    for (const [kind, ref] of Object.entries(view.documents ?? {}))
      if (sent.documents?.[kind]?.revision !== ref.revision)
        changes.push({ type: 'document.updated', kind, revision: ref.revision });
    if (JSON.stringify(sent.approvals ?? []) !== JSON.stringify(view.approvals ?? []))
      changes.push({ type: 'approvals.set', approvals: view.approvals ?? [] });
    if (changes.length === 0) return [];
    const events = changes.map((change) => ({ ...change, seq: ++this.seq }));
    let held = sent;
    for (const event of events) held = applyDelta(held, event);
    this.sent = held;
    return events;
  }

  snapshot(view) {
    const windowed = this.limit === undefined ? view : pageView(view, { limit: this.limit });
    this.sent = windowed;
    this.sentJson = windowed.messages.map((m) => JSON.stringify(m));
    return { type: 'snapshot', seq: ++this.seq, v: DELTA_VERSION, view: windowed };
  }

  diffMessages(held, all, changes) {
    let from = 0;
    if (held.length > 0) {
      from = all.findIndex((m) => m.id === held[0].id);
      if (from < 0) return false;
    } else if (this.sent?.earlierCursor !== undefined) return false;
    const now = all.slice(from);
    if (now.length < held.length) return false;
    const json = [];
    for (let i = 0; i < now.length; i++) {
      const message = now[i];
      if (i < held.length && message.id !== held[i].id) return false;
      const text = JSON.stringify(message);
      json.push(text);
      if (i >= held.length) changes.push({ type: 'message.added', message });
      else if (text !== this.sentJson[i]) changes.push({ type: 'message.updated', message });
    }
    this.sentJson = json;
    return true;
  }

  diffPartial(held, now, changes) {
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

  diffTools(held, now, changes) {
    const ids = new Set(now.map((t) => t.callId));
    const kept = held.filter((t) => ids.has(t.callId));
    if (!kept.every((t, i) => now[i]?.callId === t.callId)) return false;
    const out = [];
    for (const t of held)
      if (!ids.has(t.callId)) out.push({ type: 'tool.removed', callId: t.callId });
    for (let i = 0; i < now.length; i++) {
      const tool = now[i];
      const before = kept[i];
      if (before === undefined) {
        out.push({ type: 'tool.started', tool });
        continue;
      }
      const change = {};
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
