// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import type { BudgetStatus, UsageReport, UsageTotals } from '../../src/api/types';
import { emptyTotals } from '../../src/lib/usage';
import { SettingsUsagePage } from '../../src/routes/settings/usage';
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
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  restoreTransport();
});

const totals = (change: Partial<UsageTotals>): UsageTotals => ({ ...emptyTotals(), ...change });

const appBudget: BudgetStatus = {
  scope: 'app',
  name: 'Pi Local',
  month: '2026-10',
  monthName: 'October',
  monthlyUsd: 50,
  onExceed: 'warn',
  spentUsd: 42.5,
  unpricedRequests: 3,
  percent: 85,
  state: 'near',
  blocked: false,
};
const hardacBudget: BudgetStatus = {
  ...appBudget,
  scope: 'agent',
  agentId: 'ag_hardac',
  name: 'Hardac',
  monthlyUsd: 20,
  onExceed: 'stop',
  spentUsd: 20,
  percent: 100,
  state: 'over',
  blocked: true,
  unpricedRequests: 0,
};

function report(change: Partial<UsageReport> = {}): UsageReport {
  return {
    from: '2026-10-01',
    to: '2026-10-31',
    days: 31,
    month: '2026-10',
    total: totals({ requests: 12, inputTokens: 1000, outputTokens: 500, costUsd: 4.2 }),
    agents: [
      {
        ...totals({ requests: 8, inputTokens: 800, costUsd: 3 }),
        agentId: 'ag_hardac',
        name: 'Hardac',
      },
      {
        ...totals({ requests: 4, inputTokens: 200, costUsd: 1.2 }),
        agentId: 'ag_rex',
        name: 'Rex',
      },
    ],
    models: [
      {
        ...totals({ requests: 12, inputTokens: 1000, costUsd: 4.2 }),
        modelId: 'fake/fast',
        name: 'Fast',
      },
    ],
    byDay: [],
    options: {
      agents: [
        { agentId: 'ag_hardac', name: 'Hardac' },
        { agentId: 'ag_rex', name: 'Rex' },
      ],
      models: [
        { modelId: 'fake/fast', name: 'Fast' },
        { modelId: 'fake/slow', name: 'Slow' },
      ],
    },
    budget: { app: appBudget, agent: null },
    ...change,
  };
}

const usageCalls = (backend: ReturnType<typeof fakeBackend>) =>
  backend.calls.filter((call) => call.path.startsWith('/api/me/usage')).map((call) => call.path);

async function choose(select: HTMLElement | null, value: string) {
  if (!(select instanceof HTMLSelectElement)) throw new Error('Not a select');
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

function backendFor(extra: Record<string, (body: unknown) => unknown> = {}) {
  return fakeBackend({
    'GET /api/me/usage?days=30': () => report({ days: 30, month: undefined }),
    'GET /api/budgets': () => ({ app: appBudget, agents: [hardacBudget] }),
    'GET /api/settings/budget': () => ({ budget: { monthlyUsd: 50, onExceed: 'warn' } }),
    ...extra,
  });
}

describe('Settings → Usage: the drill-down', () => {
  it('shows the budget with what is spent, and the per-agent and per-model tables', async () => {
    backendFor();
    view = await renderWithQuery(<SettingsUsagePage />);
    await settle();
    const text = document.body.textContent ?? '';
    expect(text).toContain('All agents together');
    expect(text).toContain('$42.50 of $50 · 85%');
    expect(text).toContain("Costs and budgets don't include requests to models without prices.");
    expect(document.querySelectorAll('[data-unpriced-warning]').length).toBe(1);
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      '85',
    );
    // The agent's own budget is told under its name.
    expect(text).toContain('Budget $20 · 100% used in October');
    expect(text).toContain('By agent');
    expect(text).toContain('By model');
  });

  it('filters by agent and by model, asking the backend each time', async () => {
    const backend = backendFor({
      'GET /api/me/usage?days=30&agent=ag_hardac': () =>
        report({
          days: 30,
          agents: [report().agents[0]!],
          budget: { app: appBudget, agent: hardacBudget },
        }),
      'GET /api/me/usage?days=30&agent=ag_hardac&model=fake%2Fslow': () =>
        report({ days: 30, agents: [], models: [], total: totals({}) }),
    });
    view = await renderWithQuery(<SettingsUsagePage />);
    await settle();
    expect(fieldByLabel('Agent')?.querySelectorAll('option').length).toBe(3); // all + two

    await choose(fieldByLabel('Agent'), 'ag_hardac');
    expect(usageCalls(backend).at(-1)).toBe('/api/me/usage?days=30&agent=ag_hardac');
    // The agent's budget is shown next to the app's.
    expect(document.body.textContent).toContain('Hardac');
    expect(document.body.textContent).toContain('$20.00 of $20 · 100%');
    // The filter still offers every agent (the options come from the period, not the filter).
    expect(fieldByLabel('Agent')?.querySelectorAll('option').length).toBe(3);

    await choose(fieldByLabel('Model'), 'fake/slow');
    expect(usageCalls(backend).at(-1)).toBe(
      '/api/me/usage?days=30&agent=ag_hardac&model=fake%2Fslow',
    );
    expect(document.body.textContent).toContain('No agents match in these 30 days.');

    await click(buttonByText('Clear filters'));
    // Unfiltered again (its answer was kept, so nothing new is asked).
    expect((fieldByLabel('Agent') as HTMLSelectElement).value).toBe('');
    expect((fieldByLabel('Model') as HTMLSelectElement).value).toBe('');
    expect(buttonByText('Clear filters')).toBeUndefined();
    expect(usageCalls(backend)).toContain('/api/me/usage?days=30');
  });

  it('narrows to a row from its name', async () => {
    const backend = backendFor({
      'GET /api/me/usage?days=30&model=fake%2Ffast': () => report({ days: 30 }),
    });
    view = await renderWithQuery(<SettingsUsagePage />);
    await settle();
    const pick = [...document.querySelectorAll('button')].find(
      (button) => button.getAttribute('title') === 'Show only Fast',
    );
    await click(pick);
    expect(usageCalls(backend).at(-1)).toBe('/api/me/usage?days=30&model=fake%2Ffast');
    expect((fieldByLabel('Model') as HTMLSelectElement).value).toBe('fake/fast');
  });

  it('has a month view that steps back and not past this month', async () => {
    const thisMonth = new Date();
    const key = `${thisMonth.getFullYear()}-${String(thisMonth.getMonth() + 1).padStart(2, '0')}`;
    const earlier = new Date(thisMonth.getFullYear(), thisMonth.getMonth() - 1, 1);
    const earlierKey = `${earlier.getFullYear()}-${String(earlier.getMonth() + 1).padStart(2, '0')}`;
    const backend = backendFor({
      [`GET /api/me/usage?month=${key}`]: () => report({ month: key }),
      [`GET /api/me/usage?month=${earlierKey}`]: () => report({ month: earlierKey }),
    });
    view = await renderWithQuery(<SettingsUsagePage />);
    await settle();
    await click(buttonByText('Month'));
    expect(usageCalls(backend).at(-1)).toBe(`/api/me/usage?month=${key}`);
    const after = document.querySelector<HTMLButtonElement>('[aria-label="The month after"]');
    expect(after?.disabled).toBe(true);
    await click(document.querySelector('[aria-label="The month before"]'));
    expect(usageCalls(backend).at(-1)).toBe(`/api/me/usage?month=${earlierKey}`);
    expect(
      document.querySelector<HTMLButtonElement>('[aria-label="The month after"]')?.disabled,
    ).toBe(false);
    // Back to days.
    await click(buttonByText('7 days'));
    expect(document.querySelector('[aria-label="The month before"]')).toBeNull();
  });
});

describe('Settings → Usage: the budget for all agents', () => {
  it('shows the current budget and saves a new one', async () => {
    const backend = backendFor({
      'PUT /api/settings/budget': (body) => ({ budget: (body as { budget: unknown }).budget }),
    });
    view = await renderWithQuery(<SettingsUsagePage />);
    await settle();
    const amount = fieldByLabel('Monthly budget') as HTMLInputElement;
    expect(amount.value).toBe('50.00');
    expect((fieldByLabel('At the limit') as HTMLSelectElement).value).toBe('warn');
    expect(buttonByText('Save')?.disabled).toBe(true);

    await typeInto(amount, '75,5');
    await choose(fieldByLabel('At the limit'), 'stop');
    await click(buttonByText('Save'));
    const put = backend.calls.find((call) => call.method === 'PUT');
    expect(put).toEqual({
      method: 'PUT',
      path: '/api/settings/budget',
      body: { budget: { monthlyUsd: 75.5, onExceed: 'stop' } },
    });
  });

  it('refuses an amount that is not dollars, without asking the backend', async () => {
    const backend = backendFor();
    view = await renderWithQuery(<SettingsUsagePage />);
    await settle();
    await typeInto(fieldByLabel('Monthly budget'), 'lots');
    await click(buttonByText('Save'));
    expect(document.body.textContent).toContain('A budget is from $0.01 to $1,000,000.');
    expect(backend.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('removes it', async () => {
    const backend = backendFor({ 'PUT /api/settings/budget': () => ({ budget: null }) });
    view = await renderWithQuery(<SettingsUsagePage />);
    await settle();
    await click(buttonByText('Remove the budget'));
    expect(backend.calls.find((call) => call.method === 'PUT')?.body).toEqual({ budget: null });
  });

  it('says why a budget was refused, as the backend words it', async () => {
    backendFor({
      'PUT /api/settings/budget': () => {
        throw new ApiError(400, 'invalid_budget', 'A monthly budget is from $0.01 to $1,000,000.');
      },
    });
    view = await renderWithQuery(<SettingsUsagePage />);
    await settle();
    await typeInto(fieldByLabel('Monthly budget'), '60');
    await click(buttonByText('Save'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'A monthly budget is from $0.01 to $1,000,000.',
    );
  });
});
