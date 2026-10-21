import { describe, expect, it } from 'vitest';
import type { BudgetOverview, BudgetStatus } from '../../src/api/types.ts';
import {
  budgetNotice,
  dollars,
  parseBudgetAmount,
  percentText,
  sameBudget,
  spent,
} from '../../src/lib/budget.ts';
import { monthLabel, shiftMonth, usageQueryString } from '../../src/lib/usage.ts';

const status = (change: Partial<BudgetStatus> = {}): BudgetStatus => ({
  scope: 'agent',
  agentId: 'ag_hardac',
  name: 'Hardac',
  month: '2026-10',
  monthName: 'October',
  monthlyUsd: 20,
  onExceed: 'stop',
  spentUsd: 5,
  unpricedRequests: 0,
  percent: 25,
  state: 'ok',
  blocked: false,
  ...change,
});

describe('money', () => {
  it('writes budgets the way people say them', () => {
    expect(dollars(20)).toBe('$20');
    expect(dollars(20.5)).toBe('$20.50');
    expect(dollars(1234)).toBe('$1,234');
    expect(dollars(0.01)).toBe('$0.01');
  });

  it('writes what is spent with cents, small amounts as under a cent', () => {
    expect(spent(0.9)).toBe('$0.90');
    expect(spent(17.3)).toBe('$17.30');
    expect(spent(0)).toBe('$0.00');
    expect(spent(0.0004)).toBe('<$0.01');
    expect(spent(1234.5)).toBe('$1,234.50');
  });

  it('does not say 100% before it is', () => {
    expect(percentText(87.4)).toBe('87%');
    expect(percentText(99.9)).toBe('99%');
    expect(percentText(100)).toBe('100%');
    expect(percentText(140.2)).toBe('140%');
  });
});

describe('budgetNotice', () => {
  const overview = (agents: BudgetStatus[], app: BudgetStatus | null = null): BudgetOverview => ({
    app,
    agents,
  });

  it('says nothing while a budget is fine, or there is none', () => {
    expect(budgetNotice('ag_hardac', undefined)).toBeNull();
    expect(budgetNotice('ag_hardac', overview([]))).toBeNull();
    expect(budgetNotice('ag_hardac', overview([status()]))).toBeNull();
    // Another agent's budget isn't this one's.
    expect(
      budgetNotice('ag_other', overview([status({ state: 'over', blocked: true, percent: 120 })])),
    ).toBeNull();
  });

  it('warns at 80%', () => {
    const notice = budgetNotice('ag_hardac', overview([status({ state: 'near', percent: 85 })]));
    expect(notice?.kind).toBe('near');
    expect(notice?.text).toBe('Hardac has used 85% of its $20 budget for October.');
  });

  it('says a warn-only budget keeps working', () => {
    const notice = budgetNotice(
      'ag_hardac',
      overview([status({ state: 'over', onExceed: 'warn', percent: 117, spentUsd: 23.4 })]),
    );
    expect(notice?.kind).toBe('over');
    expect(notice?.text).toBe(
      'Hardac is over its $20 budget for October ($23.40 spent). It keeps working.',
    );
  });

  it('says a stopped agent takes no new messages', () => {
    const notice = budgetNotice(
      'ag_hardac',
      overview([status({ state: 'over', blocked: true, percent: 100, spentUsd: 20 })]),
    );
    expect(notice?.kind).toBe('stopped');
    expect(notice?.text).toBe(
      "Hardac reached its $20 budget for October. It can't take new messages until you raise its budget.",
    );
  });

  it('puts the app budget in front when it is the worse of the two', () => {
    const app = status({
      scope: 'app',
      agentId: undefined,
      name: 'Pi Local',
      monthlyUsd: 50,
      state: 'over',
      blocked: true,
      percent: 104,
    });
    const notice = budgetNotice(
      'ag_hardac',
      overview([status({ state: 'near', percent: 90 })], app),
    );
    expect(notice?.kind).toBe('stopped');
    expect(notice?.status.scope).toBe('app');
    expect(notice?.text).toBe(
      'Pi Local reached its $50 budget for October. No agent can take new messages until you raise it.',
    );
  });
});

describe('budget amounts', () => {
  it('accepts dollars from a cent to a million', () => {
    expect(parseBudgetAmount('20')).toBe(20);
    expect(parseBudgetAmount(' $20.50 ')).toBe(20.5);
    expect(parseBudgetAmount('1,000')).toBe(1000);
    expect(parseBudgetAmount('0.01')).toBe(0.01);
    expect(parseBudgetAmount('1000000')).toBe(1_000_000);
  });

  it('refuses the rest', () => {
    for (const text of ['', '0', '-5', 'ten', '1.234', '1000001', '2e3', '$']) {
      expect(parseBudgetAmount(text), text).toBeNull();
    }
  });

  it('compares budgets', () => {
    expect(sameBudget(null, undefined)).toBe(true);
    expect(sameBudget({ monthlyUsd: 5, onExceed: 'stop' }, null)).toBe(false);
    expect(
      sameBudget({ monthlyUsd: 5, onExceed: 'stop' }, { monthlyUsd: 5, onExceed: 'stop' }),
    ).toBe(true);
    expect(
      sameBudget({ monthlyUsd: 5, onExceed: 'stop' }, { monthlyUsd: 5, onExceed: 'warn' }),
    ).toBe(false);
  });
});

describe('the usage query', () => {
  it('asks for days, or a month, and leaves empty filters out', () => {
    expect(usageQueryString({ days: 7 })).toBe('days=7');
    expect(usageQueryString({})).toBe('days=30');
    expect(usageQueryString({ month: '2026-10', days: 7 })).toBe('month=2026-10');
    expect(usageQueryString({ days: 30, agent: 'ag_x', model: 'fake/fast-1' })).toBe(
      'days=30&agent=ag_x&model=fake%2Ffast-1',
    );
    expect(usageQueryString({ days: 30, agent: '', model: '' })).toBe('days=30');
  });

  it('moves between months, over the year', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-10', 0)).toBe('2026-10');
    expect(shiftMonth('nonsense', 1)).toBe('nonsense');
  });

  it('names a month', () => {
    expect(monthLabel('2026-10')).toBe('October 2026');
    expect(monthLabel('x')).toBe('x');
  });
});
