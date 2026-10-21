// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type DetectedServer,
  type Provider,
  type ProviderPreset,
  type ProvidersResponse,
} from '../../src/api/client';
import { GetStarted } from '../../src/components/onboarding/get-started';
import type { AgentCatalog } from '../../src/hooks/use-agents';
import { resetPrefWrites } from '../../src/lib/pref-writes';
import { SettingsModelsPage } from '../../src/routes/settings/models';
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

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  Outlet: () => null,
  useLocation: () => ({ pathname: '/' }),
  useNavigate: () => navigate,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    note: 'An API key from platform.openai.com.',
    signupUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    needsKey: true,
    note: '',
    signupUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    note: 'Models running on this computer with Ollama.',
    signupUrl: 'https://ollama.com/download',
    local: true,
  },
  {
    id: 'lm-studio',
    name: 'LM Studio',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    needsKey: false,
    note: '',
    signupUrl: 'https://lmstudio.ai',
    local: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    note: '',
    signupUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'litellm',
    name: 'LiteLLM',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:4000/v1',
    needsKey: true,
    note: 'A LiteLLM proxy.',
  },
];

const DEMO = { id: 'demo/demo-1', name: 'Demo', provider: 'demo', providerName: 'Demo' };

function catalog(models: AgentCatalog['models'], defaultModelId = 'demo/demo-1'): AgentCatalog {
  return {
    templates: [
      {
        id: 'assistant',
        name: 'Assistant',
        description: 'A general helper.',
        category: 'everyday',
        icon: 'sparkles',
        kind: 'assistant',
        instructions: 'You are a helpful assistant.',
        builtin: true,
      },
    ],
    models,
    defaultModelId,
    allowModelChoice: true,
    limit: 20,
    used: 0,
  };
}

function provider(id: string, name: string, modelIds: string[] = []): Provider {
  return {
    id,
    name,
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    hasKey: false,
    headerNames: [],
    enabled: true,
    models: modelIds.map((modelId) => ({
      id: `${id}/${modelId}`,
      provider: id,
      modelId,
      name: modelId,
      contextWindow: 128_000,
      maxTokens: 16_000,
      reasoning: false,
      images: false,
      inputPrice: null,
      outputPrice: null,
      enabled: true,
      usedBy: 0,
    })),
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

const providers = (list: Provider[] = []): ProvidersResponse => ({
  kinds: [],
  presets: PRESETS,
  providers: list,
  defaultModelId: 'demo/demo-1',
});

const OLLAMA: DetectedServer = {
  preset: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  models: ['gemma3:4b', 'llama3.2:3b', 'qwen3:8b'].map((modelId) => ({ modelId, name: modelId })),
  provider: null,
};

const available = (ids: string[]) =>
  ids.map((modelId) => ({ modelId, name: modelId, contextWindow: null, added: false }));

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
  localStorage.clear();
  resetPrefWrites();
  navigate.mockClear();
});

const text = () => document.body.textContent ?? '';
const setupCalls = (backend: ReturnType<typeof fakeBackend>) =>
  backend.calls.filter((call) => call.method === 'POST' && call.path === '/api/providers/setup');

/** A first-run backend: no agents, only the demo model, unless told otherwise. */
function firstRun(routes: Record<string, (body: unknown) => unknown> = {}) {
  return fakeBackend({
    'GET /api/agents': () => [],
    'GET /api/agents/catalog': () => catalog([DEMO]),
    'GET /api/providers': () => providers(),
    'GET /api/providers/detect': () => [],
    'GET /api/me/prefs': () => ({}),
    'PUT /api/me/prefs/onboarding': () => ({ ok: true }),
    ...routes,
  });
}

async function renderFlow() {
  view = await renderWithQuery(<GetStarted />);
  await settle();
}

describe('Get started', () => {
  it('offers a model server found on this computer, and ticks step 1 once it is used', async () => {
    let models = [DEMO];
    let defaultModelId = 'demo/demo-1';
    const backend = firstRun({
      'GET /api/agents/catalog': () => catalog(models, defaultModelId),
      'GET /api/providers/detect': () => [OLLAMA],
      'POST /api/providers/setup': () => {
        models = [
          DEMO,
          ...OLLAMA.models.map((model) => ({
            id: `ollama/${model.modelId}`,
            name: model.name,
            provider: 'ollama',
            providerName: 'Ollama',
          })),
        ];
        defaultModelId = 'ollama/llama3.2:3b';
        return {
          provider: provider('ollama', 'Ollama', ['gemma3:4b', 'llama3.2:3b', 'qwen3:8b']),
          available: available(['gemma3:4b', 'llama3.2:3b', 'qwen3:8b']),
          defaultModelId,
        };
      },
    });
    await renderFlow();

    expect(text()).toContain('Connect a model');
    expect(text()).toContain('Ollama is running · 3 models');
    // Step 2 waits for a model.
    expect(buttonByText('Make an agent')?.disabled).toBe(true);

    await click(buttonByText('Use Ollama'));
    expect(setupCalls(backend).map((call) => call.body)).toEqual([{ preset: 'ollama' }]);
    expect(text()).toContain('Connected. Default model: llama3.2:3b');
    expect(text()).toContain('Connect a model (done)');
    expect(text()).not.toContain('Found on this computer');
    expect(buttonByText('Make an agent')?.disabled).toBe(false);
  });

  it('says so quietly when nothing runs here, with where to get one', async () => {
    firstRun();
    await renderFlow();
    expect(text()).toContain(
      'No local model server found. Ollama or LM Studio run models free on this computer.',
    );
    const links = [...document.querySelectorAll('a[target="_blank"]')].map((link) => [
      link.textContent,
      link.getAttribute('href'),
    ]);
    expect(links).toEqual([
      ['Ollama', 'https://ollama.com/download'],
      ['LM Studio', 'https://lmstudio.ai'],
    ]);
  });

  it('tells how to get models for a server that has none', async () => {
    firstRun({ 'GET /api/providers/detect': () => [{ ...OLLAMA, models: [] }] });
    await renderFlow();
    expect(text()).toContain(
      'Ollama is running but has no models yet. Pull one (ollama pull llama3.2).',
    );
    expect(buttonByText('Use Ollama')).toBeUndefined();
  });

  it('connects a provider with its key, then adds the models picked', async () => {
    const backend = firstRun({
      'POST /api/providers/setup': () => ({
        provider: { ...provider('openai', 'OpenAI'), hasKey: true },
        available: available(['gpt-5', 'gpt-5-mini', 'o3']),
        defaultModelId: 'demo/demo-1',
      }),
    });
    await renderFlow();

    // Only the services that need just a key; the rest are in Settings → Models.
    expect(buttonByText('OpenAI')).toBeDefined();
    expect(buttonByText('Anthropic')).toBeDefined();
    expect(buttonByText('OpenRouter')).toBeDefined();
    expect(buttonByText('LiteLLM')).toBeUndefined();
    expect(text()).toContain('CLIProxyAPI, LiteLLM or another OpenAI-compatible server?');

    await click(buttonByText('OpenAI'));
    const key = fieldByLabel('OpenAI API key');
    expect(key?.getAttribute('type')).toBe('password');
    const getKey = [...document.querySelectorAll('a')].find(
      (link) => link.textContent === 'Get a key',
    );
    expect(getKey?.getAttribute('href')).toBe('https://platform.openai.com/api-keys');
    expect(buttonByText('Connect')?.disabled).toBe(true);

    await typeInto(key, '  sk-test  ');
    await click(buttonByText('Connect'));
    expect(setupCalls(backend).map((call) => call.body)).toEqual([
      { preset: 'openai', apiKey: 'sk-test' },
    ]);

    const listed = () =>
      [...document.querySelectorAll('[aria-label="OpenAI models"] label')].map((label) =>
        label.textContent?.trim(),
      );
    expect(listed()).toEqual(['gpt-5', 'gpt-5-mini', 'o3']);
    expect(buttonByText('Use these')?.disabled).toBe(true);

    await typeInto(document.querySelector('[aria-label="Search models"]'), 'mini');
    expect(listed()).toEqual(['gpt-5-mini']);
    await click(document.querySelector('[aria-label="OpenAI models"] input[type="checkbox"]'));
    await click(buttonByText('Use these'));
    expect(setupCalls(backend).map((call) => call.body)).toEqual([
      { preset: 'openai', apiKey: 'sk-test' },
      { preset: 'openai', models: ['gpt-5-mini'] },
    ]);
  });

  it('shows a key the provider turns down', async () => {
    firstRun({
      'POST /api/providers/setup': () => {
        throw new ApiError(400, 'invalid_key', 'Paste the API key from Anthropic.');
      },
    });
    await renderFlow();
    await click(buttonByText('Anthropic'));
    await typeInto(fieldByLabel('Anthropic API key'), 'nope');
    await click(buttonByText('Connect'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Paste the API key from Anthropic.',
    );
    // Still on the key, to try again.
    expect(fieldByLabel('Anthropic API key')).not.toBeNull();
  });

  it('lets the person try the demo model instead, saved in the onboarding pref', async () => {
    const backend = firstRun();
    await renderFlow();
    await click(buttonByText('try the demo model'));
    expect(text()).toContain('Using the demo model');
    expect(text()).toContain('Connect a model (done)');
    expect(buttonByText('Make an agent')?.disabled).toBe(false);
    expect(backend.calls.filter((call) => call.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/api/me/prefs/onboarding', body: { value: { skipModel: true } } },
    ]);
    expect(localStorage.getItem('pai.onboarding.skipModel')).toBeNull();

    await click(buttonByText('Connect a model'));
    expect(text()).not.toContain('Using the demo model');
    expect(backend.calls.filter((call) => call.method === 'PUT').at(-1)?.body).toEqual({
      value: { skipModel: false },
    });
  });

  it('reads skipModel from the onboarding pref', async () => {
    const backend = firstRun({ 'GET /api/me/prefs': () => ({ onboarding: { skipModel: true } }) });
    await renderFlow();
    expect(text()).toContain('Using the demo model');
    expect(text()).toContain('Connect a model (done)');
    expect(backend.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it("moves this browser's old choice into the pref, once", async () => {
    localStorage.setItem('pai.onboarding.skipModel', 'true');
    const backend = firstRun();
    await renderFlow();
    expect(text()).toContain('Using the demo model');
    expect(backend.calls.filter((call) => call.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/api/me/prefs/onboarding', body: { value: { skipModel: true } } },
    ]);
    expect(localStorage.getItem('pai.onboarding.skipModel')).toBeNull();
  });

  it('opens the New agent dialog from step 2, and goes to the new agent', async () => {
    const backend = firstRun({
      'GET /api/me/prefs': () => ({ onboarding: { skipModel: true } }),
      'POST /api/agents': (body) => ({ id: 'ag_new', name: (body as { name: string }).name }),
    });
    await renderFlow();
    await click(buttonByText('Make an agent'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('New agent');
    expect(text()).toContain('Start from');
    await click(buttonByText('Make agent'));
    expect(
      backend.calls.find((call) => call.path === '/api/agents' && call.method === 'POST'),
    ).toMatchObject({ body: { name: 'Assistant', templateId: 'assistant' } });
    expect(navigate).toHaveBeenCalledWith({ to: '/', search: { agent: 'ag_new' } });
  });

  it('with a model connected and no agents, shows step 1 done and step 2 open', async () => {
    const backend = firstRun({
      'GET /api/agents/catalog': () =>
        catalog(
          [DEMO, { id: 'openai/gpt-5', name: 'GPT-5', provider: 'openai', providerName: 'OpenAI' }],
          'openai/gpt-5',
        ),
    });
    await renderFlow();
    expect(text()).toContain('Connect a model (done)');
    expect(text()).toContain('Connected. Default model: GPT-5');
    expect(text()).toContain('Make your first agent');
    expect(text()).not.toContain('Make your first agent (done)');
    expect(text()).not.toContain('Found on this computer');
    expect(backend.calls.some((call) => call.path === '/api/providers/detect')).toBe(false);
  });

  it('is gone once there is a model and an agent', async () => {
    firstRun({
      'GET /api/agents': () => [{ id: 'ag_rex', name: 'Rex' }],
      'GET /api/agents/catalog': () =>
        catalog([DEMO, { id: 'openai/gpt-5', name: 'GPT-5', provider: 'openai' }], 'openai/gpt-5'),
    });
    await renderFlow();
    expect(document.querySelector('[aria-labelledby="get-started-title"]')).toBeNull();
  });
});

describe('Settings → Models: a server found on this computer', () => {
  it('offers to add it, and adds it in one step', async () => {
    const backend = fakeBackend({
      'GET /api/providers': () => providers(),
      'GET /api/agents/catalog': () => catalog([DEMO]),
      'GET /api/providers/detect': () => [
        OLLAMA,
        // Already set up: no banner.
        { ...OLLAMA, preset: 'lm-studio', name: 'LM Studio', provider: 'lm-studio' },
      ],
      'POST /api/providers/setup': () => ({
        provider: provider('ollama', 'Ollama', ['gemma3:4b', 'llama3.2:3b', 'qwen3:8b']),
        available: available(['gemma3:4b', 'llama3.2:3b', 'qwen3:8b']),
        defaultModelId: 'ollama/gemma3:4b',
      }),
    });
    view = await renderWithQuery(<SettingsModelsPage />);
    await settle();
    expect(text()).toContain('Ollama is running on this computer with 3 models.');
    expect(text()).not.toContain('LM Studio is running');

    await click(buttonByText('Add it'));
    expect(setupCalls(backend).map((call) => call.body)).toEqual([{ preset: 'ollama' }]);
  });

  it('shows each preset’s signup link in the Add provider dialog', async () => {
    fakeBackend({
      'GET /api/providers': () => providers(),
      'GET /api/agents/catalog': () => catalog([DEMO]),
      'GET /api/providers/detect': () => [],
    });
    view = await renderWithQuery(<SettingsModelsPage />);
    await settle();
    await click(buttonByText('Add provider'));
    const links = [...document.querySelectorAll('[aria-label="Kinds of provider"] a')].map(
      (link) => [link.textContent, link.getAttribute('href')],
    );
    expect(links).toEqual([
      ['Get a key', 'https://platform.openai.com/api-keys'],
      ['Get a key', 'https://console.anthropic.com/settings/keys'],
      ['Download', 'https://ollama.com/download'],
      ['Download', 'https://lmstudio.ai'],
      ['Get a key', 'https://openrouter.ai/keys'],
    ]);
    // Picking a preset still works through its name.
    await click(buttonByText('Ollama'));
    expect(text()).toContain('Add Ollama');
  });
});
