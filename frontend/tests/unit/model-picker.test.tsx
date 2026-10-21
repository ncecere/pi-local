// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Agent, type AgentThread, ApiError, type CatalogModel } from '../../src/api/client';
import { writeHandover } from '../../src/hooks/use-agent-thread';
import { ChatHomePage } from '../../src/routes/chat/home';
import { ChatThreadPage } from '../../src/routes/chat/thread';
import { agent } from './memory-fixtures';
import {
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
  typeInto,
} from './ui-test-utils';

const navigate = vi.fn(async (_options: unknown) => undefined);
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const QUICK = { id: 'acme/quick', name: 'Quick', provider: 'acme' };
const REX: Agent = agent({ model: QUICK });

const MODELS: CatalogModel[] = [
  { id: 'demo/demo-1', name: 'Demo', provider: 'demo', providerName: 'Demo', reasoning: false },
  { id: 'acme/quick', name: 'Quick', provider: 'acme', providerName: 'Acme', reasoning: false },
  { id: 'acme/strong', name: 'Strong', provider: 'acme', providerName: 'Acme', reasoning: true },
  { id: 'acme/old', name: 'Old', provider: 'acme', providerName: 'Acme', enabled: false },
  { id: 'lab/plain', name: 'Plain', provider: 'lab', providerName: 'Lab', reasoning: false },
];

const thread = (change: Partial<AgentThread> = {}): AgentThread => ({
  threadId: 't1',
  title: 'Trip to Lisbon',
  createdAt: 1,
  updatedAt: 1,
  busy: false,
  visibility: 'private',
  participants: [],
  modelId: '',
  thinking: '',
  ...change,
});

const MESSAGES = '/api/agents/ag_rex/threads/t1/messages';

let view: Rendered | undefined;
beforeEach(() => {
  navigate.mockClear();
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

/** The conversation's event stream: an empty transcript, then quiet until the page leaves. */
const emptyTranscript = async (
  _path: string,
  onEvent: (event: { event: string; data: string }) => void,
  signal: AbortSignal,
) => {
  onEvent({ event: 'view', data: JSON.stringify({ busy: false, messages: [], tools: [] }) });
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
};

function routes(extra: Record<string, (body: unknown) => unknown> = {}) {
  return {
    'GET /api/agents': () => [REX],
    'GET /api/teams': () => [],
    'GET /api/agents/catalog': () => ({
      templates: [],
      models: MODELS,
      defaultModelId: 'acme/quick',
      allowModelChoice: true,
      limit: 1000,
      used: 1,
    }),
    'GET /api/agents/ag_rex/threads': () => [thread()],
    'GET /api/elicitations': () => [],
    'GET /api/approvals?status=pending': () => [],
    [`POST ${MESSAGES}`]: () => ({ submissionId: 's1' }),
    ...extra,
  };
}

async function showThread(features: { modelPerConversation?: boolean }, extra = {}) {
  const backend = fakeBackend(routes(extra), emptyTranscript);
  view = await renderWithQuery(<ChatThreadPage agentId="ag_rex" threadId="t1" />, { features });
  await settle();
  return backend;
}

const trigger = () =>
  document.querySelector<HTMLElement>('button[aria-label^="Model for this conversation"]');
const label = () => trigger()?.textContent?.trim();
const items = () => [...document.querySelectorAll('[role="menuitemradio"]')];
const item = (text: string) => items().find((candidate) => candidate.textContent?.trim() === text);
const menuText = () => document.querySelector('[role="menu"]')?.textContent ?? '';

async function openMenu() {
  await act(async () => {
    trigger()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await settle();
}

/** Picks one item of the menu (which closes it). */
async function choose(text: string) {
  await openMenu();
  await click(item(text));
}

async function send(text: string) {
  await typeInto(document.querySelector('textarea[aria-label="Message input"]'), text);
  await click(document.querySelector('button[aria-label="Send message"]'));
  await settle();
}

const posts = (backend: ReturnType<typeof fakeBackend>, path = MESSAGES) =>
  backend.calls.filter((call) => call.method === 'POST' && call.path === path);

describe('The model picker', () => {
  it('is not there while the feature is off', async () => {
    await showThread({ modelPerConversation: false });
    expect(document.querySelector('textarea[aria-label="Message input"]')).not.toBeNull();
    expect(trigger()).toBeNull();
  });

  it("shows the agent's model first, then the enabled models by provider, never the demo one", async () => {
    await showThread({ modelPerConversation: true });
    expect(trigger()?.getAttribute('title')).toBe('Model for this conversation');
    expect(label()).toBe('Quick');

    await openMenu();
    expect(items().map((candidate) => candidate.textContent?.trim())).toEqual([
      "Agent's model (Quick)",
      'Quick',
      'Strong',
      'Plain',
    ]);
    expect(menuText()).toContain('Acme');
    expect(menuText()).toContain('Lab');
    expect(menuText()).not.toContain('Demo');
    expect(menuText()).not.toContain('Old');
    expect(item("Agent's model (Quick)")?.getAttribute('aria-checked')).toBe('true');
  });

  it('offers thinking only for a model that can think', async () => {
    await showThread({ modelPerConversation: true });

    // The agent's model and a plain one can't think.
    await openMenu();
    expect(menuText()).not.toContain('Thinking');
    await click(item('Plain'));
    expect(label()).toBe('Plain');
    await openMenu();
    expect(menuText()).not.toContain('Thinking');
    await click(item('Strong'));

    // A reasoning one can, and Off is where it starts.
    expect(label()).toBe('Strong');
    await openMenu();
    expect(menuText()).toContain('Thinking');
    expect(items().map((candidate) => candidate.textContent?.trim())).toEqual(
      expect.arrayContaining(['Off', 'Low', 'Medium', 'High']),
    );
    expect(item('Off')?.getAttribute('aria-checked')).toBe('true');
    await click(item('High'));
    expect(label()).toBe('Strong · high');

    // Back to a model that can't think: its level goes.
    await choose('Plain');
    expect(label()).toBe('Plain');
  });

  it('sends the model and thinking only after they were changed, and only once', async () => {
    const backend = await showThread({ modelPerConversation: true });

    // Nothing changed: the message leaves them out, so the conversation keeps what it had.
    await send('First');
    expect(posts(backend)).toHaveLength(1);
    expect(posts(backend)[0]?.body).toEqual({ text: 'First', requestId: expect.any(String) });

    await choose('Strong');
    await choose('High');
    expect(label()).toBe('Strong · high');
    await send('Second');
    expect(posts(backend)[1]?.body).toEqual({
      text: 'Second',
      requestId: expect.any(String),
      modelId: 'acme/strong',
      thinking: 'high',
    });

    // The conversation has them now: the next message leaves them out again.
    expect(label()).toBe('Strong · high');
    await send('Third');
    expect(posts(backend)[2]?.body).toEqual({ text: 'Third', requestId: expect.any(String) });

    // Only what changed goes: here the thinking.
    await choose('Low');
    await send('Fourth');
    expect(posts(backend)[3]?.body).toEqual({
      text: 'Fourth',
      requestId: expect.any(String),
      thinking: 'low',
    });

    // Back to the agent's model: "" says so.
    await choose("Agent's model (Quick)");
    await send('Fifth');
    expect(posts(backend)[4]?.body).toMatchObject({ modelId: '' });
  });

  it("starts from the conversation's own choice", async () => {
    fakeBackend(
      routes({
        'GET /api/agents/ag_rex/threads': () => [
          thread({ modelId: 'acme/strong', thinking: 'medium' }),
        ],
      }),
      emptyTranscript,
    );
    view = await renderWithQuery(<ChatThreadPage agentId="ag_rex" threadId="t1" />, {
      features: { modelPerConversation: true },
    });
    await settle();
    expect(label()).toBe('Strong · medium');
    await openMenu();
    expect(item('Medium')?.getAttribute('aria-checked')).toBe('true');
  });

  it("shows the server's message when it refuses the model", async () => {
    await showThread(
      { modelPerConversation: true },
      {
        [`POST ${MESSAGES}`]: () => {
          throw new ApiError(400, 'invalid_model', 'Strong is turned off. Choose another model.');
        },
      },
    );
    await choose('Strong');
    await send('Hello');
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Strong is turned off. Choose another model.');
    // The message is back in the box, and the choice stays for another try.
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Hello');
    expect(label()).toBe('Strong');
  });
});

describe('The model picker in a new chat', () => {
  const handover = () => JSON.parse(sessionStorage.getItem('pai.handover') ?? 'null');

  async function showHome(features: { modelPerConversation?: boolean }) {
    const backend = fakeBackend(routes());
    view = await renderWithQuery(<ChatHomePage agentId="ag_rex" />, { features });
    await settle();
    return backend;
  }

  it('is not there while the feature is off', async () => {
    await showHome({ modelPerConversation: false });
    expect(trigger()).toBeNull();
  });

  it('hands the choice over with the first message', async () => {
    await showHome({ modelPerConversation: true });
    expect(label()).toBe('Quick');
    await choose('Strong');
    await choose('High');
    await send('Plan a weekend in Lisbon');
    expect(handover()).toMatchObject({
      agentId: 'ag_rex',
      text: 'Plan a weekend in Lisbon',
      modelId: 'acme/strong',
      thinking: 'high',
    });
  });

  it('hands over nothing when the choice was left alone', async () => {
    await showHome({ modelPerConversation: true });
    await send('Plan a weekend in Lisbon');
    const written = handover();
    expect(written.text).toBe('Plan a weekend in Lisbon');
    expect(written).not.toHaveProperty('modelId');
    expect(written).not.toHaveProperty('thinking');
  });

  it("is sent with the conversation's first message, and not with the next", async () => {
    sessionStorage.clear();
    writeHandover({
      agentId: 'ag_rex',
      threadId: 't9',
      text: 'Plan a weekend in Lisbon',
      requestId: 'req-1',
      focus: false,
      modelId: 'acme/strong',
      thinking: 'high',
    });
    const path = '/api/agents/ag_rex/threads/t9/messages';
    const backend = fakeBackend(
      routes({ [`POST ${path}`]: () => ({ submissionId: 's1' }) }),
      emptyTranscript,
    );
    view = await renderWithQuery(<ChatThreadPage agentId="ag_rex" threadId="t9" />, {
      features: { modelPerConversation: true },
    });
    await settle();

    expect(posts(backend, path)[0]?.body).toEqual({
      text: 'Plan a weekend in Lisbon',
      requestId: 'req-1',
      modelId: 'acme/strong',
      thinking: 'high',
    });
    expect(label()).toBe('Strong · high');

    await typeInto(document.querySelector('textarea[aria-label="Message input"]'), 'And Porto?');
    await click(document.querySelector('button[aria-label="Send message"]'));
    await settle();
    expect(posts(backend, path)[1]?.body).toEqual({
      text: 'And Porto?',
      requestId: expect.any(String),
    });
  });
});
