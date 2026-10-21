// @vitest-environment happy-dom
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type JudgmentSettings, type JudgmentsInfo } from '../../src/api/client';
import { JudgmentsSection } from '../../src/components/models/judgments-section';
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

const USES = [
  'agentRouting',
  'toolPreselection',
  'inbox',
  'approvals',
  'memory',
  'knowledge',
  'triggers',
];

const settings = (change: Partial<JudgmentSettings> = {}): JudgmentSettings => ({
  enabled: false,
  url: 'https://api.typesafe.ai',
  model: 'jev-1.14.0',
  hasKey: false,
  uses: Object.fromEntries(USES.map((use) => [use, false])),
  threshold: 0.6,
  ...change,
});

const info = (change: Partial<JudgmentSettings> = {}): JudgmentsInfo => ({
  settings: settings(change),
  uses: USES,
  defaultUrl: 'https://api.typesafe.ai',
  defaultModel: 'jev-1.14.0',
});

let view: Rendered | undefined;
beforeEach(() => {
  vi.mocked(toast).mockClear();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const text = () => document.body.textContent ?? '';
const switchFor = (label: string) => {
  const id = [...document.querySelectorAll('p')].find((p) => p.textContent === label)?.id;
  return document.querySelector<HTMLButtonElement>(`[role="switch"][aria-labelledby="${id}"]`);
};

describe('Settings → Models: fast judgments', () => {
  it('explains itself, with the later uses switched off', async () => {
    fakeBackend({ 'GET /api/settings/judgments': () => info() });
    view = await renderWithQuery(<JudgmentsSection />);
    await settle();
    expect(text()).toContain(
      'Optional. Quick decisions by a System One model (TypeSafe Jev). The text being judged is sent to the service below.',
    );
    expect(switchFor('Agent routing')?.disabled).toBe(false);
    expect(switchFor('Tool preselection')?.disabled).toBe(false);
    for (const label of ['Inbox', 'Approvals', 'Memory', 'Knowledge', 'Triggers'])
      expect(switchFor(label)?.disabled).toBe(true);
    expect(text()).toContain('Coming later.');
    expect((fieldByLabel('Model') as HTMLInputElement).value).toBe('jev-1.14.0');
    expect(fieldByLabel('API key')?.getAttribute('type')).toBe('password');
  });

  it('saves the switch, key, threshold and uses, then says a key is stored', async () => {
    let current = info();
    const backend = fakeBackend({
      'GET /api/settings/judgments': () => current,
      'PUT /api/settings/judgments': () => {
        current = info({
          enabled: true,
          hasKey: true,
          threshold: 0.8,
          uses: { ...settings().uses, agentRouting: true },
        });
        return current.settings;
      },
    });
    view = await renderWithQuery(<JudgmentsSection />);
    await settle();
    expect(buttonByText('Save')?.disabled).toBe(true);

    await click(switchFor('Enabled'));
    await typeInto(fieldByLabel('API key'), '  ts-key  ');
    const slider = fieldByLabel('Confidence threshold') as HTMLInputElement;
    await typeInto(slider, '0.8');
    await click(switchFor('Agent routing'));
    await click(buttonByText('Save'));
    expect(backend.calls.filter((call) => call.method === 'PUT')).toEqual([
      {
        method: 'PUT',
        path: '/api/settings/judgments',
        body: {
          enabled: true,
          url: 'https://api.typesafe.ai',
          model: 'jev-1.14.0',
          threshold: 0.8,
          uses: { ...settings().uses, agentRouting: true },
          apiKey: 'ts-key',
        },
      },
    ]);
    expect(toast).toHaveBeenCalledWith('Fast judgments saved.');
    await settle();
    expect(text()).toContain('A key is stored. Leave this empty to keep it.');
    expect(switchFor('Agent routing')?.getAttribute('aria-checked')).toBe('true');
  });

  it('shows why saving was refused', async () => {
    fakeBackend({
      'GET /api/settings/judgments': () => info(),
      'PUT /api/settings/judgments': () => {
        throw new ApiError(
          400,
          'invalid_key',
          'Paste a TypeSafe API key to turn fast judgments on.',
        );
      },
    });
    view = await renderWithQuery(<JudgmentsSection />);
    await settle();
    await click(switchFor('Enabled'));
    await click(buttonByText('Save'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Paste a TypeSafe API key to turn fast judgments on.',
    );
  });

  it('shows why the test failed', async () => {
    const backend = fakeBackend({
      'GET /api/settings/judgments': () => info({ enabled: true, hasKey: true }),
      'POST /api/settings/judgments/test': () => {
        throw new ApiError(502, 'judge_failed', 'The fast-judgments service refused the key.');
      },
    });
    view = await renderWithQuery(<JudgmentsSection />);
    await settle();
    await click(buttonByText('Test'));
    expect(backend.calls.filter((call) => call.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/settings/judgments/test', body: {} },
    ]);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'The fast-judgments service refused the key.',
    );
  });

  it('says the test worked, and loads the models into a list', async () => {
    fakeBackend({
      'GET /api/settings/judgments': () => info({ enabled: true, hasKey: true }),
      'POST /api/settings/judgments/test': () => ({
        model: 'jev-1.14.0',
        answer: { type: 'noul', noul: 0.97 },
      }),
      'GET /api/settings/judgments/models': () => ['jev-1.14.0', 'jev-1.15.0'],
    });
    view = await renderWithQuery(<JudgmentsSection />);
    await settle();
    await click(buttonByText('Test'));
    expect(text()).toContain('It works: jev-1.14.0 answered.');

    await click(buttonByText('Load models'));
    const select = fieldByLabel('Model') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect([...select.options].map((option) => option.value)).toEqual(['jev-1.14.0', 'jev-1.15.0']);
  });
});
