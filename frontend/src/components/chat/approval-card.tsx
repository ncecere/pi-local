import { Check, Clock, ShieldAlert, X } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, type ChatApproval, errorMessage } from '~/api/client';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useDecideApproval } from '~/hooks/use-approvals';
import { approvalOutcome, argumentsView, expiresIn } from '~/lib/approvals';
import { cn } from '~/lib/utils';

/** A code-like block, readable in both themes. */
const BLOCK =
  'max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--border-inset)] bg-[var(--bg-inset)] px-2.5 py-2 font-mono text-xs leading-relaxed text-[var(--text-primary)]';

/** What the request asks, as a question: "Run this command?" */
function questionFor(tool: string): string {
  const name = tool.toLowerCase();
  if (name === 'bash') return 'Run this command?';
  if (name === 'write') return 'Create or replace this file?';
  if (name === 'edit') return 'Change this file?';
  return `Use ${tool}?`;
}

/** The call's arguments as the person deciding reads them (lib/approvals.ts argumentsView). */
export function ApprovalArguments({ tool, args }: { tool: string; args: unknown }) {
  const view = argumentsView(tool, args);
  switch (view.kind) {
    case 'none':
      return null;
    case 'command':
      return (
        <div className="flex flex-col gap-1">
          <pre className={BLOCK}>
            <span className="select-none text-[var(--text-muted)]" aria-hidden="true">
              ${' '}
            </span>
            <code>{view.command}</code>
          </pre>
          {(view.cwd || view.timeout !== null) && (
            <p className="text-xs text-[var(--text-muted)]">
              {view.cwd && (
                <>
                  In <span className="font-mono">{view.cwd}</span>
                </>
              )}
              {view.cwd && view.timeout !== null && ' · '}
              {view.timeout !== null && `stops after ${view.timeout}s`}
            </p>
          )}
        </div>
      );
    case 'file':
      return (
        <div className="flex flex-col gap-1.5">
          <p className="min-w-0 break-all font-mono text-xs text-[var(--text-primary)]">
            {view.path}
          </p>
          {view.preview !== null && (
            <div>
              <p className="mb-1 text-xs text-[var(--text-muted)]">
                {view.previewLabel}
                {view.clipped && ' (the start)'}
              </p>
              <pre className={BLOCK}>
                <code>
                  {view.previewLabel === 'Change'
                    ? view.preview.split('\n').map((line, index) => (
                        <span
                          // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed text
                          key={index}
                          className={cn(
                            'block',
                            line.startsWith('- ') && 'text-[var(--danger)]',
                            line.startsWith('+ ') && 'text-[var(--success)]',
                          )}
                        >
                          {line}
                        </span>
                      ))
                    : view.preview}
                  {view.clipped && <span className="text-[var(--text-muted)]">{'\n'}…</span>}
                </code>
              </pre>
            </div>
          )}
        </div>
      );
    case 'fields':
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {view.entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-[var(--text-muted)]">{key}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words font-mono text-[var(--text-primary)]">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      );
    case 'json':
      return <pre className={BLOCK}>{view.text}</pre>;
  }
}

/** The time, ticking every 30 s while something shows a countdown. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * After a decision the card goes (the view no longer has the request), so
 * focus moves on: to the next request's Approve button, or to the message box.
 */
function focusAfterDecision(card: HTMLElement | null) {
  requestAnimationFrame(() => {
    // Only when focus was on the card (or lost with it): never pull it from where the person moved it.
    const active = document.activeElement;
    if (active && active !== document.body && !card?.contains(active)) return;
    const next = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-approval-approve]'),
    ).find((button) => !card?.contains(button));
    const target =
      next ?? document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message input"]');
    target?.focus({ preventScroll: false });
  });
}

/**
 * A tool call waiting for the person, in the conversation where it was made:
 * what it would do (the command, the file and a preview), why, when the
 * request lapses, and Approve / Deny (with an optional reason the model reads).
 */
export function ApprovalCard({
  agentId,
  approval,
  args,
}: {
  agentId: string;
  approval: ChatApproval;
  /** The call's arguments when the request doesn't carry its own (redacted) copy. */
  args?: unknown;
}) {
  const decide = useDecideApproval();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const [decided, setDecided] = useState<null | 'approve' | 'deny'>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const now = useNow();
  const tool = approval.tool;
  const shown = approval.arguments !== undefined ? approval.arguments : args;

  useEffect(() => {
    if (denying) reasonRef.current?.focus();
  }, [denying]);

  const send = (decision: 'approve' | 'deny') => {
    if (decide.isPending) return;
    const card = cardRef.current;
    // A promise, not mutate's callbacks: the view often drops the request (and
    // unmounts this card) before the answer arrives, and those wouldn't run then.
    decide
      .mutateAsync({
        agentId,
        approvalId: approval.id,
        decision,
        reason: decision === 'deny' ? reason : '',
      })
      .then(
        (answer) => {
          setDecided(decision);
          toast(
            decision === 'approve'
              ? `Approved: ${tool} will run.`
              : `${approvalOutcome({ status: 'denied', reason: answer?.reason ?? reason })}. ${tool} won't run.`,
          );
          focusAfterDecision(card);
        },
        () => undefined, // said on the card (decide.error)
      );
  };

  const cancelDeny = () => {
    setDenying(false);
    setReason('');
    requestAnimationFrame(() => denyRef.current?.focus());
  };

  const onReasonKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelDeny();
    }
  };

  const decidedElsewhere =
    decide.error instanceof ApiError && decide.error.code === 'approval_decided';
  const expires = approval.expiresAt;

  return (
    <section
      ref={cardRef}
      aria-labelledby={titleId}
      data-approval-card={approval.id}
      className="my-3 flex flex-col gap-3 rounded-xl border border-[var(--warning)]/45 bg-[var(--warning)]/[0.06] px-4 py-3.5 motion-safe:animate-[row-in_150ms_ease-out]"
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p id={titleId} className="text-sm font-medium text-[var(--text-primary)]">
            {questionFor(tool)}{' '}
            <span className="font-normal text-[var(--text-muted)]">
              The agent is waiting for you to approve <span className="font-mono">{tool}</span>.
            </span>
          </p>
          {approval.summary && (
            <p className="mt-1 text-sm text-[var(--text-secondary)]">{approval.summary}</p>
          )}
        </div>
      </div>

      <ApprovalArguments tool={tool} args={shown} />

      {decide.error && (
        <p role="alert" className="text-xs text-[var(--danger-on-tint)]">
          {decidedElsewhere
            ? 'This request no longer waits: it was decided elsewhere, or it timed out.'
            : errorMessage(decide.error, "Your answer wasn't sent. Try again.")}
        </p>
      )}

      {denying ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            send('deny');
          }}
        >
          <label htmlFor={reasonId} className="text-xs font-medium text-[var(--text-secondary)]">
            Why not?{' '}
            <span className="font-normal text-[var(--text-muted)]">
              (optional: the agent reads it)
            </span>
          </label>
          <input
            ref={reasonRef}
            id={reasonId}
            value={reason}
            maxLength={1000}
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={onReasonKey}
            placeholder="Don't delete anything; list the files instead."
            className="h-9 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" variant="danger" disabled={decide.isPending}>
              {decide.isPending ? <Spinner className="size-3.5 text-current" /> : <X />}
              Deny
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={cancelDeny}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="primary"
            data-approval-approve=""
            disabled={decide.isPending || decided !== null}
            onClick={() => send('approve')}
          >
            {decide.isPending && decide.variables?.decision === 'approve' ? (
              <Spinner className="size-3.5 text-current" />
            ) : (
              <Check />
            )}
            Approve
          </Button>
          <Button
            ref={denyRef}
            type="button"
            size="sm"
            variant="secondary"
            disabled={decide.isPending || decided !== null}
            onClick={() => setDenying(true)}
          >
            <X />
            Deny…
          </Button>
          {typeof expires === 'number' && expires > 0 && (
            <span
              className="ml-auto inline-flex items-center gap-1 text-xs text-[var(--text-muted)]"
              title={new Date(expires).toLocaleString()}
            >
              <Clock className="size-3" aria-hidden="true" />
              {expires - now <= 30_000
                ? 'Expires now: denied if not answered'
                : `Denied automatically ${expiresIn(expires, now)}`}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

const OUTCOME_TONE: Record<ChatApproval['status'], string> = {
  pending: 'text-[var(--warning)]',
  approved: 'text-[var(--text-muted)]',
  denied: 'text-[var(--danger)]',
  timed_out: 'text-[var(--text-muted)]',
  cancelled: 'text-[var(--text-muted)]',
};

/** How a step's request ended, beside the step: "Approved", "Denied: reason", "Timed out". */
export function ApprovalOutcome({
  approval,
  className,
}: {
  approval: Pick<ChatApproval, 'status' | 'reason'>;
  className?: string;
}) {
  const label = approvalOutcome(approval);
  return (
    <span
      className={cn('min-w-0 truncate text-xs', OUTCOME_TONE[approval.status], className)}
      title={label}
    >
      {label}
    </span>
  );
}
