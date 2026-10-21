// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry, ActivityPage, ChatMessage } from '../../src/api/client';
import { WhatHappened } from '../../src/components/chat/what-happened';
import {
  activityQuery,
  approvalNote,
  argumentsLine,
  entryLine,
  formatDuration,
} from '../../src/lib/activity';
import { buildTimeline, timelineSummary } from '../../src/lib/what-happened';
import {
  buttonByText,
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => (
    <a href={Object.entries(params ?? {}).reduce((href, [k, v]) => href.replace(`$${k}`, v), to)}>
      {children}
    </a>
  ),
}));

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const T0 = Date.UTC(2026, 9, 21, 14, 0, 0);

let nextId = 1;
const logged = (change: Partial<ActivityEntry>): ActivityEntry => ({
  id: nextId++,
  at: T0,
  kind: 'tool',
  agentId: 'ag_a',
  agentName: 'Hardac',
  threadId: 't1',
  actor: 'Hardac',
  title: 'bash',
  outcome: 'ok',
  durationMs: null,
  detail: {},
  ...change,
});

const messages: ChatMessage[] = [
  {
    id: 'e1',
    role: 'user',
    text: 'tidy the notes',
    at: T0,
    author: { kind: 'user', id: 'local', name: 'Ann' },
  },
  {
    id: 'e2',
    role: 'assistant',
    text: '',
    at: T0 + 500,
    toolCalls: [
      {
        id: 'c1',
        name: 'bash',
        arguments: { command: 'ls notes' },
        startedAt: T0 + 1000,
        endedAt: T0 + 3500,
      },
    ],
  },
  {
    id: 'e3',
    role: 'tool',
    toolCallId: 'c1',
    name: 'bash',
    text: 'a.md',
    isError: false,
    at: T0 + 3500,
  },
  {
    id: 'e4',
    role: 'assistant',
    text: '',
    at: T0 + 3600,
    toolCalls: [
      {
        id: 'c2',
        name: 'write',
        arguments: { path: 'notes.md', content: 'x' },
        startedAt: T0 + 4000,
        endedAt: T0 + 16_000,
        approval: {
          id: 'ap_1',
          callId: 'c2',
          tool: 'write',
          status: 'denied',
          requestedAt: T0 + 4000,
          decidedAt: T0 + 16_000,
          decidedBy: { kind: 'user', name: 'Ann' },
          reason: 'not today',
        },
      },
    ],
  },
  {
    id: 'e5',
    role: 'tool',
    toolCallId: 'c2',
    name: 'write',
    text: 'Tool call blocked: denied by Ann',
    isError: true,
    at: T0 + 16_000,
  },
  { id: 'e6', role: 'assistant', text: 'I left the notes as they were.', at: T0 + 17_000 },
];

const log: ActivityEntry[] = [
  logged({
    title: 'bash',
    outcome: 'ok',
    durationMs: 2400,
    at: T0 + 3400,
    detail: { callId: 'c1', arguments: { command: 'ls notes' } },
  }),
  logged({
    title: 'write',
    outcome: 'denied',
    at: T0 + 16_000,
    detail: {
      callId: 'c2',
      arguments: { path: 'notes.md' },
      error: 'Tool call blocked: denied by Ann',
      approval: { status: 'denied', by: 'Ann', waitedMs: 12_000, reason: 'not today' },
    },
  }),
  logged({
    kind: 'approval',
    title: 'Denied write',
    outcome: 'denied',
    at: T0 + 16_000,
    durationMs: 12_000,
  }),
  logged({
    kind: 'budget',
    title: 'Hardac reached its $5 budget for October. Raise it in its settings.',
    outcome: 'refused',
    at: T0 + 30_000,
    detail: { via: 'message' },
  }),
  logged({
    kind: 'ask',
    title: 'Asked Helper',
    at: T0 + 20_000,
    durationMs: 8000,
    detail: { targetAgentId: 'ag_h', targetThread: 'ask-1', preview: 'Any news?' },
  }),
];

describe('the timeline of a conversation', () => {
  it('lists the messages, calls and replies in order, with what the log says of each call', () => {
    const steps = buildTimeline(messages, log);
    expect(steps.map((step) => [step.kind, step.title])).toEqual([
      ['message', 'You sent a message'],
      ['tool', 'bash'],
      ['tool', 'write'],
      ['reply', 'Replied'],
      ['ask', 'Asked Helper'],
      ['budget', 'Hardac reached its $5 budget for October. Raise it in its settings.'],
    ]);
    const [, ran, refused, reply, ask, budget] = steps;
    // The call's start comes from the view, its run time from the log (the span of the view includes the wait).
    expect(ran).toMatchObject({ at: T0 + 1000, line: 'ls notes', outcome: 'ok', durationMs: 2400 });
    expect(ran!.note).toBeUndefined();
    expect(refused).toMatchObject({ at: T0 + 4000, outcome: 'denied' });
    expect(refused!.durationMs).toBeUndefined();
    expect(refused!.note).toBe('Denied by Ann after 12 s: not today');
    expect(reply).toMatchObject({ at: T0 + 17_000, line: 'I left the notes as they were.' });
    expect(ask).toMatchObject({
      outcome: 'ok',
      durationMs: 8000,
      link: { agentId: 'ag_h', threadId: 'ask-1' },
    });
    expect(budget).toMatchObject({ outcome: 'refused' });
    // The approval is told with its call, not again.
    expect(steps.some((step) => step.kind === 'approval')).toBe(false);
  });

  it('works from the view alone: a finished call is done, a blocked one denied, a waiting one waits', () => {
    const steps = buildTimeline(messages, []);
    expect(steps.map((step) => step.outcome)).toEqual([undefined, 'ok', 'denied', undefined]);
    expect(steps[1]).toMatchObject({ durationMs: 2500 });
    expect(steps[2]!.note).toBe('Denied by Ann after 12 s: not today');

    const waiting = buildTimeline(
      [
        {
          id: 'e1',
          role: 'assistant',
          text: '',
          at: T0,
          toolCalls: [
            {
              id: 'c9',
              name: 'bash',
              arguments: { command: 'rm -rf x' },
              startedAt: T0,
              approval: {
                id: 'ap_9',
                callId: 'c9',
                tool: 'bash',
                status: 'pending',
                requestedAt: T0,
              },
            },
            { id: 'c10', name: 'read', arguments: { path: 'a' }, startedAt: T0 },
          ],
        },
      ],
      [],
    );
    expect(waiting.map((step) => step.outcome)).toEqual(['waiting', 'running']);
  });

  it("adds what earlier pages hold from the log, and doesn't repeat the messages it can see", () => {
    const earlier = [
      logged({
        title: 'read',
        at: T0 - 60_000,
        durationMs: 30,
        detail: { callId: 'c0', arguments: { path: 'old.md' } },
      }),
      logged({
        kind: 'message',
        title: 'Message sent',
        actor: 'Ann',
        at: T0 - 61_000,
        detail: { preview: 'start here' },
      }),
      logged({
        kind: 'message',
        title: 'Message sent',
        actor: 'Ann',
        at: T0,
        detail: { preview: 'tidy the notes' },
      }),
    ];
    const steps = buildTimeline(messages, [...log, ...earlier], { hasEarlier: true });
    expect(steps.slice(0, 2).map((step) => [step.title, step.line])).toEqual([
      ['Ann sent a message', 'start here'],
      ['read', 'old.md'],
    ]);
    expect(steps.filter((step) => step.kind === 'message')).toHaveLength(2);
  });

  it('matches a repeated call ID to each call in turn, and shows a failed reply once', () => {
    const twice: ChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        text: '',
        at: T0,
        toolCalls: [{ id: 'c1', name: 'get_time', arguments: {}, startedAt: T0, endedAt: T0 + 5 }],
      },
      {
        id: 'a2',
        role: 'assistant',
        text: '',
        at: T0 + 100,
        toolCalls: [
          { id: 'c1', name: 'get_time', arguments: {}, startedAt: T0 + 100, endedAt: T0 + 105 },
        ],
      },
      { id: 'a3', role: 'assistant', text: '', at: T0 + 200, error: 'The model request failed' },
    ];
    const calls = [
      logged({
        title: 'get_time',
        outcome: 'ok',
        durationMs: 4,
        at: T0 + 5,
        detail: { callId: 'c1' },
      }),
      logged({
        title: 'get_time',
        outcome: 'error',
        durationMs: 9,
        at: T0 + 105,
        detail: { callId: 'c1', error: 'boom' },
      }),
      logged({
        kind: 'error',
        title: 'A reply failed',
        outcome: 'error',
        at: T0 + 200,
        detail: { error: 'The model request failed' },
      }),
    ];
    const steps = buildTimeline(twice, calls);
    expect(
      steps.filter((step) => step.kind === 'tool').map((step) => [step.outcome, step.durationMs]),
    ).toEqual([
      ['ok', 4],
      ['error', 9],
    ]);
    expect(steps.filter((step) => step.kind === 'error')).toHaveLength(1);
  });

  it('says in a line how it went', () => {
    expect(timelineSummary(buildTimeline(messages, log))).toBe(
      '6 steps · 1 denied · 1 refused · 30 s from first to last',
    );
    expect(timelineSummary([])).toBe('0 steps');
  });
});

describe('the words of the log', () => {
  it('writes durations, arguments, approvals and queries', () => {
    expect([0, 420, 1400, 38_000, 125_000, 3_600_000, 5_400_000].map(formatDuration)).toEqual([
      '0 ms',
      '420 ms',
      '1.4 s',
      '38 s',
      '2 min 5 s',
      '1 h',
      '1 h 30 min',
    ]);
    expect(argumentsLine({ command: 'git status', cwd: '/x' })).toBe('git status');
    expect(argumentsLine({ a: 1, b: 'two' })).toBe('a: 1, b: two');
    expect(argumentsLine({})).toBe('');
    expect(argumentsLine('nope')).toBe('');
    expect(approvalNote({ approval: { status: 'approved', by: 'Bo', waitedMs: 3000 } })).toBe(
      'Approved by Bo after 3 s',
    );
    expect(approvalNote({ approval: { status: 'timed_out', waitedMs: 86_400_000 } })).toBe(
      'Nobody decided after 24 h',
    );
    expect(approvalNote({})).toBe('');
    expect(entryLine(logged({ kind: 'ask', detail: { preview: 'Any news?' } }))).toBe(
      '“Any news?”',
    );
    expect(entryLine(logged({ kind: 'error', detail: { error: 'boom' } }))).toBe('boom');
    expect(
      activityQuery(
        { agent: 'ag_a', kind: ['tool', 'error'], outcome: ['denied'], q: ' rm ', since: 5 },
        { before: '9.1', limit: 50 },
      ),
    ).toBe('agent=ag_a&kind=tool%2Cerror&outcome=denied&q=rm&since=5&before=9.1&limit=50');
    expect(activityQuery({})).toBe('');
  });
});

describe('the What happened button', () => {
  it('opens a panel with the steps, the times and how long each took', async () => {
    const page: ActivityPage = { items: log, nextBefore: null };
    const backend = fakeBackend({ 'GET /api/activity?agent=ag_a&thread=t1&limit=500': () => page });
    view = await renderWithQuery(
      <WhatHappened
        agentId="ag_a"
        threadId="t1"
        messages={messages}
        hasEarlier={false}
        busy={false}
      />,
    );
    await settle();
    // Nothing is read until it is opened.
    expect(backend.calls).toEqual([]);
    expect(buttonByText('What happened')).toBeDefined();

    await click(buttonByText('What happened'));
    await settle();
    expect(backend.calls.map((call) => call.path)).toEqual([
      '/api/activity?agent=ag_a&thread=t1&limit=500',
    ]);
    const panel = document.querySelector('[role="dialog"]')!;
    expect(panel.textContent).toContain('What happened');
    const steps = [...panel.querySelectorAll('li[data-step-kind]')];
    expect(steps.map((step) => step.getAttribute('data-step-kind'))).toEqual([
      'message',
      'tool',
      'tool',
      'reply',
      'ask',
      'budget',
    ]);
    expect(steps[1]!.textContent).toContain('bash');
    expect(steps[1]!.textContent).toContain('ls notes');
    expect(steps[1]!.textContent).toContain('2.4 s');
    expect(steps[2]!.querySelector('[data-outcome="denied"]')?.textContent).toBe('Denied');
    expect(steps[2]!.textContent).toContain('Denied by Ann after 12 s');
    expect(steps[4]!.querySelector('a')?.getAttribute('href')).toBe('/agents/ag_h/threads/ask-1');
    expect(panel.querySelector('[data-timeline-summary]')?.textContent).toBe(
      '6 steps · 1 denied · 1 refused · 30 s from first to last',
    );
    for (const time of panel.querySelectorAll('time'))
      expect(time.getAttribute('datetime')).toMatch(/^2026-10-21T/);
  });

  it("still shows the conversation's own steps when the log cannot be read", async () => {
    fakeBackend({});
    view = await renderWithQuery(
      <WhatHappened
        agentId="ag_a"
        threadId="t1"
        messages={messages}
        hasEarlier={false}
        busy={false}
      />,
    );
    await click(buttonByText('What happened'));
    await settle();
    const panel = document.querySelector('[role="dialog"]')!;
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain(
      'These steps come from the conversation alone.',
    );
    expect(panel.querySelectorAll('li[data-step-kind]').length).toBe(4);
  });

  it('says so when nothing has happened yet', async () => {
    fakeBackend({
      'GET /api/activity?agent=ag_a&thread=t1&limit=500': () => ({ items: [], nextBefore: null }),
    });
    view = await renderWithQuery(
      <WhatHappened agentId="ag_a" threadId="t1" messages={[]} hasEarlier={false} busy={false} />,
    );
    await click(buttonByText('What happened'));
    await settle();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Nothing has happened in this conversation yet.',
    );
  });
});
