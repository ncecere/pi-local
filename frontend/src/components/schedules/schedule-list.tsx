import { Link } from '@tanstack/react-router';
import {
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  Zap,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import {
  type Agent,
  errorMessage,
  type Schedule,
  type ScheduleRun,
  type ScheduleRunStatus,
} from '~/api/client';
import { ConfirmDialog, ErrorNotice } from '~/components/models/fields';
import { ScheduleDialog } from '~/components/schedules/schedule-dialog';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import {
  useDeleteSchedule,
  useRunSchedule,
  useScheduleRuns,
  useUpdateSchedule,
} from '~/hooks/use-schedules';
import {
  formatDateTime,
  lastRunLabel,
  madeByLabel,
  nextFireLabel,
  runStatusLabel,
  type ScheduleState,
  scheduleStatus,
  whenLabel,
} from '~/lib/schedules';
import { cn } from '~/lib/utils';

const STATE_TONE: Record<ScheduleState, string> = {
  active: 'text-[var(--success)]',
  running: 'text-[var(--status-working)]',
  paused: 'text-[var(--warning)]',
  finished: 'text-[var(--text-muted)]',
};

const RUN_ICON: Record<ScheduleRunStatus, typeof CircleCheck> = {
  running: CircleDashed,
  done: CircleCheck,
  failed: CircleAlert,
};
const RUN_TONE: Record<ScheduleRunStatus, string> = {
  running: 'text-[var(--status-working)]',
  done: 'text-[var(--success)]',
  failed: 'text-[var(--danger)]',
};

/** The time now, ticking each half minute: "in 5 minutes" stays true. */
function useNow(every = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

const threadLink = (agentId: string, threadId: string) => ({
  to: '/agents/$agentId/threads/$threadId' as const,
  params: { agentId, threadId },
});

const LINK =
  'text-[var(--text-primary)] underline decoration-[var(--border-strong)] underline-offset-4 hover:decoration-current';

function RunHistory({ schedule }: { schedule: Schedule }) {
  const runs = useScheduleRuns(schedule.id);
  const now = useNow();
  if (runs.isPending)
    return (
      <div className="py-3">
        <Spinner className="mx-auto" />
      </div>
    );
  if (runs.isError)
    return <ErrorNotice>{errorMessage(runs.error, 'The runs could not be loaded.')}</ErrorNotice>;
  if (runs.data.length === 0)
    return <p className="py-2 text-sm text-[var(--text-muted)]">It hasn't run yet.</p>;
  return (
    <ol aria-label={`Runs of ${schedule.name}`} className="flex flex-col gap-1">
      {runs.data.map((run: ScheduleRun) => {
        const Icon = RUN_ICON[run.status];
        const took =
          run.finishedAt !== null
            ? Math.max(0, Math.round((run.finishedAt - run.firedAt) / 1000))
            : null;
        return (
          <li key={run.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <span
              className={cn(
                'flex items-center gap-1 self-center text-xs font-medium',
                RUN_TONE[run.status],
              )}
            >
              <Icon
                className={cn(
                  'size-3.5',
                  run.status === 'running' && 'motion-safe:animate-[spin_3s_linear_infinite]',
                )}
                aria-hidden="true"
              />
              {runStatusLabel(run.status)}
            </span>
            <span
              className="tabular-nums text-[var(--text-secondary)]"
              title={new Date(run.firedAt).toLocaleString()}
            >
              {formatDateTime(run.firedAt, Intl.DateTimeFormat().resolvedOptions().timeZone, now)}
            </span>
            {took !== null && (
              <span className="text-xs text-[var(--text-muted)]">
                {took < 60 ? `${took}s` : `${Math.round(took / 60)} min`}
              </span>
            )}
            <Link {...threadLink(schedule.agentId, run.threadId)} className={cn(LINK, 'text-xs')}>
              Open conversation
            </Link>
            {run.error && (
              <span className="basis-full text-xs text-[var(--danger-on-tint)]">{run.error}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ScheduleRow({
  schedule,
  showAgent,
  now,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  showAgent: boolean;
  now: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const run = useRunSchedule();
  const update = useUpdateSchedule();
  const status = scheduleStatus(schedule);
  const last = schedule.lastRun;

  const runNow = () =>
    run.mutate(schedule.id, {
      onSuccess: () => toast(`${schedule.name} is running.`),
      onError: (error) => toast.error(errorMessage(error, "It couldn't be run.")),
    });
  const togglePause = () =>
    update.mutate(
      { id: schedule.id, paused: !schedule.paused },
      {
        onSuccess: (saved) =>
          toast(saved.paused ? `${saved.name} paused.` : `${saved.name} resumed.`),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-runs`}
          aria-label={`${open ? 'Hide' : 'Show'} the runs of ${schedule.name}`}
          title="Runs"
          onClick={() => setOpen(!open)}
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]"
        >
          <ChevronRight
            className={cn(
              'size-4 transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
            aria-hidden="true"
          />
        </button>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate text-sm font-medium">{schedule.name}</span>
            <span className={cn('text-xs font-medium', STATE_TONE[status.state])}>
              {status.label}
            </span>
            {schedule.madeBy === 'agent' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-control)] px-1.5 py-0.5 text-[0.6875rem] text-[var(--text-secondary)]">
                <Bot className="size-3" aria-hidden="true" />
                Set by the agent
              </span>
            )}
          </p>
          <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
            {whenLabel(schedule, { now })}
          </p>
          <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs text-[var(--text-muted)] sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
            {showAgent && (
              <>
                <dt>Agent</dt>
                <dd className="truncate">
                  <Link
                    to="/settings/agents/$agentId"
                    params={{ agentId: schedule.agentId }}
                    search={{ tab: 'schedules' }}
                    className={LINK}
                  >
                    {schedule.agentName}
                  </Link>
                </dd>
              </>
            )}
            <dt>Next</dt>
            <dd
              className="truncate"
              title={
                schedule.nextFireAt ? new Date(schedule.nextFireAt).toLocaleString() : undefined
              }
            >
              {nextFireLabel(schedule, now)}
            </dd>
            <dt>Last run</dt>
            <dd className="truncate">
              {last ? (
                <Link {...threadLink(schedule.agentId, last.threadId)} className={LINK}>
                  {lastRunLabel(last, now)}
                </Link>
              ) : (
                'Not yet'
              )}
            </dd>
            <dt>Made by</dt>
            <dd className="truncate">
              {madeByLabel(schedule)}
              {schedule.madeBy === 'agent' && schedule.originThreadId && (
                <>
                  {', in '}
                  <Link {...threadLink(schedule.agentId, schedule.originThreadId)} className={LINK}>
                    a conversation
                  </Link>
                </>
              )}
            </dd>
            <dt>Runs in</dt>
            <dd className="truncate">
              {schedule.threadMode === 'this' && schedule.threadId ? (
                <Link {...threadLink(schedule.agentId, schedule.threadId)} className={LINK}>
                  the same conversation
                </Link>
              ) : (
                'a new conversation each time'
              )}
            </dd>
          </dl>
          {status.state === 'paused' && status.detail && (
            <p className="mt-1.5 text-xs text-[var(--warning)]">
              {status.detail} Resume it to try again.
            </p>
          )}
          {last?.status === 'failed' && last.error && status.state !== 'paused' && (
            <p className="mt-1.5 text-xs text-[var(--danger-on-tint)]">Last run: {last.error}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Run ${schedule.name} now`}
            title="Run now"
            disabled={run.isPending}
            onClick={runNow}
          >
            {run.isPending ? <Spinner className="size-4" /> : <Zap />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${schedule.paused ? 'Resume' : 'Pause'} ${schedule.name}`}
            title={schedule.paused ? 'Resume' : 'Pause'}
            disabled={update.isPending}
            onClick={togglePause}
          >
            {schedule.paused ? <Play /> : <Pause />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${schedule.name}`}
            title="Edit"
            onClick={onEdit}
          >
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${schedule.name}`}
            title="Delete"
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <div id={`${id}-runs`} hidden={!open} className="mt-2 pl-9">
        {open && <RunHistory schedule={schedule} />}
      </div>
    </li>
  );
}

/**
 * Schedules with their actions (run now, pause, edit, delete, the runs), and
 * "New schedule". On one agent's page `agentId` fixes whose they are.
 */
export function ScheduleList({
  schedules,
  agents,
  agentId,
  emptyText,
}: {
  schedules: Schedule[];
  agents: Agent[];
  /** One agent's page: new schedules are its own, and rows don't name it. */
  agentId?: string;
  emptyText: string;
}) {
  const now = useNow();
  const remove = useDeleteSchedule();
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);

  return (
    <>
      {schedules.length > 0 ? (
        <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
          {schedules.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              showAgent={!agentId}
              now={now}
              onEdit={() => setEditing(schedule)}
              onDelete={() => setDeleting(schedule)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-[var(--text-muted)]">{emptyText}</p>
      )}
      <div>
        <Button
          variant="primary"
          disabled={agents.length === 0}
          title={agents.length === 0 ? 'Make an agent first.' : undefined}
          onClick={() => setEditing('new')}
        >
          <Plus />
          New schedule
        </Button>
      </div>

      {editing && (
        <ScheduleDialog
          schedule={editing === 'new' ? null : editing}
          agents={agents}
          agentId={agentId}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          description="It won't run again. The conversations it ran in stay."
          action="Delete"
          what={deleting.name}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toast(`${deleting.name} deleted.`);
          }}
        />
      )}
    </>
  );
}
