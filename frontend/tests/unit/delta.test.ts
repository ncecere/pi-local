import { describe, expect, it } from 'vitest';
import type { ChatView } from '~/api/types';
import { reuseUnchanged, viewToMessages } from '~/lib/chat-view';
import {
  applyDelta,
  type DeltaEvent,
  type DeltaState,
  EMPTY_DELTA_STATE,
  followDelta,
  parseDeltaEvent,
} from '~/lib/delta';
import { parseEvent } from '~/lib/sse';
import { TestDeltaStream } from './delta-builder';

/** A small deterministic PRNG (mulberry32), so a failing case can be replayed from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!,
  };
}

const words = ['alpha ', 'beta ', 'gamma\n', 'δέλτα ', '🙂 ', 'x', '\n\n', '"quoted" '];

/** The next view of a random evolution: what a conversation's commits do to the chat view. */
function evolve(view: ChatView, r: ReturnType<typeof rng>, ids: { next: number }): ChatView {
  const v: ChatView = structuredClone(view);
  switch (r.int(15)) {
    case 0:
    case 1:
    case 2: {
      // Tokens streamed into the reply in progress.
      const p = v.partial ?? { text: '', thinking: '' };
      v.partial =
        r.int(4) === 0
          ? { ...p, thinking: p.thinking + r.pick(words) }
          : { ...p, text: p.text + r.pick(words) + r.pick(words) };
      v.busy = true;
      break;
    }
    case 3: {
      // The reply ends: added to the transcript, with tool calls sometimes.
      const id = `e${ids.next++}`;
      const calls =
        r.int(2) === 0
          ? [{ id: `call${ids.next}`, name: 'get_time', arguments: {}, startedAt: 1000 }]
          : undefined;
      v.messages.push({
        id,
        role: 'assistant',
        text: v.partial?.text ?? 'done',
        ...(calls ? { toolCalls: calls } : {}),
      });
      delete v.partial;
      if (calls) v.tools = [{ callId: calls[0]!.id, name: 'get_time', status: 'pending' }];
      break;
    }
    case 4:
      v.messages.push({
        id: `e${ids.next++}`,
        role: 'user',
        text: r.pick(words),
        at: 5,
        ...(r.int(2) === 0 ? { requestId: `r${ids.next}` } : {}),
      });
      v.busy = true;
      break;
    case 5: {
      // A tool runs and writes output (and, sometimes, details for apps).
      const t = v.tools.at(-1);
      if (t === undefined)
        v.tools.push({ callId: `c${ids.next++}`, name: 'slow', status: 'running' });
      else if (t.status !== 'done') {
        t.status = 'running';
        t.output = r.int(5) === 0 ? r.pick(words) : (t.output ?? '') + r.pick(words);
        const roll = r.int(6);
        if (roll === 0) t.details = { progress: r.int(100) };
        else if (roll === 1) delete t.details;
        else if (roll === 2) {
          delete t.details;
          t.detailsOmitted = true;
        } else if (roll === 3) delete t.detailsOmitted;
      }
      break;
    }
    case 6: {
      // A tool ends: its result is added, its call timed (the call's message changes).
      const t = v.tools.find((x) => x.status !== 'done');
      if (t !== undefined) {
        t.status = 'done';
        delete t.output;
        v.messages.push({
          id: `e${ids.next++}`,
          role: 'tool',
          toolCallId: t.callId,
          name: t.name,
          text: 'ok',
          isError: false,
          ...(r.int(2) === 0 ? { details: { rows: r.int(9) } } : {}),
        });
        for (const m of v.messages)
          if (m.role === 'assistant')
            for (const c of m.toolCalls ?? []) if (c.id === t.callId) c.endedAt = 2000;
      }
      break;
    }
    case 7:
      v.tools = [];
      break;
    case 8:
      v.busy = !v.busy;
      break;
    case 9:
      // A retry starts the reply over.
      if (v.partial) v.partial = { text: r.pick(words), thinking: '' };
      break;
    case 10:
      // Compaction or reset: the transcript loses its start.
      if (r.int(4) === 0) v.messages = v.messages.slice(Math.min(v.messages.length, 1 + r.int(3)));
      break;
    case 11:
      if (v.tools.length > 1) v.tools.reverse();
      else if (v.tools.length === 1)
        v.tools.push({ callId: `c${ids.next++}`, name: 'two', status: 'pending' });
      break;
    case 12: {
      // An exposed document changes (rarely, one goes away: a snapshot says so).
      const kind = r.pick(['research.plan', 'research.sources', 'triage.queue']);
      if (r.int(8) === 0 && v.documents) {
        delete v.documents[kind];
        if (Object.keys(v.documents).length === 0) delete v.documents;
      } else v.documents = { ...(v.documents ?? {}), [kind]: { revision: `rev${ids.next++}` } };
      break;
    }
    case 13: {
      // Approvals asked and decided.
      if (v.approvals && r.int(2) === 0) delete v.approvals;
      else
        v.approvals = [
          ...(v.approvals ?? []),
          {
            id: `ap_${ids.next++}`,
            callId: `c${ids.next}`,
            tool: 'write',
            status: 'pending',
            requestedAt: 1,
          },
        ];
      break;
    }
    case 14: {
      // An earlier message changes (its approval decided, say).
      const m = v.messages[r.int(Math.max(1, v.messages.length))];
      if (m && m.role === 'assistant') m.text += r.pick(words);
      break;
    }
  }
  return v;
}

/** What a client following a windowed stream holds: the view from its window's first message on. */
function windowOf(view: ChatView, client: ChatView): ChatView {
  const from =
    client.messages.length === 0
      ? view.messages.length
      : view.messages.findIndex((m) => m.id === client.messages[0]!.id);
  const { earlierCursor: _, ...rest } = view;
  return {
    ...rest,
    messages: view.messages.slice(from),
    ...(client.earlierCursor ? { earlierCursor: client.earlierCursor } : {}),
  };
}

describe('delta events', () => {
  it('applied in order, rebuild the view a snapshot would give (random evolutions)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const limit = seed % 3 === 0 ? 1 + r.int(4) : undefined;
      const stream = new TestDeltaStream(limit);
      const ids = { next: 1 };
      let view: ChatView = { busy: false, messages: [], tools: [] };
      let state: DeltaState = EMPTY_DELTA_STATE;
      for (let step = 0; step < 60; step++) {
        // Coalescing: several changes may land between two flushes.
        for (let k = 1 + r.int(3); k > 0; k--) view = evolve(view, r, ids);
        for (const event of stream.next(view)) {
          // Through the wire format: an SSE block, parsed as the app parses it.
          const block = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}`;
          const parsed = parseEvent(block)!;
          expect(parsed.id).toBe(String(event.seq));
          const followed = followDelta(state, parseDeltaEvent(parsed.data)!);
          expect(followed.gap, `seed ${seed} step ${step}`).toBe(false);
          state = followed.state;
        }
        const client = state.view!;
        const want = limit === undefined ? view : windowOf(view, client);
        expect(client, `seed ${seed} step ${step}`).toEqual(want);
      }
    }
  }, 60_000);

  it('keep unchanged messages’ objects, so only the reply being written re-renders', () => {
    const base: ChatView = {
      busy: true,
      tools: [],
      messages: [
        { id: 'e1', role: 'user', text: 'first', requestId: 'r1' },
        { id: 'e2', role: 'assistant', text: 'one' },
        { id: 'e3', role: 'user', text: 'second', requestId: 'r2' },
      ],
      partial: { text: 'Hel', thinking: '' },
    };
    const view1 = applyDelta(undefined, { type: 'snapshot', seq: 1, v: 1, view: base })!;
    const view2 = applyDelta(view1, { type: 'partial.appended', seq: 2, text: 'lo' })!;
    expect(view2.messages).toBe(view1.messages);
    expect(view2.partial).toEqual({ text: 'Hello', thinking: '' });

    const before = viewToMessages(view1);
    const after = reuseUnchanged(before, viewToMessages(view2));
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    expect(after[3]).not.toBe(before[3]);

    // A message added: the old ones are the same objects, in a new list.
    const view3 = applyDelta(view2, {
      type: 'message.added',
      seq: 3,
      message: { id: 'e4', role: 'assistant', text: 'Hello' },
    })!;
    expect(view3.messages).not.toBe(view2.messages);
    view2.messages.forEach((message, index) => {
      expect(view3.messages[index]).toBe(message);
    });
    // Updated by id: only that message is replaced.
    const view4 = applyDelta(view3, {
      type: 'message.updated',
      seq: 4,
      message: { id: 'e2', role: 'assistant', text: 'one, edited' },
    })!;
    expect(view4.messages[0]).toBe(view3.messages[0]);
    expect(view4.messages[1]).toEqual({ id: 'e2', role: 'assistant', text: 'one, edited' });
  });

  it('apply tool changes as the runtime does: appended output, details replaced or left out', () => {
    let view = applyDelta(undefined, {
      type: 'snapshot',
      seq: 1,
      v: 1,
      view: { busy: true, messages: [], tools: [] },
    });
    const events: DeltaEvent[] = [
      { type: 'tool.started', seq: 2, tool: { callId: 'c', name: 'bash', status: 'running' } },
      { type: 'tool.updated', seq: 3, callId: 'c', outputAppended: 'a' },
      { type: 'tool.updated', seq: 4, callId: 'c', outputAppended: 'b', details: { n: 1 } },
      { type: 'tool.updated', seq: 5, callId: 'c', details: null, detailsOmitted: true },
    ];
    for (const event of events) view = applyDelta(view, event);
    expect(view!.tools).toEqual([
      { callId: 'c', name: 'bash', status: 'running', output: 'ab', detailsOmitted: true },
    ]);
    view = applyDelta(view, {
      type: 'tool.finished',
      seq: 6,
      callId: 'c',
      status: 'done',
      output: null,
      detailsOmitted: false,
    });
    expect(view!.tools).toEqual([{ callId: 'c', name: 'bash', status: 'done' }]);
    view = applyDelta(view, { type: 'tool.removed', seq: 7, callId: 'c' });
    expect(view!.tools).toEqual([]);
    // Approvals: [] leaves none (and no key); documents get their new revision.
    view = applyDelta(view, { type: 'approvals.set', seq: 8, approvals: [] });
    expect(view).not.toHaveProperty('approvals');
    view = applyDelta(view, { type: 'document.updated', seq: 9, kind: 'k', revision: 'r' });
    expect(view!.documents).toEqual({ k: { revision: 'r' } });
    view = applyDelta(view, { type: 'partial.cleared', seq: 10 });
    expect(view).not.toHaveProperty('partial');
  });
});

describe('following a stream', () => {
  const snapshot = (seq: number, text = 'hi'): DeltaEvent => ({
    type: 'snapshot',
    seq,
    v: 1,
    view: { busy: false, tools: [], messages: [{ id: 'e1', role: 'user', text }] },
  });

  it('applies events in sequence and says when one is missing', () => {
    let state = followDelta(EMPTY_DELTA_STATE, snapshot(41)).state;
    expect(state.seq).toBe(41);
    const next = followDelta(state, { type: 'run', seq: 42, busy: true });
    expect(next.gap).toBe(false);
    state = next.state;
    expect(state.view?.busy).toBe(true);
    // 43 never arrived.
    const gap = followDelta(state, { type: 'run', seq: 44, busy: false });
    expect(gap.gap).toBe(true);
    expect(gap.state).toBe(state);
    // A snapshot (a reconnect, numbered after Last-Event-ID) replaces everything.
    const again = followDelta(state, snapshot(45, 'again'));
    expect(again.gap).toBe(false);
    expect(again.state.view?.messages[0]).toMatchObject({ text: 'again' });
  });

  it('needs a snapshot first, and skips event types it does not know', () => {
    expect(followDelta(EMPTY_DELTA_STATE, { type: 'run', seq: 1, busy: true }).gap).toBe(true);
    const state = followDelta(EMPTY_DELTA_STATE, snapshot(1)).state;
    const unknown = followDelta(state, { type: 'future.thing', seq: 2 } as unknown as DeltaEvent);
    expect(unknown.gap).toBe(false);
    expect(unknown.state.view).toBe(state.view);
    expect(unknown.state.seq).toBe(2);
  });

  it('reads only delta events from the wire', () => {
    expect(parseDeltaEvent('not json')).toBeNull();
    expect(parseDeltaEvent('{"type":"run"}')).toBeNull();
    expect(parseDeltaEvent('{"type":"snapshot","seq":1}')).toBeNull();
    expect(parseDeltaEvent('{"type":"run","seq":3,"busy":true}')).toEqual({
      type: 'run',
      seq: 3,
      busy: true,
    });
  });
});
