// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Provider, ProviderKind, ProviderPreset } from '../../src/api/client';
import { AddProviderDialog } from '../../src/components/models/provider-dialogs';
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

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const KINDS: ProviderKind[] = [
  {
    id: 'openai-compatible',
    name: 'OpenAI-compatible',
    api: 'openai-completions',
    defaultBaseUrl: null,
  },
];
const preset = (change: Partial<ProviderPreset>): ProviderPreset => ({
  id: 'other',
  name: 'OpenAI-compatible',
  kind: 'openai-compatible',
  baseUrl: '',
  needsKey: true,
  note: '',
  ...change,
});
const OTHER = preset({
  note: 'Any server with an OpenAI-compatible API (vLLM, Together, Groq …).',
});
const LITELLM = preset({
  id: 'litellm',
  name: 'LiteLLM',
  baseUrl: 'http://localhost:4000/v1',
  note: 'A LiteLLM proxy.',
});

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

async function open(presets: ProviderPreset[]) {
  const backend = fakeBackend({
    'POST /api/providers': (body) => ({ id: 'mine', ...(body as object) }) as unknown as Provider,
  });
  view = await renderWithQuery(
    <AddProviderDialog kinds={KINDS} presets={presets} onClose={() => {}} onCreated={() => {}} />,
  );
  await settle();
  return backend;
}

const keyField = () => fieldByLabel('API key') as HTMLInputElement;

describe('Adding an OpenAI-compatible provider', () => {
  it('needs no API key: a server of your own (vLLM, llama.cpp) has none', async () => {
    const backend = await open([OTHER]);
    await click(buttonByText('OpenAI-compatible'));
    const label = [...document.querySelectorAll('label')].find((l) => l.htmlFor === keyField().id);
    expect(label?.textContent).toContain('(optional)');
    expect(keyField().required).toBe(false);
    expect(document.body.textContent).toContain('Leave empty if the server needs none');

    await typeInto(fieldByLabel('Name'), 'Local vLLM');
    await typeInto(fieldByLabel('Base URL'), 'http://localhost:8000/v1');
    expect(buttonByText('Add provider')?.disabled).toBe(false);
    await click(buttonByText('Add provider'));
    // No key goes with it.
    expect(backend.calls.filter((call) => call.method === 'POST')).toEqual([
      {
        method: 'POST',
        path: '/api/providers',
        body: {
          name: 'Local vLLM',
          kind: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
        },
      },
    ]);
  });

  it('still needs a key for a service that has one, such as a LiteLLM proxy', async () => {
    await open([LITELLM]);
    await click(buttonByText('LiteLLM'));
    expect(keyField().required).toBe(true);
    expect(buttonByText('Add provider')?.disabled).toBe(true);
    await typeInto(keyField(), 'sk-1');
    expect(buttonByText('Add provider')?.disabled).toBe(false);
  });
});
