// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Model, Provider } from '../../src/api/types';
import { ModelDialog } from '../../src/components/models/model-dialogs';
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

function model(change: Partial<Model> = {}): Model {
  return {
    id: 'anthropic/claude-sonnet-4-5',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    contextWindow: 200000,
    maxTokens: 16000,
    reasoning: false,
    images: false,
    inputPrice: null,
    outputPrice: null,
    enabled: true,
    usedBy: 0,
    ...change,
  };
}

const provider = (models: Model[]): Provider => ({
  id: 'anthropic',
  name: 'Anthropic',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  hasKey: true,
  headerNames: [],
  enabled: true,
  models,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
});

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const source = () => document.querySelector('[data-price-source]');

describe('A model dialog: prices and where they came from', () => {
  it('says list prices were set, and offers nothing then', async () => {
    fakeBackend();
    const listed = model({
      inputPrice: 3,
      outputPrice: 15,
      cacheReadPrice: 0.3,
      cacheWritePrice: 3.75,
      priceSource: 'list',
      hasListPrice: true,
    });
    view = await renderWithQuery(
      <ModelDialog provider={provider([listed])} model={listed} onClose={() => {}} />,
    );
    expect(source()?.textContent).toBe('These are the list prices.');
    expect(buttonByText('Use list prices')).toBeUndefined();
    expect((fieldByLabel('Cache read price') as HTMLInputElement).value).toBe('0.3');
    expect((fieldByLabel('Cache write price') as HTMLInputElement).value).toBe('3.75');
  });

  it('offers the list prices to a model you priced, and fills them in', async () => {
    const backend = fakeBackend({
      'PUT /api/providers/anthropic/models/claude-sonnet-4-5': () =>
        model({
          inputPrice: 3,
          outputPrice: 15,
          cacheReadPrice: 0.3,
          cacheWritePrice: 3.75,
          priceSource: 'list',
          hasListPrice: true,
        }),
    });
    const mine = model({ inputPrice: 1, outputPrice: 2, priceSource: 'you', hasListPrice: true });
    view = await renderWithQuery(
      <ModelDialog provider={provider([mine])} model={mine} onClose={() => {}} />,
    );
    expect(source()?.textContent).toContain('You set these prices.');
    await click(buttonByText('Use list prices'));
    await settle();
    expect(backend.calls.find((call) => call.method === 'PUT')?.body).toEqual({
      priceFromList: true,
    });
    expect((fieldByLabel('Input price') as HTMLInputElement).value).toBe('3');
    expect((fieldByLabel('Output price') as HTMLInputElement).value).toBe('15');
    expect(source()?.textContent).toBe('These are the list prices.');
  });

  it("doesn't offer list prices a model has none of", async () => {
    fakeBackend();
    const unpriced = model({ modelId: 'my-model', id: 'anthropic/my-model', hasListPrice: false });
    view = await renderWithQuery(
      <ModelDialog provider={provider([unpriced])} model={unpriced} onClose={() => {}} />,
    );
    expect(source()?.textContent).toBe('No prices: its usage is counted, but not in dollars.');
    expect(buttonByText('Use list prices')).toBeUndefined();
  });

  it('tells a new model that leaving prices empty gets the list prices', async () => {
    const backend = fakeBackend({
      'PUT /api/providers/anthropic/models/claude-haiku-4-5': () =>
        model({ modelId: 'claude-haiku-4-5' }),
    });
    view = await renderWithQuery(
      <ModelDialog provider={provider([])} model={null} onClose={() => {}} />,
    );
    expect(document.body.textContent).toContain(
      'Leave the prices empty and a well-known model gets its list prices.',
    );
    await typeInto(fieldByLabel('Model ID'), 'claude-haiku-4-5');
    await click(
      buttonByText('Add model') ?? [...document.querySelectorAll('button[type="submit"]')][0],
    );
    // Sent with no prices, which is what lets the backend fill in the list's.
    const put = backend.calls.find((call) => call.method === 'PUT')?.body as Record<
      string,
      unknown
    >;
    expect(put.inputPrice).toBeNull();
    expect(put.outputPrice).toBeNull();
    expect(put.cacheReadPrice).toBeNull();
    expect(put.priceFromList).toBeUndefined();
  });
});
