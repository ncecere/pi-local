import type { AgentBudget, BudgetOverview, BudgetStatus } from '~/api/types';

/** Dollars the way people say them: $20, $20.50, $1,234. */
export function dollars(value: number): string {
  const cents = Math.round(value * 100);
  const whole = Math.trunc(cents / 100).toLocaleString('en-US');
  return cents % 100 === 0
    ? `$${whole}`
    : `$${whole}.${String(Math.abs(cents % 100)).padStart(2, '0')}`;
}

/** Small spending keeps mills visible; larger amounts show cents. */
export function spent(value: number): string {
  if (value > 0 && value < 0.0005) return '<$0.001';
  const digits = value > 0 && value < 1 ? 3 : 2;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** The percent used, whole, for display ("87%"); never "100%" until it is. */
export function percentText(percent: number): string {
  if (percent >= 100) return `${Math.round(percent)}%`;
  return `${Math.min(99, Math.floor(percent))}%`;
}

/** "Hardac reached its $20 budget for October." */
export function reachedText(status: BudgetStatus): string {
  return `${status.name} reached its ${dollars(status.monthlyUsd)} budget for ${status.monthName}.`;
}

export type BudgetNotice = {
  /** "stopped": new work is refused; "over": past the limit but only a warning; "near": at 80% or more. */
  kind: 'stopped' | 'over' | 'near';
  status: BudgetStatus;
  text: string;
};

/**
 * What a conversation should say about budgets for its agent: the most serious of the agent's own budget and the
 * app's, or nothing when both are fine (or there are none).
 */
export function budgetNotice(
  agentId: string,
  overview: BudgetOverview | undefined,
): BudgetNotice | null {
  if (!overview) return null;
  const candidates = [overview.agents.find((s) => s.agentId === agentId), overview.app].filter(
    (s): s is BudgetStatus => Boolean(s) && s?.state !== 'ok',
  );
  const rank = (s: BudgetStatus) => (s.blocked ? 3 : s.state === 'over' ? 2 : 1);
  const worst = [...candidates].sort((a, b) => rank(b) - rank(a))[0];
  if (!worst) return null;
  const app = worst.scope === 'app';
  if (worst.blocked)
    return {
      kind: 'stopped',
      status: worst,
      text: `${reachedText(worst)} ${app ? 'No agent can' : "It can't"} take new messages until you raise ${app ? 'it' : 'its budget'}.`,
    };
  if (worst.state === 'over')
    return {
      kind: 'over',
      status: worst,
      text: `${worst.name} is over its ${dollars(worst.monthlyUsd)} budget for ${worst.monthName} (${spent(worst.spentUsd)} spent). ${app ? 'Agents keep' : 'It keeps'} working.`,
    };
  return {
    kind: 'near',
    status: worst,
    text: `${worst.name} has used ${percentText(worst.percent)} of its ${dollars(worst.monthlyUsd)} budget for ${worst.monthName}.`,
  };
}

/** What a budget's amount field accepts: dollars, at least a cent. */
export function parseBudgetAmount(text: string): number | null {
  // One decimal separator, never silently treat a decimal comma as thousands.
  const cleaned = text.trim().replace(/^\$/, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value >= 0.01 && value <= 1_000_000 ? value : null;
}

/** Both scopes matter: raising one does not clear the other. */
export function budgetNotices(
  agentId: string,
  overview: BudgetOverview | undefined,
): BudgetNotice[] {
  if (!overview) return [];
  return [
    budgetNotice(agentId, { app: overview.app, agents: [] }),
    budgetNotice(agentId, { app: null, agents: overview.agents }),
  ].filter((notice): notice is BudgetNotice => notice !== null);
}

/** Plain editable cents, without currency or grouping. */
export const budgetAmount = (value: number): string => value.toFixed(2);

/** Whether two budgets are the same (null: none). */
export function sameBudget(a: AgentBudget | null | undefined, b: AgentBudget | null | undefined) {
  if (!a || !b) return !a && !b;
  return a.monthlyUsd === b.monthlyUsd && a.onExceed === b.onExceed;
}
