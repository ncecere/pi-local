import type { UsageTotals } from '~/api/types';
import { dayFromKey } from '~/lib/dates';

/** The periods usage can be read for. */
export const USAGE_RANGES = [7, 30, 90] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export const emptyTotals = (): UsageTotals => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  unpricedRequests: 0,
});

/** Every token: input, output, and cache reads and writes. */
export const tokensOf = (totals: UsageTotals) =>
  totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;

export const cachedOf = (totals: UsageTotals) => totals.cacheReadTokens + totals.cacheWriteTokens;

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * The cost to show: "—" when every request went to unpriced models, otherwise
 * the dollars, `partial` when some requests are not in it. Under a cent is
 * "<$0.01" rather than a misleading "$0.00".
 */
export function costOf(totals: UsageTotals): { text: string; partial: boolean } {
  if (totals.requests > 0 && totals.unpricedRequests >= totals.requests)
    return { text: '—', partial: false };
  const text =
    totals.costUsd > 0 && totals.costUsd < 0.005 ? '<$0.01' : money.format(totals.costUsd);
  return { text, partial: totals.unpricedRequests > 0 };
}

/** YYYY-MM-DD of a local date. */
function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Every day from `from` to `to`, in order, each with its usage or zeros. The
 * API already lists every day; this keeps the chart right if one is missing.
 * Capped at 400 days.
 */
export function fillDays<T extends UsageTotals & { day: string }>(
  byDay: readonly T[],
  from: string,
  to: string,
): (UsageTotals & { day: string })[] {
  const start = dayFromKey(from);
  const end = dayFromKey(to);
  if (!start || !end || start > end) return [...byDay].sort((a, b) => a.day.localeCompare(b.day));
  const known = new Map(byDay.map((entry) => [entry.day, entry]));
  const days: (UsageTotals & { day: string })[] = [];
  for (const date = start; date <= end && days.length < 400; date.setDate(date.getDate() + 1)) {
    const key = dayKey(date);
    days.push(known.get(key) ?? { ...emptyTotals(), day: key });
  }
  return days;
}

/** Each value as a percentage of the largest (0 for none). */
export function barHeights(values: readonly number[]): number[] {
  const peak = Math.max(0, ...values);
  return values.map((value) => (peak > 0 && value > 0 ? (value / peak) * 100 : 0));
}

/** Rows most used first: by tokens, then requests, then name. */
export function byUse<T extends UsageTotals & { name: string }>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) => tokensOf(b) - tokensOf(a) || b.requests - a.requests || a.name.localeCompare(b.name),
  );
}

// ── Which usage to read: a period, an agent, a model ────────────────────────────────────────

/** What the Usage page reads: the last `days` days, or one calendar `month` ("2026-10"), optionally one agent or model. */
export interface UsageQuery {
  days?: UsageRange;
  month?: string;
  agent?: string;
  model?: string;
}

/** The query string for `GET /api/me/usage` (a month wins over days; empty filters are left out). */
export function usageQueryString(query: UsageQuery): string {
  const params = new URLSearchParams();
  if (query.month) params.set('month', query.month);
  else params.set('days', String(query.days ?? 30));
  if (query.agent) params.set('agent', query.agent);
  if (query.model) params.set('model', query.model);
  return params.toString();
}

/** "2026-10" of a date, in local time. */
export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** The month before or after ("2026-01", -1 → "2025-12"); the input unchanged when it isn't a month. */
export function shiftMonth(month: string, by: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  return monthKey(new Date(Number(match[1]), Number(match[2]) - 1 + by, 1));
}

/** "October 2026". */
export function monthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}
