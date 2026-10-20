import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpTransport } from '~/api/transport';
import type { ChatMessage, ChatView } from '~/api/types';
import { viewToMessages } from '~/lib/chat-view';
import type { parseEvent } from '~/lib/sse';
import { earlierCursorOf, prependPage, rebaseEarlier, withEarlier } from '~/lib/transcript-pages';

const user = (id: string): ChatMessage => ({ id, role: 'user', text: id });
const reply = (id: string): ChatMessage => ({ id, role: 'assistant', text: id });
const live = (messages: ChatMessage[], earlierCursor?: string): ChatView => ({
  busy: false,
  tools: [],
  messages,
  ...(earlierCursor ? { earlierCursor } : {}),
});

describe('earlier pages', () => {
  it('are put before the live window, without repeating what is held', () => {
    const view = live([user('e5'), reply('e6')], 'c5');
    expect(earlierCursorOf(null, view)).toBe('c5');
    const first = prependPage(null, view, {
      messages: [user('e3'), reply('e4')],
      earlierCursor: 'c3',
    });
    expect(first).toEqual({ messages: [user('e3'), reply('e4')], cursor: 'c3' });
    expect(earlierCursorOf(first, view)).toBe('c3');
    // The start: no cursor left.
    const second = prependPage(first, view, { messages: [user('e1'), reply('e4')] });
    expect(second.messages.map((m) => m.id)).toEqual(['e1', 'e3', 'e4']);
    expect(earlierCursorOf(second, view)).toBeUndefined();
    expect(withEarlier(view, second)?.messages.map((m) => m.id)).toEqual([
      'e1',
      'e3',
      'e4',
      'e5',
      'e6',
    ]);
  });

  it('survive a new snapshot: what was shown before its window stays', () => {
    const before = live([user('e3'), reply('e4'), user('e5'), reply('e6')], 'c3');
    const earlier = { messages: [user('e1'), reply('e2')], cursor: undefined };
    // A reconnect: the window is the latest two now.
    const next = live([user('e5'), reply('e6')], 'c5');
    const rebased = rebaseEarlier(earlier, before, next);
    expect(rebased?.messages.map((m) => m.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(rebased?.cursor).toBeUndefined();
    // Without pages loaded, the messages that left the window stay too.
    const kept = rebaseEarlier(null, before, next);
    expect(kept).toEqual({ messages: [user('e3'), reply('e4')], cursor: 'c3' });
    // The same window again: nothing to keep apart.
    expect(rebaseEarlier(null, before, before)).toBeNull();
  });

  it('are dropped when the snapshot no longer lines up (reset, compaction) or holds everything', () => {
    const before = live([user('e3'), reply('e4')], 'c3');
    const earlier = { messages: [user('e1'), reply('e2')], cursor: undefined };
    expect(rebaseEarlier(earlier, before, live([user('e9')], 'c9'))).toBeNull();
    expect(rebaseEarlier(earlier, before, live([user('e1'), reply('e2'), user('e3')]))).toBeNull();
    expect(rebaseEarlier(null, null, live([user('e3')], 'c3'))).toBeNull();
  });
});

describe('the stream request', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends Last-Event-ID as a header, and events carry their id', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'id: 7\nevent: run\ndata: {"type":"run","seq":7,"busy":true}\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetch = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const events: ReturnType<typeof parseEvent>[] = [];
    await httpTransport.stream(
      '/x?format=delta&v=1',
      (event) => events.push(event),
      new AbortController().signal,
      {
        'Last-Event-ID': '6',
      },
    );
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ 'Last-Event-ID': '6', Accept: 'text/event-stream' });
    expect(events).toEqual([{ event: 'run', data: '{"type":"run","seq":7,"busy":true}', id: '7' }]);
  });
});

describe('steering', () => {
  it('marks a message sent to steer the reply in progress until the transcript has it', () => {
    const messages = viewToMessages({ busy: true, tools: [], messages: [user('e1')] }, [
      { requestId: 's1', text: 'also this', state: 'queued', baseline: 0, steer: true },
      { requestId: 'q1', text: 'later', state: 'queued', baseline: 0 },
    ]);
    expect(messages.at(-2)?.metadata).toEqual({ pending: 'queued', steer: true });
    expect(messages.at(-1)?.metadata).toEqual({ pending: 'queued' });
  });
});
