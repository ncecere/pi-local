// @vitest-environment happy-dom
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Model, Provider, ProvidersResponse } from '../../src/api/client';
import { defaultModelNotice } from '../../src/lib/models';
import { SettingsModelsPage } from '../../src/routes/settings/models';
import {
  click,
  fakeBackend,
  type Rendered,
  renderWithQuery,
  restoreTransport,
  settle,
} from './ui-test-utils';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const model = (modelId: string, name: string, enabled = true): Model => ({
  id: `acme/${modelId}`,
  provider: 'acme',
  modelId,
  name,
  contextWindow: 128_000,
  maxTokens: 16_000,
  reasoning: false,
  images: false,
  inputPrice: null,
  outputPrice: null,
  enabled,
  usedBy: 0,
});

const provider = (models: Model[], enabled = true): Provider => ({
  id: 'acme',
  name: 'Acme',
  kind: 'openai-compatible',
  baseUrl: 'https://api.acme.test/v1',
  hasKey: true,
  headerNames: [],
  enabled,
  models,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
});

const response = (
  providers: Provider[],
  defaultModelId: string | null,
): Pick<ProvidersResponse, 'providers' | 'defaultModelId'> => ({ providers, defaultModelId });

describe('defaultModelNotice', () => {
  const quick = model('quick', 'Quick');
  const strong = model('strong', 'Strong');

  it('names the model the default moved to', () => {
    expect(
      defaultModelNotice('acme/quick', response([provider([quick, strong])], 'acme/strong')),
    ).toBe('The default model is now Strong.');
  });
  it('says the demo model when nothing else is left', () => {
    expect(
      defaultModelNotice('acme/quick', response([provider([quick], false)], 'demo/demo-1')),
    ).toBe('The default model is now the demo model.');
    expect(defaultModelNotice('acme/quick', response([], null))).toBe(
      'The default model is now the demo model.',
    );
  });
  it('says nothing when the default stayed', () => {
    expect(
      defaultModelNotice('acme/quick', response([provider([quick])], 'acme/quick')),
    ).toBeNull();
    expect(defaultModelNotice(null, response([], 'demo/demo-1'))).toBeNull();
    expect(defaultModelNotice(undefined, response([], null))).toBeNull();
  });
});

let view: Rendered | undefined;
beforeEach(() => vi.mocked(toast).mockClear());
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

/** The Models page with a server whose default model moves when `change()` runs. */
async function showModels() {
  const state = {
    models: [model('quick', 'Quick'), model('strong', 'Strong')],
    enabled: true,
    defaultModelId: 'acme/quick' as string | null,
  };
  const current = () => provider(state.models, state.enabled);
  const backend = fakeBackend({
    'GET /api/providers': () => ({
      kinds: [],
      presets: [],
      providers: [current()],
      defaultModelId: state.defaultModelId,
    }),
    'GET /api/agents/catalog': () => ({
      templates: [],
      models: [],
      defaultModelId: state.defaultModelId,
      allowModelChoice: true,
      limit: 1000,
      used: 1,
    }),
    'GET /api/agents': () => [],
    'PUT /api/providers/acme/models/quick': (body) => {
      const { enabled } = body as { enabled: boolean };
      state.models = state.models.map((m) => (m.modelId === 'quick' ? { ...m, enabled } : m));
      // The server moves the default off a model turned off.
      if (!enabled) state.defaultModelId = 'acme/strong';
      return state.models[0];
    },
    'PUT /api/providers/acme/models/strong': (body) => {
      const { enabled } = body as { enabled: boolean };
      state.models = state.models.map((m) => (m.modelId === 'strong' ? { ...m, enabled } : m));
      return state.models[1];
    },
    'PATCH /api/providers/acme': (body) => {
      state.enabled = (body as { enabled: boolean }).enabled;
      if (!state.enabled) state.defaultModelId = 'demo/demo-1';
      return current();
    },
  });
  view = await renderWithQuery(<SettingsModelsPage />);
  await settle();
  await click(document.querySelector('button[aria-expanded]'));
  return backend;
}

const toggle = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`);
const toasts = () => vi.mocked(toast).mock.calls.map((call) => call[0]);

describe('Settings → Models: turning off the default', () => {
  it('says which model is the default now', async () => {
    await showModels();
    await click(toggle('Let agents use Quick'));
    await settle();
    expect(toasts()).toContain('The default model is now Strong.');
  });

  it('says the demo model when the provider it came from is turned off', async () => {
    await showModels();
    await click(toggle('Use Acme'));
    await settle();
    expect(toasts()).toContain('The default model is now the demo model.');
  });

  it('says nothing when another model is turned off', async () => {
    await showModels();
    await click(toggle('Let agents use Strong'));
    await settle();
    expect(toasts().filter((text) => String(text).startsWith('The default model'))).toEqual([]);
  });
});
