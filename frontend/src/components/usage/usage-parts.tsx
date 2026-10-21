import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UsageTotals } from '~/api/client';
import { formatDayKey } from '~/lib/dates';
import {
  barHeights,
  cachedOf,
  costOf,
  monthKey,
  monthLabel,
  shiftMonth,
  tokensOf,
  USAGE_RANGES,
  type UsageRange,
} from '~/lib/usage';
import { cn } from '~/lib/utils';

/** The pieces of Settings → Usage (ported from Pi Agent Interface). */

export const compact = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});
export const whole = new Intl.NumberFormat();

/** A cost estimate; a dash when none of it is priced, a "+" when some is not. */
export function Cost({ totals }: { totals: UsageTotals }) {
  const cost = costOf(totals);
  if (cost.text === '—')
    return (
      <span className="text-[var(--text-muted)]" title="Its models have no prices">
        —<span className="sr-only">no prices</span>
      </span>
    );
  return (
    <span
      title={
        cost.partial
          ? `Not counting ${whole.format(totals.unpricedRequests)} requests to models without prices`
          : undefined
      }
    >
      {cost.text}
      {cost.partial && (
        <>
          <span aria-hidden className="text-[var(--text-muted)]">
            +
          </span>
          <span className="sr-only"> plus unpriced requests</span>
        </>
      )}
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 p-4 sm:p-5">
      <p className="truncate text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </p>
      <p className="mt-2 truncate text-xl font-semibold tabular-nums sm:text-2xl">{value}</p>
      {hint && <p className="mt-1 text-xs text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}

/** Up to four stats in a bordered strip; two columns on narrow screens. */
export function StatStrip({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-[var(--border-subtle)] lg:grid-cols-4 [&>*]:border-[var(--border-subtle)] [&>*:nth-child(even)]:border-l [&>*:nth-child(n+3)]:border-t lg:[&>*:nth-child(n+2)]:border-l lg:[&>*:nth-child(n+3)]:border-t-0">
      {children}
    </div>
  );
}

/** Requests, tokens, cost. */
export function TotalsStats({ total }: { total: UsageTotals }) {
  const cached = cachedOf(total);
  return (
    <>
      <Stat label="Requests" value={whole.format(total.requests)} />
      <Stat
        label="Tokens"
        value={compact.format(tokensOf(total))}
        hint={[
          `${compact.format(total.inputTokens)} in`,
          `${compact.format(total.outputTokens)} out`,
          ...(cached ? [`${compact.format(cached)} cache`] : []),
        ].join(' · ')}
      />
      <Stat label="Estimated cost" value={<Cost totals={total} />} />
    </>
  );
}

export function RangePicker({
  value,
  onChange,
}: {
  value: UsageRange;
  onChange: (range: UsageRange) => void;
}) {
  return (
    <fieldset className="flex rounded-lg border border-[var(--border-subtle)] p-0.5">
      <legend className="sr-only">Period</legend>
      {USAGE_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          aria-pressed={value === range}
          onClick={() => onChange(range)}
          className={cn(
            'rounded-md px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-bright)]',
            value === range
              ? 'bg-[var(--bg-control)] font-medium text-[var(--text-primary)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
          )}
        >
          {range} days
        </button>
      ))}
    </fieldset>
  );
}

/** Tokens per day as bars, the busiest day full height. */
export function DailyBars({
  days,
  from,
  to,
}: {
  days: Array<UsageTotals & { day: string }>;
  from: string;
  to: string;
}) {
  const heights = barHeights(days.map(tokensOf));
  return (
    <>
      <p className="mb-2 text-xs text-[var(--text-muted)]">
        {days.some((day) => tokensOf(day) > 0)
          ? 'Input, output and cached tokens. Bars are scaled to the busiest day.'
          : 'No token usage in this period.'}
      </p>
      <div className="flex h-36 items-end gap-px rounded-xl border border-[var(--border-subtle)] px-3 pt-3 pb-2">
        {days.map((day, index) => {
          const tokens = tokensOf(day);
          const height = heights[index] ?? 0;
          const label = `${formatDayKey(day.day)}: ${whole.format(tokens)} tokens, ${whole.format(day.requests)} requests`;
          return (
            <div
              key={day.day}
              role="img"
              aria-label={label}
              title={label}
              className="flex h-full flex-1 items-end"
            >
              <div
                className={cn(
                  'w-full rounded-t-sm',
                  tokens
                    ? 'bg-[var(--accent-bright)]/70 hover:bg-[var(--accent-bright)]'
                    : 'bg-[var(--border-subtle)]',
                )}
                style={{ height: tokens ? `${Math.max(3, height)}%` : '1px' }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-xs text-[var(--text-muted)]">
        <span>{formatDayKey(from)}</span>
        <span>{formatDayKey(to)}</span>
      </div>
    </>
  );
}

/** Requests, tokens and cost per row: per agent, or per model. */
export function UsageTable<T extends UsageTotals & { name: string }>({
  label,
  rows,
  rowKey,
  detail,
  plainDetail,
  onPick,
}: {
  /** The first column's heading: "Agent", "Model". */
  label: string;
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** A muted second line under the name (a model's ID, say). */
  detail?: (row: T) => string | undefined;
  /** The detail is a sentence, not an ID: not set in the code font. */
  plainDetail?: boolean;
  /** Makes the name a button that narrows the page to this row. */
  onPick?: (row: T) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
          <tr className="border-b border-[var(--border-subtle)]">
            <th scope="col" className="px-4 py-2.5 font-medium">
              {label}
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">
              Requests
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">
              Input tokens
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">
              Output tokens
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">
              Cached tokens
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">
              Est. cost
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-subtle)] tabular-nums">
          {rows.map((row) => {
            const extra = detail?.(row);
            return (
              <tr key={rowKey(row)}>
                <th scope="row" className="px-4 py-2.5 text-left font-medium">
                  {onPick ? (
                    <button
                      type="button"
                      onClick={() => onPick(row)}
                      title={`Show only ${row.name}`}
                      className="block text-left font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-bright)]"
                    >
                      {row.name}
                    </button>
                  ) : (
                    <span className="block">{row.name}</span>
                  )}
                  {extra && (
                    <span
                      className={cn(
                        'block text-xs font-normal text-[var(--text-muted)]',
                        !plainDetail && 'font-mono',
                      )}
                    >
                      {extra}
                    </span>
                  )}
                </th>
                <td className="px-4 py-2.5 text-right">{whole.format(row.requests)}</td>
                <td className="px-4 py-2.5 text-right">{compact.format(row.inputTokens)}</td>
                <td className="px-4 py-2.5 text-right">{compact.format(row.outputTokens)}</td>
                <td
                  className="px-4 py-2.5 text-right"
                  title={`${whole.format(row.cacheReadTokens)} read · ${whole.format(row.cacheWriteTokens)} written`}
                >
                  {compact.format(cachedOf(row))}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Cost totals={row} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** What period the Usage page shows: the last days, or one calendar month. */
export type UsageView = { kind: 'days'; days: UsageRange } | { kind: 'month'; month: string };

/** 7, 30 or 90 days, or a month (with arrows to the months before and after). */
export function PeriodPicker({
  value,
  onChange,
  now = new Date(),
}: {
  value: UsageView;
  onChange: (view: UsageView) => void;
  now?: Date;
}) {
  const thisMonth = monthKey(now);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <fieldset className="flex rounded-lg border border-[var(--border-subtle)] p-0.5">
        <legend className="sr-only">Period</legend>
        {USAGE_RANGES.map((range) => {
          const on = value.kind === 'days' && value.days === range;
          return (
            <button
              key={range}
              type="button"
              aria-pressed={on}
              onClick={() => onChange({ kind: 'days', days: range })}
              className={cn(PERIOD_BUTTON, on ? PERIOD_ON : PERIOD_OFF)}
            >
              {range} days
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={value.kind === 'month'}
          onClick={() => onChange({ kind: 'month', month: thisMonth })}
          className={cn(PERIOD_BUTTON, value.kind === 'month' ? PERIOD_ON : PERIOD_OFF)}
        >
          Month
        </button>
      </fieldset>
      {value.kind === 'month' && (
        <fieldset className="m-0 flex items-center gap-1 border-0 p-0">
          <legend className="sr-only">Month</legend>
          <button
            type="button"
            aria-label="The month before"
            onClick={() => onChange({ kind: 'month', month: shiftMonth(value.month, -1) })}
            className={ARROW}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
          <span className="min-w-28 text-center text-sm font-medium tabular-nums">
            {monthLabel(value.month)}
          </span>
          <button
            type="button"
            aria-label="The month after"
            disabled={value.month >= thisMonth}
            onClick={() => onChange({ kind: 'month', month: shiftMonth(value.month, 1) })}
            className={cn(ARROW, 'disabled:opacity-30')}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        </fieldset>
      )}
    </div>
  );
}

const PERIOD_BUTTON =
  'rounded-md px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-bright)]';
const PERIOD_ON = 'bg-[var(--bg-control)] font-medium text-[var(--text-primary)]';
const PERIOD_OFF = 'text-[var(--text-muted)] hover:text-[var(--text-primary)]';
const ARROW =
  'rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-bright)]';
