import { Link } from '@tanstack/react-router';
import { History, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type ChatMessage, errorMessage } from '~/api/client';
import { OutcomeBadge } from '~/components/activity/activity-list';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { FOCUS_RING } from '~/components/ui/focus-ring';
import { Spinner } from '~/components/ui/spinner';
import { useThreadActivity } from '~/hooks/use-activity';
import { formatDuration, KIND_LABEL } from '~/lib/activity';
import { formatExact, formatTimeSeconds } from '~/lib/dates';
import { cn } from '~/lib/utils';
import { buildTimeline, type TimelineStep, timelineSummary } from '~/lib/what-happened';

function Step({ step }: { step: TimelineStep }) {
  const mono = step.kind === 'tool';
  return (
    <li
      data-step-kind={step.kind}
      className="flex gap-3 border-b border-[var(--border-subtle)] py-3 last:border-b-0"
    >
      <time
        dateTime={new Date(step.at).toISOString()}
        title={formatExact(step.at)}
        className="w-[4.75rem] shrink-0 pt-0.5 text-xs tabular-nums text-[var(--text-muted)]"
      >
        {step.at ? formatTimeSeconds(step.at) : ''}
      </time>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span
            className={cn(
              'min-w-0 break-words font-medium text-[var(--text-primary)]',
              mono && 'font-mono text-[0.8125rem]',
            )}
          >
            {step.title}
          </span>
          {step.kind !== 'tool' && step.kind !== 'message' && step.kind !== 'reply' && (
            <span className="rounded-md border border-[var(--border-subtle)] px-1.5 py-0.5 text-xs font-normal text-[var(--text-muted)]">
              {KIND_LABEL[step.kind]}
            </span>
          )}
        </p>
        {step.line && (
          <p
            className={cn(
              'mt-1 break-words text-xs text-[var(--text-secondary)]',
              mono && 'font-mono',
            )}
          >
            {step.line}
          </p>
        )}
        {step.note && (
          <p className="mt-1 break-words text-xs text-[var(--text-muted)]">{step.note}</p>
        )}
        {step.link && (
          <Link
            to="/agents/$agentId/threads/$threadId"
            params={step.link}
            className="mt-1 inline-block text-xs text-[var(--text-secondary)] underline decoration-[var(--border-strong)] underline-offset-4 hover:text-[var(--text-primary)]"
          >
            Open their conversation
          </Link>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {step.outcome && step.outcome !== 'ok' && <OutcomeBadge outcome={step.outcome} />}
        {step.durationMs !== undefined && (
          <span className="text-xs tabular-nums text-[var(--text-muted)]">
            {formatDuration(step.durationMs)}
          </span>
        )}
      </div>
    </li>
  );
}

function Timeline({
  agentId,
  threadId,
  messages,
  hasEarlier,
  busy,
}: {
  agentId: string;
  threadId: string;
  messages: readonly ChatMessage[];
  hasEarlier: boolean;
  busy: boolean;
}) {
  const activity = useThreadActivity(agentId, threadId, { live: busy });
  const steps = useMemo(
    () => buildTimeline(messages, activity.data?.items ?? [], { hasEarlier }),
    [messages, activity.data, hasEarlier],
  );
  const summary = timelineSummary(steps);
  // Without the log the view's own steps still show; only how each call ended is missing, and the log may just be slow.
  return (
    <div>
      {activity.isError && (
        <p
          role="alert"
          className="mb-2 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
        >
          {errorMessage(activity.error, 'The activity log could not be read.')} These steps come
          from the conversation alone.
        </p>
      )}
      {activity.isPending && !activity.isError && steps.length === 0 ? (
        <div className="py-8">
          <Spinner className="mx-auto" />
        </div>
      ) : steps.length === 0 ? (
        <p className="py-6 text-sm text-[var(--text-muted)]">
          Nothing has happened in this conversation yet.
        </p>
      ) : (
        <>
          <p className="pb-2 text-xs text-[var(--text-muted)]" data-timeline-summary="">
            {summary}
          </p>
          <ol aria-label="Steps">
            {steps.map((step) => (
              <Step key={step.id} step={step} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

/**
 * A button for the conversation that opens "What happened": its steps in order, with the time of each, how long it
 * took and how it ended: the messages, each tool call (with what the person decided about it), the schedule runs,
 * asks, errors and budget refusals. From the conversation's own messages and tool calls, and the activity log.
 */
export function WhatHappened({
  agentId,
  threadId,
  messages,
  hasEarlier,
  busy,
  below = false,
}: {
  agentId: string;
  threadId: string;
  messages: readonly ChatMessage[];
  hasEarlier: boolean;
  busy: boolean;
  /** Another floating button (the documents') is at the top: sit under it. */
  below?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-floating-controls
        onClick={() => setOpen(true)}
        className={cn(
          'absolute right-2 z-20 flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-pill)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] shadow-sm hover:text-[var(--text-primary)]',
          below ? 'top-[7.25rem]' : 'top-[4.5rem]',
          FOCUS_RING,
        )}
      >
        <History className="size-3.5" aria-hidden="true" />
        What happened
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          closeButton={false}
          className="left-auto right-0 top-0 h-full w-[min(26rem,100%)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none border-y-0 border-r-0 p-0"
        >
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-3">
            <DialogTitle className="flex-1 text-sm">What happened</DialogTitle>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className={cn(
                'rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]',
                FOCUS_RING,
              )}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <DialogDescription className="px-4 pt-3 text-xs text-[var(--text-muted)]">
            The steps of this conversation, with the time of each and how long it took.
          </DialogDescription>
          <div className="px-4 pb-4">
            {open && (
              <Timeline
                agentId={agentId}
                threadId={threadId}
                messages={messages}
                hasEarlier={hasEarlier}
                busy={busy}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
