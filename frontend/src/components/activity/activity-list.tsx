import { Link } from '@tanstack/react-router';
import { Download, RefreshCw, X } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  type ActivityEntry,
  type ActivityFilters,
  type ActivityKind,
  errorMessage,
} from '~/api/client';
import { ErrorNotice, FIELD } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useActivity, useExportActivity } from '~/hooks/use-activity';
import { useAgents } from '~/hooks/use-agents';
import {
  ACTIVITY_KINDS,
  ACTIVITY_OUTCOMES,
  entryLine,
  entryProblem,
  entryTitle,
  formatDuration,
  KIND_LABEL,
  outcomeLabel,
  outcomeTone,
} from '~/lib/activity';
import { formatClock, formatExact } from '~/lib/dates';
import { cn } from '~/lib/utils';

const PERIODS = [
  { id: 'all', label: 'Any time', ms: 0 },
  { id: 'hour', label: 'Last hour', ms: 3_600_000 },
  { id: 'day', label: 'Last 24 hours', ms: 24 * 3_600_000 },
  { id: 'week', label: 'Last 7 days', ms: 7 * 24 * 3_600_000 },
  { id: 'month', label: 'Last 30 days', ms: 30 * 24 * 3_600_000 },
] as const;

type PeriodId = (typeof PERIODS)[number]['id'];

const TONE = {
  good: 'bg-[var(--bg-control)] text-[var(--text-secondary)]',
  bad: 'bg-[var(--danger)]/15 text-[var(--danger-on-tint)]',
  neutral: 'bg-[var(--bg-control)] text-[var(--text-secondary)]',
} as const;

/** How an entry ended, as a badge. */
export function OutcomeBadge({ outcome }: { outcome: string }) {
  if (!outcome) return null;
  return (
    <span
      data-outcome={outcome}
      className={cn(
        'shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium',
        TONE[outcomeTone(outcome)],
      )}
    >
      {outcomeLabel(outcome)}
    </span>
  );
}

function Row({ entry, showAgent }: { entry: ActivityEntry; showAgent: boolean }) {
  const line = entryLine(entry);
  const problem = entryProblem(entry);
  const who = [showAgent && entry.agentName, entry.actor !== entry.agentName && entry.actor]
    .filter(Boolean)
    .join(' · ');
  return (
    <li
      data-kind={entry.kind}
      className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
    >
      <time
        dateTime={new Date(entry.at).toISOString()}
        title={formatExact(entry.at)}
        className="w-28 shrink-0 text-xs tabular-nums text-[var(--text-muted)] sm:pt-0.5"
      >
        {formatClock(entry.at)}
      </time>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="shrink-0 rounded-md border border-[var(--border-subtle)] px-1.5 py-0.5 text-xs text-[var(--text-muted)]">
            {KIND_LABEL[entry.kind] ?? entry.kind}
          </span>
          <span className="min-w-0 break-words font-medium text-[var(--text-primary)]">
            {entryTitle(entry)}
          </span>
        </p>
        {who && <p className="mt-0.5 text-xs text-[var(--text-muted)]">{who}</p>}
        {line && (
          <p className="mt-1 break-words font-mono text-xs text-[var(--text-secondary)]">{line}</p>
        )}
        {problem && (
          <p className="mt-1 break-words text-xs text-[var(--danger-on-tint)]">{problem}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 sm:w-56 sm:justify-end">
        <OutcomeBadge outcome={entry.outcome} />
        {entry.durationMs !== null && (
          <span className="text-xs tabular-nums text-[var(--text-muted)]">
            {formatDuration(entry.durationMs)}
          </span>
        )}
        {entry.agentId && entry.threadId && (
          <Link
            to="/agents/$agentId/threads/$threadId"
            params={{ agentId: entry.agentId, threadId: entry.threadId }}
            className="text-xs text-[var(--text-secondary)] underline decoration-[var(--border-strong)] underline-offset-4 hover:text-[var(--text-primary)]"
          >
            Open conversation
          </Link>
        )}
      </div>
    </li>
  );
}

function Filter({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-[var(--text-muted)]">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * The audit log as a list with filters and an export (Settings → Activity, and an agent's Activity tab, which fixes
 * the agent). Newest first, a page at a time.
 */
export function ActivityList({ agentId }: { agentId?: string }) {
  const id = useId();
  const agents = useAgents();
  const [agent, setAgent] = useState('');
  const [kind, setKind] = useState<ActivityKind | ''>('');
  const [outcome, setOutcome] = useState('');
  const [period, setPeriod] = useState<{ id: PeriodId; since: number }>({ id: 'all', since: 0 });
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');

  const filters = useMemo<ActivityFilters>(
    () => ({
      ...(agentId || agent ? { agent: agentId ?? agent } : {}),
      ...(kind ? { kind: [kind] } : {}),
      ...(outcome ? { outcome: [outcome] } : {}),
      ...(q ? { q } : {}),
      ...(period.since ? { since: period.since } : {}),
    }),
    [agentId, agent, kind, outcome, q, period.since],
  );
  const query = useActivity(filters);
  const exporting = useExportActivity();
  const entries = query.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = Boolean(kind || outcome || q || period.id !== 'all' || (!agentId && agent));

  const choosePeriod = (next: PeriodId) =>
    setPeriod({
      id: next,
      since: PERIODS.find((p) => p.id === next)!.ms
        ? Date.now() - PERIODS.find((p) => p.id === next)!.ms
        : 0,
    });

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setQ(search.trim());
        }}
      >
        {!agentId && (
          <Filter id={`${id}-agent`} label="Agent">
            <select
              id={`${id}-agent`}
              value={agent}
              onChange={(event) => setAgent(event.target.value)}
              className={cn(FIELD, 'h-9 w-44')}
            >
              <option value="">All agents</option>
              {agents.data?.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </Filter>
        )}
        <Filter id={`${id}-kind`} label="What">
          <select
            id={`${id}-kind`}
            value={kind}
            onChange={(event) => setKind(event.target.value as ActivityKind | '')}
            className={cn(FIELD, 'h-9 w-44')}
          >
            <option value="">Everything</option>
            {ACTIVITY_KINDS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Filter>
        <Filter id={`${id}-outcome`} label="How it ended">
          <select
            id={`${id}-outcome`}
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
            className={cn(FIELD, 'h-9 w-40')}
          >
            <option value="">Any</option>
            {ACTIVITY_OUTCOMES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Filter>
        <Filter id={`${id}-period`} label="When">
          <select
            id={`${id}-period`}
            value={period.id}
            onChange={(event) => choosePeriod(event.target.value as PeriodId)}
            className={cn(FIELD, 'h-9 w-40')}
          >
            {PERIODS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Filter>
        <Filter id={`${id}-search`} label="Search">
          <input
            id={`${id}-search`}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onBlur={() => setQ(search.trim())}
            placeholder="A tool, a word…"
            className={cn(FIELD, 'h-9 w-48')}
          />
        </Filter>
        {filtered && (
          <button
            type="button"
            onClick={() => {
              setAgent('');
              setKind('');
              setOutcome('');
              setPeriod({ id: 'all', since: 0 });
              setSearch('');
              setQ('');
            }}
            className="flex h-9 items-center gap-1 rounded-lg px-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <X className="size-4" aria-hidden="true" />
            Clear filters
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={query.isFetching}
            onClick={() => {
              // "Last 24 hours" means up to now: moving it on is part of reading again.
              const chosen = PERIODS.find((p) => p.id === period.id)!;
              if (chosen.ms) setPeriod({ id: period.id, since: Date.now() - chosen.ms });
              else void query.refetch();
            }}
          >
            <RefreshCw className={cn(query.isFetching && 'motion-safe:animate-spin')} />
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={exporting.isPending}
            onClick={() =>
              exporting.mutate(filters, {
                onSuccess: (saved) => {
                  if (saved) toast(`Saved ${saved}.`);
                },
                onError: (error) =>
                  toast.error(errorMessage(error, 'The export could not be saved.')),
              })
            }
          >
            {exporting.isPending ? <Spinner className="size-3.5 text-current" /> : <Download />}
            Export CSV
          </Button>
        </div>
      </form>

      {query.isError ? (
        <ErrorNotice>{errorMessage(query.error, 'The activity could not be loaded.')}</ErrorNotice>
      ) : query.isPending ? (
        <div className="py-12">
          <Spinner className="mx-auto" />
        </div>
      ) : entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border-subtle)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
          {filtered
            ? 'Nothing matches these filters.'
            : agentId
              ? 'Nothing yet. What this agent does shows here as it happens.'
              : 'Nothing yet. What your agents do shows here as it happens.'}
        </p>
      ) : (
        <>
          <ol
            aria-label="Activity"
            className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-xl border border-[var(--border-subtle)]"
          >
            {entries.map((entry) => (
              <Row key={entry.id} entry={entry} showAgent={!agentId} />
            ))}
          </ol>
          {query.hasNextPage && (
            <Button
              type="button"
              variant="secondary"
              className="self-center"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage && <Spinner className="size-3.5 text-current" />}
              Show older
            </Button>
          )}
        </>
      )}
    </div>
  );
}
