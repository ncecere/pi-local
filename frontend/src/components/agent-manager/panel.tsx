import type { ReactNode } from 'react';
import { toast } from 'sonner';
import type { Agent } from '~/api/client';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { cn } from '~/lib/utils';

/** A titled block of the agent manager. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn('rounded-xl border border-[var(--border-subtle)] px-4 py-4 sm:px-5', className)}
    >
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold">{title}</h3>}
            {description && (
              <p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** "Rex saved.", and that it restarts when it was awake. */
export function agentSavedMessage(before: Pick<Agent, 'running'>, saved: Pick<Agent, 'name'>) {
  return before.running
    ? `${saved.name} saved. It restarts with the change.`
    : `${saved.name} saved.`;
}

/**
 * Saves a change to an agent and says so. A saved change bumps the agent's
 * revision, and the tab's form (keyed by it) is drawn again from scratch, so
 * a `mutate` callback would be dropped with the old form: the promise of
 * `mutateAsync` is kept instead. A failure stays on the mutation, for the
 * form to show.
 */
export function saveAgentChange(
  before: Pick<Agent, 'running'>,
  save: () => Promise<Agent>,
  after?: (saved: Agent) => void,
) {
  void save().then(
    (saved) => {
      toast(agentSavedMessage(before, saved));
      after?.(saved);
    },
    () => undefined,
  );
}

/** A name and its value, in a two-column list of facts. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-[var(--text-muted)]">{label}</dt>
      <dd className="min-w-0 text-sm text-[var(--text-primary)]">{children}</dd>
    </div>
  );
}

/** Save and Reset for a form whose changes are not saved yet. */
export function SaveBar({
  dirty,
  busy,
  disabled,
  onSave,
  onReset,
  saveLabel = 'Save',
}: {
  dirty: boolean;
  busy: boolean;
  disabled?: boolean;
  onSave: () => void;
  onReset: () => void;
  saveLabel?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="primary"
        disabled={!dirty || busy || disabled}
        onClick={onSave}
      >
        {busy && <Spinner className="size-4 text-current" />}
        {saveLabel}
      </Button>
      {dirty && (
        <Button type="button" variant="ghost" disabled={busy} onClick={onReset}>
          Undo changes
        </Button>
      )}
    </div>
  );
}
