import {
  Check,
  Circle,
  CircleDashed,
  CircleSlash,
  ExternalLink,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react';
import { MessageLink } from '~/components/chat/external-link-warning';
import {
  asResearchPlan,
  asResearchSource,
  asResearchSources,
  asStatusCounts,
  asTriageItem,
  asTriageQueue,
  formatJson,
  isWebUrl,
  type ResearchPlan,
  type ResearchSource,
  statusLabel,
  type TriageItem,
} from '~/lib/thread-documents';
import { cn } from '~/lib/utils';

/**
 * How exposed documents (and tools' details of the same shapes) are drawn:
 * a research plan as its steps, sources as links, a triage queue as its
 * items; anything else as formatted JSON.
 */

const STEP_ICON: Record<string, { icon: LucideIcon; className: string }> = {
  pending: { icon: Circle, className: 'text-[var(--text-faint)]' },
  running: {
    icon: LoaderCircle,
    className: 'text-[var(--accent-bright)] motion-safe:animate-spin',
  },
  done: { icon: Check, className: 'text-[var(--success,var(--accent-bright))]' },
  skipped: { icon: CircleSlash, className: 'text-[var(--text-faint)]' },
};

export function JsonView({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre
      className={cn(
        'max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/25 px-2.5 py-2 font-mono text-xs text-[var(--text-secondary)]',
        className,
      )}
    >
      {formatJson(value)}
    </pre>
  );
}

export function ResearchPlanView({ plan }: { plan: ResearchPlan }) {
  const done = plan.steps.filter((step) => step.status === 'done').length;
  return (
    <div className="space-y-2.5">
      {plan.question && (
        <p className="text-[0.8125rem] font-medium leading-snug text-[var(--text-primary)]">
          {plan.question}
        </p>
      )}
      {plan.steps.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">No steps yet.</p>
      ) : (
        <>
          <p className="text-xs text-[var(--text-muted)]">
            {done} of {plan.steps.length} steps done
          </p>
          <ol className="space-y-1.5">
            {plan.steps.map((step) => {
              const { icon: Icon, className } = STEP_ICON[step.status] ?? {
                icon: CircleDashed,
                className: 'text-[var(--text-faint)]',
              };
              return (
                <li key={step.id} className="flex gap-2 text-xs" data-step-status={step.status}>
                  <Icon className={cn('mt-0.5 size-3.5 shrink-0', className)} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'leading-snug text-[var(--text-primary)]',
                        step.status === 'skipped' && 'text-[var(--text-muted)] line-through',
                      )}
                    >
                      <span className="sr-only">{statusLabel(step.status)}: </span>
                      {step.text}
                    </p>
                    {(step.note || step.subagent) && (
                      <p className="mt-0.5 text-[var(--text-muted)]">
                        {step.subagent && (
                          <span className="mr-1.5 rounded bg-[var(--bg-control)] px-1 py-px text-[0.6875rem]">
                            {step.subagent}
                          </span>
                        )}
                        {step.note}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}

function SourceItem({ source, index }: { source: ResearchSource; index?: number }) {
  const title = source.title || source.url;
  return (
    <div className="min-w-0 text-xs">
      <p className="flex min-w-0 items-baseline gap-1.5">
        {index !== undefined && (
          <span className="shrink-0 tabular-nums text-[var(--text-faint)]">[{index}]</span>
        )}
        {isWebUrl(source.url) ? (
          <MessageLink href={source.url} className="min-w-0 font-medium" title={source.url}>
            {title}
            <ExternalLink className="ml-1 inline size-3 align-[-1px]" aria-hidden="true" />
          </MessageLink>
        ) : (
          <span className="min-w-0 break-words font-medium text-[var(--text-primary)]">
            {title}
          </span>
        )}
        {source.step && (
          <span className="shrink-0 text-[0.6875rem] text-[var(--text-faint)]">{source.step}</span>
        )}
      </p>
      {source.supports.length > 0 && (
        <ul className="mt-1 space-y-0.5 border-l border-[var(--border-subtle)] pl-2 text-[var(--text-muted)]">
          {source.supports.map((claim) => (
            <li key={claim} className="break-words leading-snug">
              {claim}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ResearchSourcesView({ sources }: { sources: ResearchSource[] }) {
  if (sources.length === 0)
    return <p className="text-xs text-[var(--text-muted)]">No sources yet.</p>;
  return (
    <ol className="space-y-2.5">
      {sources.map((source, index) => (
        <li key={source.url}>
          <SourceItem source={source} index={index + 1} />
        </li>
      ))}
    </ol>
  );
}

const TRIAGE_TONE: Record<string, string> = {
  new: 'bg-[var(--accent-soft)] text-[var(--text-primary)]',
  waiting_approval: 'bg-[var(--warning)]/20 text-[var(--text-primary)]',
  done: 'bg-[var(--bg-control)] text-[var(--text-muted)]',
  skipped: 'bg-[var(--bg-control)] text-[var(--text-faint)]',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-1.5 py-px text-[0.6875rem] font-medium',
        TRIAGE_TONE[status] ?? 'bg-[var(--bg-control)] text-[var(--text-secondary)]',
      )}
    >
      {statusLabel(status)}
    </span>
  );
}

function TriageItemView({ item }: { item: TriageItem }) {
  return (
    <div className="min-w-0 text-xs" data-triage-status={item.status}>
      <p className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 font-mono text-[var(--text-faint)]">{item.id}</span>
        {isWebUrl(item.url) ? (
          <MessageLink href={item.url} className="min-w-0 truncate font-medium">
            {item.title || item.url}
          </MessageLink>
        ) : (
          <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">
            {item.title || 'Untitled'}
          </span>
        )}
        <span className="flex-1" />
        <StatusBadge status={item.status} />
      </p>
      {(item.decision || item.labels.length > 0) && (
        <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[var(--text-muted)]">
          {item.decision && <span>{item.decision}</span>}
          {item.labels.map((label) => (
            <span
              key={label}
              className="rounded bg-[var(--bg-control)] px-1 py-px text-[0.6875rem] text-[var(--text-secondary)]"
            >
              {label}
            </span>
          ))}
        </p>
      )}
      {item.summary && (
        <p className="mt-0.5 line-clamp-3 break-words text-[var(--text-muted)]">{item.summary}</p>
      )}
    </div>
  );
}

function StatusCounts({ counts }: { counts: Record<string, number> }) {
  const shown = Object.entries(counts).filter(([, count]) => count > 0);
  if (shown.length === 0) return null;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
      {shown.map(([status, count]) => (
        <span key={status}>
          <span className="tabular-nums text-[var(--text-primary)]">{count}</span>{' '}
          {statusLabel(status).toLowerCase()}
        </span>
      ))}
    </p>
  );
}

export function TriageQueueView({ items }: { items: TriageItem[] }) {
  if (items.length === 0) return <p className="text-xs text-[var(--text-muted)]">No items yet.</p>;
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  // Open work first, then the finished ones; each by when it last changed.
  const finished = (item: TriageItem) => item.status === 'done' || item.status === 'skipped';
  const sorted = [...items].sort(
    (a, b) => Number(finished(a)) - Number(finished(b)) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
  return (
    <div className="space-y-2.5">
      <StatusCounts counts={counts} />
      <ul className="space-y-2.5">
        {sorted.map((item) => (
          <li key={item.id}>
            <TriageItemView item={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A document's value: the known kinds drawn, anything else (or a shape not recognised) as JSON. */
export function DocumentValue({ kind, value }: { kind: string; value: unknown }) {
  if (kind === 'research.plan') {
    const plan = asResearchPlan(value);
    if (plan) return <ResearchPlanView plan={plan} />;
  }
  if (kind === 'research.sources') {
    const sources = asResearchSources(value);
    if (sources) return <ResearchSourcesView sources={sources.sources} />;
  }
  if (kind === 'triage.queue') {
    const queue = asTriageQueue(value);
    if (queue) return <TriageQueueView items={queue.items} />;
  }
  return <JsonView value={value} />;
}

/**
 * A tool's details (what it reported for apps besides its text), drawn when
 * the shape is known: a research plan, a source, a triage item and counts;
 * anything else as JSON.
 */
export function ToolDetailsView({ toolName, details }: { toolName: string; details: unknown }) {
  if (toolName === 'research_plan' || toolName === 'research_step') {
    const plan = asResearchPlan(details);
    if (plan) return <ResearchPlanView plan={plan} />;
  }
  if (toolName === 'research_source') {
    const source = asResearchSource(details);
    if (source) return <SourceItem source={source} />;
  }
  if (toolName.startsWith('triage_') && details && typeof details === 'object') {
    const record = details as { item?: unknown; counts?: unknown };
    const item = record.item === undefined ? null : asTriageItem(record.item);
    const counts = asStatusCounts(record.counts);
    if (item || counts)
      return (
        <div className="space-y-2">
          {item && <TriageItemView item={item} />}
          {counts && <StatusCounts counts={counts} />}
        </div>
      );
  }
  return <JsonView value={details} />;
}
