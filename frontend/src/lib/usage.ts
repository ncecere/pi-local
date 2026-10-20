import type { UsageTotals } from '~/api/types';

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

function parseDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
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
  const start = parseDay(from);
  const end = parseDay(to);
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
