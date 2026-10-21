// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Agent, ApiError, type WebSettings } from '../../src/api/client';
import { AgentActions } from '../../src/components/agent-manager/agent-actions';
import { ToolsTab } from '../../src/components/agent-manager/tools-tab';
import { WebSearchSection } from '../../src/components/models/web-search-section';
import { useAgents } from '../../src/hooks/use-agents';
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

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'ag_rex',
    name: 'Rex',
    description: 'Finds papers',
    instructions: '',
    kind: 'personal',
    agentKind: 'assistant',
    status: 'asleep',
    running: false,
    model: null,
    enabled: true,
    lastUsedAt: null,
    revision: 3,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    kindSettings: {},
    canCall: [],
    callable: [],
    dir: '/data/agents/ag_rex',
    piDurableVersion: null,
    workspace: { tools: [], folder: '', dir: '/data/agents/ag_rex/workspace' },
    approvals: { tools: [], timeoutSeconds: 3600 },
    mcp: [],
    web: { search: false, fetch: true },
    ...overrides,
  };
}

const PROVIDERS: WebSettings['providers'] = [
  {
    id: 'brave',
    name: 'Brave Search',
    needsKey: true,
    needsUrl: false,
    signupUrl: 'https://brave.com/search/api/',
    note: 'An API key from the Brave Search API (it has a free plan).',
  },
  {
    id: 'tavily',
    name: 'Tavily',
    needsKey: true,
    needsUrl: false,
    signupUrl: 'https://app.tavily.com',
    note: 'An API key from Tavily.',
  },
  {
    id: 'serpapi',
    name: 'SerpApi',
    needsKey: true,
    needsUrl: false,
    signupUrl: 'https://serpapi.com/manage-api-key',
    note: 'An API key from SerpApi (Google results).',
  },
  {
    id: 'searxng',
    name: 'SearXNG',
    needsKey: false,
    needsUrl: true,
    signupUrl: 'https://docs.searxng.org',
    note: 'Your own SearXNG, with the JSON format turned on.',
  },
];

const settings = (change: Partial<WebSettings> = {}): WebSettings => ({
  provider: '',
  url: '',
  hasKey: false,
  providers: PROVIDERS,
  ...change,
});

let view: Rendered | undefined;
beforeEach(() => {
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const text = () => document.body.textContent ?? '';
const radio = (label: string) =>
  [...document.querySelectorAll('label')]
    .find((candidate) => candidate.textContent?.trim() === label)
    ?.querySelector('input[type="radio"]');
const switchFor = (label: string) => {
  const id = [...document.querySelectorAll('p')].find((p) => p.textContent === label)?.id;
  return document.querySelector(`[role="switch"][aria-labelledby="${id}"]`) as HTMLElement | null;
};

/** The tab as the agent page draws it: from the agents list, so a save draws it again. */
function ToolsHarness() {
  const { data } = useAgents();
  const current = data?.[0];
  return current ? <ToolsTab agent={current} /> : null;
}

describe('Tools tab: web', () => {
  it('saves each web switch as web, with the saved toast', async () => {
    let saved = agent();
    const backend = fakeBackend({
      'GET /api/agents': () => [saved],
      'GET /api/settings/web': () => settings({ provider: 'brave', hasKey: true }),
      'PATCH /api/agents/ag_rex': (body) => {
        saved = { ...saved, ...(body as Partial<Agent>), revision: saved.revision + 1 };
        return saved;
      },
    });
    view = await renderWithQuery(<ToolsHarness />);
    await settle();
    expect(text()).toContain('Uses the search service in Settings → Models.');
    expect(switchFor('Search the web')?.getAttribute('aria-checked')).toBe('false');
    expect(switchFor('Read web pages')?.getAttribute('aria-checked')).toBe('true');

    await click(switchFor('Search the web'));
    await settle();
    const patches = () => backend.calls.filter((call) => call.method === 'PATCH');
    expect(patches().map((call) => call.body)).toEqual([{ web: { search: true, fetch: true } }]);
    expect(toast).toHaveBeenCalledWith('Rex saved.');
    expect(switchFor('Search the web')?.getAttribute('aria-checked')).toBe('true');
    expect(text()).not.toContain('No search service is set up yet');

    await click(switchFor('Read web pages'));
    await settle();
    expect(patches().map((call) => call.body)[1]).toEqual({ web: { search: true, fetch: false } });
  });

  it('warns when search is on and no search service is set up', async () => {
    fakeBackend({
      'GET /api/agents': () => [agent({ web: { search: true, fetch: true } })],
      'GET /api/settings/web': () => settings(),
    });
    view = await renderWithQuery(<ToolsHarness />);
    await settle();
    expect(text()).toContain('No search service is set up yet, so its searches will fail.');
  });
});

describe('Settings → Models: web search', () => {
  it('saves a service with its key, then says a key is stored', async () => {
    let current = settings();
    const backend = fakeBackend({
      'GET /api/settings/web': () => current,
      'PUT /api/settings/web': () => {
        current = settings({ provider: 'brave', hasKey: true });
        return current;
      },
    });
    view = await renderWithQuery(<WebSearchSection />);
    await settle();
    expect((radio('Off') as HTMLInputElement).checked).toBe(true);
    expect(buttonByText('Test')?.disabled).toBe(true);

    await click(radio('Brave Search'));
    expect(text()).toContain('An API key from the Brave Search API (it has a free plan).');
    const getKey = [...document.querySelectorAll('a')].find((a) => a.textContent === 'Get a key');
    expect(getKey?.getAttribute('href')).toBe('https://brave.com/search/api/');
    const key = fieldByLabel('API key');
    expect(key?.getAttribute('type')).toBe('password');
    expect(buttonByText('Save')?.disabled).toBe(true);

    await typeInto(key, '  BSA-test  ');
    await click(buttonByText('Save'));
    expect(backend.calls.filter((call) => call.method === 'PUT')).toEqual([
      {
        method: 'PUT',
        path: '/api/settings/web',
        body: { provider: 'brave', url: '', apiKey: 'BSA-test' },
      },
    ]);
    expect(toast).toHaveBeenCalledWith('Web search saved.');
    expect(text()).toContain('A key is stored. Leave this empty to keep it.');
    expect((fieldByLabel('API key') as HTMLInputElement).value).toBe('');
    expect(buttonByText('Test')?.disabled).toBe(false);
  });

  it('needs an address for SearXNG, and offers a custom one for the others', async () => {
    const backend = fakeBackend({
      'GET /api/settings/web': () => settings({ provider: 'brave', hasKey: true }),
      'PUT /api/settings/web': () => settings({ provider: 'searxng', url: 'https://s.example' }),
    });
    view = await renderWithQuery(<WebSearchSection />);
    await settle();
    expect(fieldByLabel('Address')).toBeNull();
    await click(buttonByText('Custom address'));
    expect(fieldByLabel('Address (optional)')).not.toBeNull();

    await click(radio('SearXNG'));
    expect(fieldByLabel('API key')).toBeNull();
    expect(buttonByText('Save')?.disabled).toBe(true);
    await typeInto(fieldByLabel('Address'), 'https://s.example');
    await click(buttonByText('Save'));
    expect(backend.calls.find((call) => call.method === 'PUT')?.body).toEqual({
      provider: 'searxng',
      url: 'https://s.example',
    });
  });

  it('runs a test search and shows the first results', async () => {
    const backend = fakeBackend({
      'GET /api/settings/web': () => settings({ provider: 'brave', hasKey: true }),
      'POST /api/settings/web/test': () => ({
        results: [
          { title: 'Pi Local', url: 'https://example.com/pi', snippet: 'Agents on your Mac.' },
          { title: 'Second', url: 'https://example.com/2', snippet: '' },
        ],
      }),
    });
    view = await renderWithQuery(<WebSearchSection />);
    await settle();
    await click(buttonByText('Test'));
    expect(backend.calls.filter((call) => call.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/settings/web/test', body: {} },
    ]);
    const results = document.querySelector('[aria-label="Test results"]');
    expect(results?.textContent).toContain('It works. The first results:');
    const links = [...(results?.querySelectorAll('a') ?? [])].map((a) => [
      a.textContent,
      a.getAttribute('href'),
    ]);
    expect(links).toEqual([
      ['Pi Local', 'https://example.com/pi'],
      ['Second', 'https://example.com/2'],
    ]);
    expect(results?.textContent).toContain('Agents on your Mac.');
  });

  it('shows why a test search failed', async () => {
    fakeBackend({
      'GET /api/settings/web': () => settings({ provider: 'brave', hasKey: true }),
      'POST /api/settings/web/test': () => {
        throw new ApiError(502, 'search_failed', 'Brave Search turned down the key.');
      },
    });
    view = await renderWithQuery(<WebSearchSection />);
    await settle();
    await click(buttonByText('Test'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Brave Search turned down the key.',
    );
    expect(document.querySelector('[aria-label="Test results"]')).toBeNull();
  });

  it('turns web search off', async () => {
    const backend = fakeBackend({
      'GET /api/settings/web': () => settings({ provider: 'brave', hasKey: true }),
      'PUT /api/settings/web': () => settings(),
    });
    view = await renderWithQuery(<WebSearchSection />);
    await settle();
    await click(radio('Off'));
    await click(buttonByText('Save'));
    expect(backend.calls.find((call) => call.method === 'PUT')?.body).toEqual({ provider: '' });
    expect(toast).toHaveBeenCalledWith('Web search is off.');
  });
});

describe('Agent actions: save as template', () => {
  it('posts the name and description, and says so', async () => {
    const backend = fakeBackend({
      'POST /api/agents/ag_rex/save-template': (body) => ({
        id: 'paper-finder',
        name: (body as { name: string }).name,
        category: 'yours',
        builtin: false,
      }),
    });
    view = await renderWithQuery(
      <AgentActions agent={agent()} deleting={false} setDeleting={() => {}} />,
    );
    await click(buttonByText('Save as template'));
    expect((fieldByLabel('Name') as HTMLInputElement).value).toBe('Rex');
    expect((fieldByLabel('Description') as HTMLInputElement).value).toBe('Finds papers');

    await typeInto(fieldByLabel('Name'), 'Paper finder');
    await click(buttonByText('Save template'));
    expect(backend.calls).toEqual([
      {
        method: 'POST',
        path: '/api/agents/ag_rex/save-template',
        body: { name: 'Paper finder', description: 'Finds papers' },
      },
    ]);
    expect(toast).toHaveBeenCalledWith('Saved as a template.');
    expect(buttonByText('Save template')).toBeUndefined();
  });
});
