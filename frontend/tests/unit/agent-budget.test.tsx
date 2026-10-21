// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { act } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, BudgetStatus } from '../../src/api/types';
import { BudgetPanel } from '../../src/components/agent-manager/budget-panel';
import { BudgetBanner } from '../../src/components/usage/budget-parts';
import { useAgents } from '../../src/hooks/use-agents';
import { budgetNotice } from '../../src/lib/budget';
import { showBudgetToast } from '../../src/lib/notification-toast';
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
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }) }));

function agent(change: Partial<Agent> = {}): Agent {
  return {
    id: 'ag_hardac',
    name: 'Hardac',
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
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    kindSettings: {},
    canCall: [],
    callable: [],
    dir: '/data/agents/ag_hardac',
    piDurableVersion: null,
    budget: null,
    ...change,
  };
}

const status = (change: Partial<BudgetStatus> = {}): BudgetStatus => ({
  scope: 'agent',
  agentId: 'ag_hardac',
  name: 'Hardac',
  month: '2026-10',
  monthName: 'October',
  monthlyUsd: 20,
  onExceed: 'stop',
  spentUsd: 17.3,
  unpricedRequests: 0,
  percent: 86.5,
  state: 'near',
  blocked: false,
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

async function choose(select: HTMLElement | null, value: string) {
  if (!(select instanceof HTMLSelectElement)) throw new Error('Not a select');
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** The panel as the agent page draws it: from the agents list, so a save draws it again. */
function Harness() {
  const { data } = useAgents();
  const current = data?.[0];
  return current ? <BudgetPanel key={current.revision} agent={current} /> : null;
}

describe("An agent's budget (Settings → Agents → Overview)", () => {
  it('is empty for an agent without one, and sets one', async () => {
    let saved = agent();
    const backend = fakeBackend({
      'GET /api/agents': () => [saved],
      'GET /api/budgets': () => ({ app: null, agents: [] }),
      'PATCH /api/agents/ag_hardac': (body) => {
        saved = agent({ revision: 2, budget: (body as { budget: Agent['budget'] }).budget });
        return saved;
      },
    });
    view = await renderWithQuery(<Harness />);
    await settle();
    expect((fieldByLabel('Monthly budget') as HTMLInputElement).value).toBe('');
    expect(buttonByText('Remove the budget')).toBeUndefined();
    expect(buttonByText('Save')?.disabled).toBe(true);

    await typeInto(fieldByLabel('Monthly budget'), '20');
    await choose(fieldByLabel('At the limit'), 'warn');
    await click(buttonByText('Save'));
    expect(backend.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      budget: { monthlyUsd: 20, onExceed: 'warn' },
    });
    expect(toast).toHaveBeenCalledWith('Hardac saved.');
    // Drawn again from what was saved.
    expect((fieldByLabel('Monthly budget') as HTMLInputElement).value).toBe('20');
    expect(buttonByText('Remove the budget')).toBeDefined();
  });

  it('shows how much is used this month, and removes the budget with null', async () => {
    let saved = agent({ budget: { monthlyUsd: 20, onExceed: 'stop' } });
    const backend = fakeBackend({
      'GET /api/agents': () => [saved],
      'GET /api/budgets': () => ({ app: null, agents: [status()] }),
      'PATCH /api/agents/ag_hardac': () => {
        saved = agent({ revision: 2, budget: null });
        return saved;
      },
    });
    view = await renderWithQuery(<Harness />);
    await settle();
    expect(document.body.textContent).toContain('$17.30 of $20 · 86%');
    expect((fieldByLabel('At the limit') as HTMLSelectElement).value).toBe('stop');
    await click(buttonByText('Remove the budget'));
    expect(backend.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ budget: null });
    expect((fieldByLabel('Monthly budget') as HTMLInputElement).value).toBe('');
  });

  it('keeps an empty amount from setting anything', async () => {
    const backend = fakeBackend({
      'GET /api/agents': () => [agent()],
      'GET /api/budgets': () => ({ app: null, agents: [] }),
    });
    view = await renderWithQuery(<Harness />);
    await settle();
    await typeInto(fieldByLabel('Monthly budget'), '0');
    await click(buttonByText('Save'));
    expect(document.body.textContent).toContain('A budget is from $0.01 to $1,000,000.');
    expect(backend.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});

describe('The budget banner above a conversation', () => {
  const overview = (s: BudgetStatus) => ({ app: null, agents: [s] });

  it('says nothing for a budget that is fine', async () => {
    view = await renderWithQuery(
      <BudgetBanner notice={budgetNotice('ag_hardac', overview(status({ state: 'ok' })))} />,
    );
    expect(document.querySelector('[data-budget-banner]')).toBeNull();
  });

  it('warns, quietly, with a way to the agent settings', async () => {
    view = await renderWithQuery(
      <BudgetBanner notice={budgetNotice('ag_hardac', overview(status()))} />,
    );
    const banner = document.querySelector('[data-budget-banner]');
    expect(banner?.getAttribute('data-budget-banner')).toBe('near');
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.textContent).toContain('Hardac has used 86% of its $20 budget for October.');
    expect(banner?.querySelector('a')?.textContent).toBe('Open its settings');
  });

  it('is an alert when the agent is stopped', async () => {
    view = await renderWithQuery(
      <BudgetBanner
        notice={budgetNotice(
          'ag_hardac',
          overview(status({ state: 'over', blocked: true, percent: 100, spentUsd: 20 })),
        )}
      />,
    );
    const banner = document.querySelector('[data-budget-banner="stopped"]');
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.textContent).toContain(
      "Hardac reached its $20 budget for October. It can't take new messages until you raise its budget.",
    );
  });

  it('points the app-wide budget to Usage', async () => {
    const app = status({ scope: 'app', agentId: undefined, name: 'Pi Local' });
    view = await renderWithQuery(
      <BudgetBanner notice={budgetNotice('ag_hardac', { app, agents: [] })} />,
    );
    const link = document.querySelector('[data-budget-banner] a');
    expect(link?.textContent).toBe('Open usage');
    expect(link?.getAttribute('href')).toBe('/settings/usage');
  });
});

describe('The budget live event', () => {
  const event = (level: 0 | 80 | 100, change: Partial<BudgetStatus> = {}) => ({
    level,
    message:
      level === 80
        ? 'Hardac used 80% of its $20 budget for October.'
        : 'Hardac reached its $20 budget for October. It is stopped until you raise it.',
    status: status(change),
  });

  it('is a toast at 80%', () => {
    const open = vi.fn();
    expect(showBudgetToast(event(80), open)).toBe(true);
    const [title, options] = vi.mocked(toast).mock.calls[0] as unknown as [
      string,
      { description: string; action: { label: string; onClick: () => void } },
    ];
    expect(title).toBe('Budget nearly used up');
    expect(options.description).toBe('Hardac used 80% of its $20 budget for October.');
    options.action.onClick();
    expect(open).toHaveBeenCalled();
  });

  it('is an error toast at 100% when the agent is stopped, a plain one when it only warns', () => {
    showBudgetToast(event(100, { blocked: true }), vi.fn());
    expect(toast.error).toHaveBeenCalledWith('Budget used up', expect.anything());
    showBudgetToast(event(100, { blocked: false, onExceed: 'warn' }), vi.fn());
    expect(toast).toHaveBeenCalledWith('Budget used up', expect.anything());
  });

  it('says nothing when a budget was only changed', () => {
    expect(showBudgetToast(event(0), vi.fn())).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });
});
