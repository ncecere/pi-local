import { describe, expect, it } from 'vitest';
import type { ChatView } from '~/api/client';
import { reconcile } from '~/hooks/use-agent-thread';
import {
  type PendingMessage,
  reuseUnchanged,
  toolOutputText,
  userMessagesWithText,
  viewToMessages,
} from '~/lib/chat-view';
import { parseEvent } from '~/lib/sse';

const transcript: ChatView = {
  busy: false,
  tools: [],
  messages: [
    { id: 'e1', role: 'user', text: 'List the files' },
    {
      id: 'e2',
      role: 'assistant',
      text: 'Let me look.',
      thinking: 'I should run ls.',
      toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'ls' } }],
    },
    { id: 'e3', role: 'tool', toolCallId: 'c1', name: 'bash', text: 'a.ts\nb.ts', isError: false },
    { id: 'e4', role: 'assistant', text: 'There are two files.' },
  ],
};

describe('viewToMessages', () => {
  it('folds a reply’s steps and tool results into one assistant message, in order', () => {
    const messages = viewToMessages(transcript);
    expect(messages.map((message) => [message.id, message.role])).toEqual([
      ['e1', 'user'],
      ['reply-e1', 'assistant'],
    ]);
    const reply = messages[1]!;
    expect(reply.parts.map((part) => part.type)).toEqual([
      'reasoning',
      'text',
      'dynamic-tool',
      'text',
    ]);
    const tool = reply.parts[2] as Record<string, unknown>;
    expect(tool).toMatchObject({
      toolName: 'bash',
      toolCallId: 'c1',
      state: 'output-available',
      input: { command: 'ls' },
    });
    expect(toolOutputText(tool)).toBe('a.ts\nb.ts');
  });

  it('marks failed tools and failed or interrupted replies', () => {
    const failed = viewToMessages({
      busy: false,
      tools: [],
      messages: [
        { id: 'e1', role: 'user', text: 'go' },
        {
          id: 'e2',
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'c1', name: 'read', arguments: {} }],
        },
        { id: 'e3', role: 'tool', toolCallId: 'c1', name: 'read', text: 'ENOENT', isError: true },
        { id: 'e4', role: 'assistant', text: '', error: 'rate limited' },
        { id: 'e5', role: 'user', text: 'again' },
        { id: 'e6', role: 'assistant', text: 'partial', error: 'Interrupted' },
      ],
    });
    expect(failed[1]!.parts[0]).toMatchObject({ state: 'output-error', errorText: 'ENOENT' });
    expect(failed[1]!.metadata).toEqual({ status: 'error', errorMessage: 'rate limited' });
    expect(failed[3]!.metadata).toEqual({ status: 'cancelled' });
  });

  it('shows only the completed reply when an interrupted partial reply was resumed', () => {
    // The runtime was killed mid-reply, then resumed and wrote the reply again in the same turn.
    const messages = viewToMessages({
      busy: false,
      tools: [],
      messages: [
        { id: 'e1', role: 'user', text: 'Write a poem' },
        {
          id: 'e2',
          role: 'assistant',
          text: 'Roses are',
          error: 'Interrupted',
          stopReason: 'aborted',
          usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 },
        },
        {
          id: 'e3',
          role: 'assistant',
          text: 'Roses are red, violets are blue.',
          stopReason: 'stop',
          usage: { input: 10, output: 8, cacheRead: 0, cacheWrite: 0, total: 18 },
        },
        { id: 'e4', role: 'user', text: 'Another' },
        { id: 'e5', role: 'assistant', text: 'Sure.', stopReason: 'stop' },
      ],
    });
    expect(messages.map((message) => message.id)).toEqual(['e1', 'reply-e1', 'e4', 'reply-e4']);
    const reply = messages[1]!;
    expect(reply.parts).toEqual([
      { type: 'text', text: 'Roses are red, violets are blue.', state: 'done' },
    ]);
    // Not cancelled, and the abandoned attempt's tokens are not counted.
    expect(reply.metadata?.status).toBeUndefined();
    expect(reply.metadata?.usage?.total).toBe(18);
    expect(reply.metadata?.stopReason).toBe('stop');
  });

  it('drops an interrupted step’s tool calls and results along with it', () => {
    const messages = viewToMessages({
      busy: false,
      tools: [],
      messages: [
        { id: 'e1', role: 'user', text: 'list' },
        {
          id: 'e2',
          role: 'assistant',
          text: '',
          error: 'Interrupted',
          stopReason: 'aborted',
          toolCalls: [{ id: 'old', name: 'bash', arguments: { command: 'ls' } }],
        },
        { id: 'e3', role: 'tool', toolCallId: 'old', name: 'bash', text: 'aborted', isError: true },
        {
          id: 'e4',
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'new', name: 'bash', arguments: { command: 'ls' } }],
        },
        { id: 'e5', role: 'tool', toolCallId: 'new', name: 'bash', text: 'a.ts', isError: false },
        { id: 'e6', role: 'assistant', text: 'One file.' },
      ],
    });
    const parts = messages[1]!.parts as Record<string, unknown>[];
    expect(parts.map((part) => part.toolCallId ?? part.text)).toEqual(['new', 'One file.']);
  });

  it('keeps a reply that was stopped (Interrupted as the last step of its turn) as cancelled', () => {
    const messages = viewToMessages({
      busy: false,
      tools: [],
      messages: [
        { id: 'e1', role: 'user', text: 'Write a poem' },
        {
          id: 'e2',
          role: 'assistant',
          text: 'Roses are',
          error: 'Interrupted',
          stopReason: 'aborted',
        },
        // The next turn's reply does not replace it: it answers another message.
        { id: 'e3', role: 'user', text: 'Never mind' },
        { id: 'e4', role: 'assistant', text: 'OK.' },
      ],
    });
    const stopped = messages[1]!;
    expect(stopped.parts).toEqual([{ type: 'text', text: 'Roses are', state: 'done' }]);
    expect(stopped.metadata).toMatchObject({ status: 'cancelled', stopReason: 'aborted' });
    expect(messages[3]!.parts).toEqual([{ type: 'text', text: 'OK.', state: 'done' }]);
  });

  it('hides the interrupted attempt while the reply is being written again', () => {
    const base = [
      { id: 'e1', role: 'user' as const, text: 'Write a poem' },
      {
        id: 'e2',
        role: 'assistant' as const,
        text: 'Roses are',
        error: 'Interrupted',
        stopReason: 'aborted',
      },
    ];
    const resuming = viewToMessages({
      busy: true,
      tools: [],
      messages: base,
      partial: { text: 'Roses', thinking: '' },
    });
    expect(resuming[1]!.parts).toEqual([{ type: 'text', text: 'Roses', state: 'streaming' }]);
    // Busy without a new attempt streaming (a stop settling): the stopped text stays.
    const settling = viewToMessages({ busy: true, tools: [], messages: base });
    expect(settling[1]!.parts).toEqual([{ type: 'text', text: 'Roses are', state: 'done' }]);
  });

  it('adds the step being generated and running tools’ live output while busy', () => {
    const messages = viewToMessages({
      busy: true,
      messages: [
        { id: 'e1', role: 'user', text: 'build it' },
        {
          id: 'e2',
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'make' } }],
        },
      ],
      tools: [{ callId: 'c1', name: 'bash', status: 'running', output: 'compiling…' }],
      partial: { text: '', thinking: '' },
    });
    const reply = messages[1]!;
    expect(reply.id).toBe('reply-e1');
    expect(reply.metadata).toEqual({ status: 'streaming' });
    const tool = reply.parts[0] as Record<string, unknown>;
    expect(tool.state).toBe('input-available');
    expect(toolOutputText(tool)).toBe('compiling…');
  });

  it('gives the live reply the same id before and after its first step is committed', () => {
    const before = viewToMessages({
      busy: true,
      tools: [],
      messages: [{ id: 'e1', role: 'user', text: 'hi' }],
      partial: { text: 'Hel', thinking: '' },
    });
    const after = viewToMessages({
      busy: false,
      tools: [],
      messages: [
        { id: 'e1', role: 'user', text: 'hi' },
        { id: 'e2', role: 'assistant', text: 'Hello' },
      ],
    });
    expect(before[1]!.id).toBe(after[1]!.id);
    expect(before[1]!.parts).toEqual([{ type: 'text', text: 'Hel', state: 'streaming' }]);
  });

  it('appends messages sent from this tab after the transcript, except failed ones', () => {
    const pending: PendingMessage[] = [
      { requestId: 'r1', text: 'next', state: 'queued', baseline: 0 },
      { requestId: 'r2', text: 'nope', state: 'failed', baseline: 0 },
    ];
    const messages = viewToMessages(transcript, pending);
    expect(messages.at(-1)).toMatchObject({
      id: 'pending-r1',
      role: 'user',
      metadata: { pending: 'queued' },
    });
    expect(messages).toHaveLength(3);
  });
});

describe('reply ids', () => {
  it('stay the same when earlier messages are put before the transcript', () => {
    const page = viewToMessages(transcript);
    const withEarlier = viewToMessages({
      ...transcript,
      messages: [
        { id: 'e0', role: 'user', text: 'Earlier question' },
        { id: 'e0:1', role: 'assistant', text: 'Earlier answer' },
        ...transcript.messages,
      ],
    });
    expect(withEarlier.slice(2).map((message) => message.id)).toEqual(
      page.map((message) => message.id),
    );
    // Unchanged rows keep their objects across the page being added.
    const merged = reuseUnchanged(page, withEarlier);
    expect(merged[2]).toBe(page[0]);
    expect(merged[3]).toBe(page[1]);
  });
});

describe('tool details', () => {
  it('keeps a result’s details, and says when they were left out', () => {
    const messages = viewToMessages({
      busy: true,
      messages: [
        { id: 'e1', role: 'user', text: 'plan it' },
        {
          id: 'e2',
          role: 'assistant',
          text: '',
          toolCalls: [
            { id: 'c1', name: 'research_plan', arguments: {} },
            { id: 'c2', name: 'big', arguments: {} },
          ],
        },
        {
          id: 'e3',
          role: 'tool',
          toolCallId: 'c1',
          name: 'research_plan',
          text: 'ok',
          isError: false,
          details: { question: 'q', steps: [] },
        },
      ],
      tools: [{ callId: 'c2', name: 'big', status: 'running', detailsOmitted: true }],
    });
    const parts = messages[1]!.parts as { toolMetadata?: Record<string, unknown> }[];
    expect(parts[0]!.toolMetadata).toMatchObject({ details: { question: 'q', steps: [] } });
    expect(parts[1]!.toolMetadata).toMatchObject({ detailsOmitted: true });
  });
});

describe('reuseUnchanged', () => {
  it('keeps unchanged message objects so memoized rows do not re-render', () => {
    const first = viewToMessages(transcript);
    const second = viewToMessages({ ...transcript });
    const merged = reuseUnchanged(first, second);
    expect(merged).toBe(first);

    const third = viewToMessages({
      ...transcript,
      messages: [...transcript.messages, { id: 'e5', role: 'user', text: 'thanks' }],
    });
    const next = reuseUnchanged(first, third);
    expect(next).not.toBe(first);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).toBe(first[1]);
  });
});

describe('userMessagesWithText', () => {
  it('counts the user messages with exactly that text', () => {
    expect(userMessagesWithText(transcript, '  List the files ')).toBe(1);
    expect(userMessagesWithText(transcript, 'other')).toBe(0);
    expect(userMessagesWithText(null, 'x')).toBe(0);
  });
});

describe('parseEvent', () => {
  it('reads named events, multi-line data, and skips comments', () => {
    expect(parseEvent('event: view\ndata: {"a":1}')).toEqual({ event: 'view', data: '{"a":1}' });
    expect(parseEvent('data: one\ndata: two')).toEqual({ event: 'message', data: 'one\ntwo' });
    expect(parseEvent(': keep-alive')).toBeNull();
  });
});

describe('reconcile and stable identity', () => {
  const sent = (requestId: string, text: string, baseline = 0): PendingMessage => ({
    requestId,
    text,
    state: 'queued',
    baseline,
  });

  it('keeps a message’s id as it moves from sent-here to in-the-transcript, so it does not re-mount', () => {
    const queued = [sent('r1', 'List the files')];
    const before = viewToMessages({ busy: true, tools: [], messages: [] }, queued);
    expect(before.map((message) => message.id)).toEqual(['reply-start', 'pending-r1']);

    const confirmed = reconcile(queued, { ...transcript, busy: false });
    expect(confirmed[0]).toMatchObject({ state: 'confirmed', matchedId: 'e1' });
    const after = viewToMessages(transcript, confirmed);
    expect(after.map((message) => message.id)).toEqual(['pending-r1', 'reply-pending-r1']);
    // Not shown twice, and no longer marked as waiting.
    expect(after[0]!.metadata).toBeUndefined();
  });

  it('gives the reply the same id before and after its question is in the transcript', () => {
    const queued = [sent('r1', 'hi')];
    const early = viewToMessages(
      {
        busy: true,
        tools: [],
        messages: [{ id: 'e1', role: 'user', text: 'hi' }],
        partial: { text: 'He', thinking: '' },
      },
      reconcile(queued, {
        busy: true,
        tools: [],
        messages: [{ id: 'e1', role: 'user', text: 'hi' }],
      }),
    );
    expect(early.map((message) => message.id)).toEqual(['pending-r1', 'reply-pending-r1']);
  });

  it('tells the same words sent twice apart, oldest first', () => {
    const view: ChatView = {
      busy: false,
      tools: [],
      messages: [
        { id: 'e1', role: 'user', text: 'again' },
        { id: 'e2', role: 'assistant', text: 'ok' },
        { id: 'e3', role: 'user', text: 'again' },
      ],
    };
    const result = reconcile([sent('a', 'again'), sent('b', 'again')], view);
    expect(result.map((message) => [message.requestId, message.state, message.matchedId])).toEqual([
      ['a', 'confirmed', 'e1'],
      ['b', 'confirmed', 'e3'],
    ]);
    // Only the first has arrived: the second still waits.
    const half = reconcile([sent('a', 'again'), sent('b', 'again')], {
      ...view,
      messages: view.messages.slice(0, 2),
    });
    expect(half.map((message) => message.state)).toEqual(['confirmed', 'queued']);
  });

  it('matches by request ID, never by text, when the transcript carries request IDs', () => {
    const view: ChatView = {
      busy: false,
      tools: [],
      messages: [
        { id: 'e1', role: 'user', text: 'again', requestId: 'b' },
        { id: 'e2', role: 'assistant', text: 'ok' },
        { id: 'e3', role: 'user', text: 'again', requestId: 'a' },
      ],
    };
    // Sent a then b, but the transcript has them the other way round (a steer jumped ahead).
    const result = reconcile([sent('a', 'again'), sent('b', 'again')], view);
    expect(result.map((message) => [message.requestId, message.state, message.matchedId])).toEqual([
      ['a', 'confirmed', 'e3'],
      ['b', 'confirmed', 'e1'],
    ]);
    // Another tab's message with the same words is not this one.
    const other = reconcile([sent('mine', 'again')], view);
    expect(other[0]!.state).toBe('queued');
    // Text edited on the way (trimmed, or the files' block) still matches by ID.
    const edited = reconcile([sent('a', 'again, differently')], view);
    expect(edited[0]).toMatchObject({ state: 'confirmed', matchedId: 'e3' });
  });

  it('falls back to the text for messages without request IDs (older conversations)', () => {
    const view: ChatView = {
      busy: false,
      tools: [],
      messages: [
        { id: 'e1', role: 'user', text: 'hello' },
        { id: 'e2', role: 'user', text: 'hello', requestId: 'x' },
        { id: 'e3', role: 'user', text: 'hello' },
      ],
    };
    // One message without an ID had the text when it was sent: the next one is this.
    const baseline = userMessagesWithText({ messages: view.messages.slice(0, 2) }, 'hello');
    expect(baseline).toBe(1);
    const result = reconcile([sent('r', 'hello', baseline)], view);
    expect(result[0]).toMatchObject({ state: 'confirmed', matchedId: 'e3' });
  });

  it('leaves the array alone when nothing matched, and failed messages unmatched', () => {
    const waiting = [sent('a', 'nothing like it')];
    expect(reconcile(waiting, transcript)).toBe(waiting);
    const failed: PendingMessage[] = [{ ...sent('f', 'List the files'), state: 'failed' }];
    expect(reconcile(failed, transcript)).toBe(failed);
  });
});

describe('what the platform records about messages', () => {
  const recorded: ChatView = {
    busy: false,
    tools: [],
    messages: [
      { id: 'u1', role: 'user', text: 'What time is it?', at: 1_000 },
      {
        id: 'a1',
        role: 'assistant',
        text: '',
        at: 2_000,
        model: { provider: 'omg', id: 'gpt-oss-120b' },
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
        stopReason: 'toolUse',
        toolCalls: [
          { id: 'c1', name: 'get_time', arguments: {}, startedAt: 2_500, endedAt: 4_800 },
        ],
      },
      {
        id: 't1',
        role: 'tool',
        toolCallId: 'c1',
        name: 'get_time',
        text: '3:31 PM',
        isError: false,
        at: 4_800,
      },
      {
        id: 'a2',
        role: 'assistant',
        text: 'It is 3:31 PM.',
        at: 5_000,
        model: { provider: 'omg', id: 'gpt-oss-120b' },
        usage: { input: 150, output: 30, cacheRead: 50, cacheWrite: 0, total: 230 },
        stopReason: 'stop',
      },
    ],
  };

  it('carries when a message was sent', () => {
    const [user] = viewToMessages(recorded);
    expect(user?.metadata).toEqual({ at: 1_000 });
  });

  it('adds up a reply’s steps: its start, the model that finished it, tokens, and why it ended', () => {
    const reply = viewToMessages(recorded)[1]!;
    expect(reply.metadata).toMatchObject({
      at: 2_000,
      model: 'gpt-oss-120b',
      stopReason: 'stop',
      usage: { input: 250, output: 50, cacheRead: 50, cacheWrite: 0, total: 350 },
    });
  });

  it('keeps a tool call’s timing with it, through its result arriving', () => {
    const reply = viewToMessages(recorded)[1]!;
    const tool = reply.parts.find((part) => part.type === 'dynamic-tool') as {
      state: string;
      toolMetadata?: { startedAt: number; endedAt: number };
    };
    expect(tool.state).toBe('output-available');
    expect(tool.toolMetadata).toEqual({ startedAt: 2_500, endedAt: 4_800 });
  });

  it('keeps a failed reply’s status beside what was recorded', () => {
    const failed: ChatView = {
      busy: false,
      tools: [],
      messages: [
        { id: 'u', role: 'user', text: 'hi' },
        {
          id: 'a',
          role: 'assistant',
          text: '',
          error: '429: Too Many Requests',
          at: 7,
          model: { provider: 'p', id: 'm' },
        },
      ],
    };
    expect(viewToMessages(failed)[1]?.metadata).toMatchObject({
      status: 'error',
      errorMessage: '429: Too Many Requests',
      at: 7,
      model: 'm',
    });
  });

  it('is unchanged for a platform that records nothing', () => {
    const plain: ChatView = {
      busy: false,
      tools: [],
      messages: [
        { id: 'u', role: 'user', text: 'hi' },
        { id: 'a', role: 'assistant', text: 'hello' },
      ],
    };
    const [user, reply] = viewToMessages(plain);
    expect(user?.metadata).toBeUndefined();
    expect(reply?.metadata).toEqual({});
  });
});
