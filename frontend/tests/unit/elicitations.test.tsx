// @vitest-environment happy-dom
import { QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Agent, type AgentThread, ApiError, type McpElicitation } from '../../src/api/client';
import { ElicitationCard, ElicitationList } from '../../src/components/chat/elicitation-card';
import { APPROVALS_KEY } from '../../src/hooks/use-approvals';
import { applyElicitationData, ELICITATIONS_KEY } from '../../src/hooks/use-elicitations';
import { useAttentionCount, useInbox } from '../../src/hooks/use-inbox';
import {
  applyElicitationEvent,
  confirmField,
  contentOf,
  elicitationsByThread,
  expiresLabel,
  initialValues,
} from '../../src/lib/elicitations';
import {
  buttonByText,
  click,
  fakeBackend,
  fieldByLabel,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
  typeInto,
} from './ui-test-utils';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }),
}));

const NOW = Date.now();

const MESSAGE =
  'Send this email?\nTo: ada@example.com\nSubject: Q3 numbers\n\n<b>Hi Ada</b>, here they are.';

function elicitation(overrides: Partial<McpElicitation> = {}): McpElicitation {
  return {
    id: 'el_1',
    agentId: 'ag_a',
    agentName: 'Assistant',
    threadId: 't1',
    server: 'm365',
    serverName: 'Microsoft 365',
    tool: 'send_draft',
    message: MESSAGE,
    requestedSchema: {
      type: 'object',
      properties: {
        send: {
          type: 'boolean',
          title: 'Yes, go ahead',
          description: 'Sends the email now.',
          default: false,
        },
      },
      required: ['send'],
    },
    state: 'pending',
    createdAt: NOW,
    expiresAt: NOW + 15 * 60_000,
    ...overrides,
  };
}

const MIXED: McpElicitation['requestedSchema'] = {
  type: 'object',
  properties: {
    priority: {
      type: 'string',
      title: 'Priority',
      enum: ['low', 'high'],
      enumNames: ['Low', 'High'],
    },
    count: { type: 'integer', title: 'How many', minimum: 1, maximum: 10 },
    notify: { type: 'boolean', title: 'Notify the team', default: true },
    note: { type: 'string', title: 'Note' },
  },
  required: ['priority', 'count'],
};

const ANSWER = '/api/elicitations/el_1';
const posts = (backend: ReturnType<typeof fakeBackend>) =>
  backend.calls.filter((call) => call.method === 'POST' && call.path === ANSWER);

/** Chooses an option of a <select> the way React hears it. */
async function choose(element: Element | null, value: string) {
  if (!(element instanceof HTMLSelectElement)) throw new Error('Not a select');
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

describe('The elicitation card: a lone yes-or-no field', () => {
  it('is one button titled by the field, and sends accept with it true', async () => {
    const backend = fakeBackend({
      [`POST ${ANSWER}`]: () => elicitation({ state: 'accepted' }),
    });
    view = await renderWithQuery(<ElicitationCard elicitation={elicitation()} />);

    expect(document.body.textContent).toContain('Microsoft 365 asks');
    expect(document.body.textContent).toContain('while running send_draft');
    expect(document.body.textContent).toContain('Expires in 15 min');
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(buttonByText('Accept')).toBeUndefined();
    expect(buttonByText('Cancel')).toBeUndefined();
    // The server's words, as text: never HTML.
    const message = document.querySelector('section[aria-label="Microsoft 365\'s message"]');
    expect(message?.textContent).toBe(MESSAGE);
    expect(message?.querySelector('b')).toBeNull();

    await click(buttonByText('Yes, go ahead'));
    expect(posts(backend).map((call) => call.body)).toEqual([
      { action: 'accept', content: { send: true } },
    ]);
    expect(document.body.textContent).toContain('Sent your answer');
    expect(buttonByText('Yes, go ahead')).toBeUndefined();
  });

  it('sends decline with Decline', async () => {
    const backend = fakeBackend({
      [`POST ${ANSWER}`]: () => elicitation({ state: 'declined' }),
    });
    view = await renderWithQuery(<ElicitationCard elicitation={elicitation()} />);
    await click(buttonByText('Decline'));
    expect(posts(backend).map((call) => call.body)).toEqual([{ action: 'decline' }]);
    expect(document.body.textContent).toContain('Declined');
  });

  it('says "Already answered or expired" on 409', async () => {
    fakeBackend({
      [`POST ${ANSWER}`]: () => {
        throw new ApiError(409, 'not_pending', 'This question was already answered or expired.');
      },
    });
    view = await renderWithQuery(<ElicitationCard elicitation={elicitation()} />);
    await click(buttonByText('Yes, go ahead'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Already answered or expired',
    );
    expect(buttonByText('Yes, go ahead')).toBeUndefined();
  });
});

describe('The elicitation card: a form', () => {
  it('renders each field by type and sends typed content; required fields hold Accept', async () => {
    const backend = fakeBackend({
      [`POST ${ANSWER}`]: () => elicitation({ state: 'accepted', requestedSchema: MIXED }),
    });
    view = await renderWithQuery(
      <ElicitationCard elicitation={elicitation({ requestedSchema: MIXED, tool: null })} />,
    );
    expect(document.body.textContent).toContain('Microsoft 365 asks');
    expect(document.body.textContent).not.toContain('while running');

    const priority = fieldByLabel('Priority') as HTMLSelectElement;
    expect(priority.tagName).toBe('SELECT');
    expect([...priority.options].map((option) => option.textContent)).toEqual([
      'Choose…',
      'Low',
      'High',
    ]);
    const count = fieldByLabel('How many') as HTMLInputElement;
    expect(count.type).toBe('number');
    expect(count.min).toBe('1');
    expect(count.max).toBe('10');
    const notify = fieldByLabel('Notify the team') as HTMLInputElement;
    expect(notify.type).toBe('checkbox');
    expect(notify.checked).toBe(true);
    expect(fieldByLabel('Note')?.tagName).toBe('INPUT');
    // Required fields are marked.
    expect(document.querySelector(`label[for="${priority.id}"]`)?.textContent).toContain(
      '(required)',
    );
    const note = fieldByLabel('Note') as HTMLInputElement;
    expect(document.querySelector(`label[for="${note.id}"]`)?.textContent).toBe('Note');

    const accept = buttonByText('Accept');
    expect(accept?.disabled).toBe(true);
    await choose(priority, 'high');
    expect(buttonByText('Accept')?.disabled).toBe(true);
    await typeInto(count, '3');
    expect(buttonByText('Accept')?.disabled).toBe(false);

    await click(buttonByText('Accept'));
    expect(posts(backend).map((call) => call.body)).toEqual([
      { action: 'accept', content: { priority: 'high', count: 3, notify: true } },
    ]);
    expect(document.body.textContent).toContain('Sent your answer');
  });

  it('says why a value is refused, and sends Cancel without content', async () => {
    const backend = fakeBackend({
      [`POST ${ANSWER}`]: () => elicitation({ state: 'cancelled' }),
    });
    view = await renderWithQuery(
      <ElicitationCard elicitation={elicitation({ requestedSchema: MIXED })} />,
    );
    await choose(fieldByLabel('Priority'), 'low');
    await typeInto(fieldByLabel('How many'), '40');
    await click(buttonByText('Accept'));
    expect(document.body.textContent).toContain('At most 10.');
    expect(posts(backend)).toHaveLength(0);

    await click(buttonByText('Cancel'));
    expect(posts(backend).map((call) => call.body)).toEqual([{ action: 'cancel' }]);
    expect(document.body.textContent).toContain('Cancelled');
  });

  it('keeps an answered card a moment in a list after it leaves the pending list', async () => {
    fakeBackend({ [`POST ${ANSWER}`]: () => elicitation({ state: 'declined' }) });
    view = await renderWithQuery(<ElicitationList elicitations={[elicitation()]} />);
    await click(buttonByText('Decline'));
    // The list given no longer has it (the answer took it out); the card says how it ended.
    await act(async () =>
      view!.root.render(
        <QueryClientProvider client={view!.queryClient}>
          <ElicitationList elicitations={[]} />
        </QueryClientProvider>,
      ),
    );
    await settle();
    expect(document.body.textContent).toContain('Declined');
  });
});

describe('An answer that the event beats', () => {
  it('does not ask again when the question leaves the list before the answer returns', async () => {
    let release: (value: unknown) => void = () => {};
    fakeBackend({ [`POST ${ANSWER}`]: () => new Promise((resolve) => (release = resolve)) });
    view = await renderWithQuery(<ElicitationList elicitations={[elicitation()]} />);
    await click(buttonByText('Yes, go ahead'));
    // The `elicitation` event (accepted) arrives first and drops it from the pending list…
    await act(async () =>
      view!.root.render(
        <QueryClientProvider client={view!.queryClient}>
          <ElicitationList elicitations={[]} />
        </QueryClientProvider>,
      ),
    );
    // …then the answer returns.
    await act(async () => release(elicitation({ state: 'accepted' })));
    await settle();
    expect(document.body.textContent).toContain('Sent your answer');
    expect(buttonByText('Yes, go ahead')).toBeUndefined();
  });
});

describe('The pending list', () => {
  it('drops one when an `elicitation` event says it is no longer pending', async () => {
    fakeBackend();
    view = await renderWithQuery(<div />);
    const { queryClient } = view;
    const first = elicitation();
    const second = elicitation({ id: 'el_2', threadId: 't2', createdAt: NOW + 1 });
    queryClient.setQueryData(ELICITATIONS_KEY, [first, second]);

    const answered = applyElicitationData(
      queryClient,
      JSON.stringify({ ...first, state: 'accepted' }),
    );
    expect(answered?.isNew).toBe(false);
    expect(queryClient.getQueryData<McpElicitation[]>(ELICITATIONS_KEY)?.map((e) => e.id)).toEqual([
      'el_2',
    ]);

    for (const state of ['declined', 'cancelled', 'expired'] as const)
      expect(applyElicitationEvent([second], { ...second, state })).toEqual([]);

    const asked = applyElicitationData(
      queryClient,
      JSON.stringify(elicitation({ id: 'el_3', createdAt: NOW + 2 })),
    );
    expect(asked?.isNew).toBe(true);
    expect(queryClient.getQueryData<McpElicitation[]>(ELICITATIONS_KEY)?.map((e) => e.id)).toEqual([
      'el_2',
      'el_3',
    ]);

    expect(applyElicitationData(queryClient, 'not json')).toBeNull();
  });

  it('groups pending ones by conversation, oldest first', () => {
    const map = elicitationsByThread([
      elicitation({ id: 'el_2', createdAt: NOW + 5 }),
      elicitation({ id: 'el_1' }),
      elicitation({ id: 'el_3', threadId: null }),
    ]);
    expect([...map.keys()]).toEqual(['ag_a/t1']);
    expect(map.get('ag_a/t1')?.map((e) => e.id)).toEqual(['el_1', 'el_2']);
  });
});

describe('The form rules', () => {
  it('knows the confirm pattern, defaults and typed content', () => {
    expect(confirmField(elicitation().requestedSchema)).toBe('send');
    expect(confirmField(MIXED)).toBeNull();
    expect(initialValues(MIXED)).toEqual({ priority: '', count: '', notify: true, note: '' });
    expect(
      contentOf(MIXED, { priority: 'low', count: '2.5', notify: false, note: 'hi' }).errors,
    ).toEqual({ count: 'Enter a whole number.' });
    expect(contentOf(MIXED, { priority: '', count: '', notify: false, note: '' }).errors).toEqual({
      priority: 'Required.',
      count: 'Required.',
    });
    expect(expiresLabel(NOW + 14 * 60_000, NOW)).toBe('Expires in 14 min');
    expect(expiresLabel(NOW - 1, NOW)).toBe('Expired');
  });
});

// ── The inbox ───────────────────────────────────────────────────────────────────────────────

const agent: Agent = {
  id: 'ag_a',
  name: 'Assistant',
  description: '',
  instructions: '',
  kind: 'personal',
  agentKind: 'assistant',
  status: 'asleep',
  running: false,
  model: null,
  enabled: true,
  lastUsedAt: null,
  revision: 1,
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
  kindSettings: {},
  canCall: [],
  callable: [],
  dir: '/tmp/ag_a',
  piDurableVersion: null,
};

const thread = (threadId: string): AgentThread => ({
  threadId,
  title: threadId,
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
  busy: true,
  visibility: 'shared',
  participants: [],
});

function InboxProbe() {
  const inbox = useInbox();
  const attention = useAttentionCount();
  return (
    <output>
      {JSON.stringify({
        needsYou: inbox.sections.approval.map((entry) => [entry.key, entry.status]),
        attention,
      })}
    </output>
  );
}

describe('The inbox', () => {
  it('counts a conversation with a pending elicitation as "Needs you"', async () => {
    localStorage.clear();
    fakeBackend({
      'GET /api/agents': () => [agent],
      'GET /api/agents/ag_a/threads': () => [thread('t1'), thread('t2')],
      'GET /api/approvals?status=pending': () => [],
      'GET /api/elicitations': () => [elicitation(), elicitation({ id: 'el_9', threadId: null })],
    });
    view = await renderWithQuery(<InboxProbe />);
    await settle();
    const read = () => JSON.parse(document.querySelector('output')?.textContent ?? '{}');
    // In "Needs you", saying "Asks you" rather than "Needs approval".
    expect(read()).toEqual({ needsYou: [['ag_a/t1', 'asks']], attention: 2 });

    // Answered: it goes back to where it was.
    await act(async () => {
      view!.queryClient.setQueryData(ELICITATIONS_KEY, []);
      view!.queryClient.setQueryData(APPROVALS_KEY, []);
    });
    await settle();
    expect(read()).toEqual({ needsYou: [], attention: 0 });
  });
});
