import { Eye, EyeOff, Plus, X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { type AgentRef, errorMessage } from '~/api/client';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { type HeaderRow, inUseAgents, listNames } from '~/lib/models';
import { cn } from '~/lib/utils';

/** A text field, as Settings → Agents draws them. */
export const FIELD =
  'h-10 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)]/60 px-3 text-sm font-normal placeholder:text-[var(--text-muted)]';

export const Optional = () => (
  <span className="font-normal text-[var(--text-muted)]">(optional)</span>
);

/** A labelled field with an optional hint under it. */
export function Field({
  id,
  label,
  hint,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-[var(--text-muted)]">
          {hint}
        </p>
      )}
    </div>
  );
}

/** A failed request, said where it happened. */
export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-sm text-[var(--danger-on-tint)]"
    >
      {children}
    </div>
  );
}

/** `409 in_use`: which agents still use it, and what to do about that. */
export function InUseNotice({ agents, what }: { agents: AgentRef[]; what: string }) {
  return (
    <ErrorNotice>
      <p>
        {agents.length === 0
          ? `${what} is in use by an agent.`
          : `${what} is in use by ${listNames(
              agents.map((agent) => agent.name),
              agents.length,
            )}.`}{' '}
        Give {agents.length === 1 ? 'that agent' : 'those agents'} another model in Settings →
        Agents first, then try again.
      </p>
    </ErrorNotice>
  );
}

/** A request's error, with `in_use` named nicely. */
export function RequestError({ error, what }: { error: unknown; what: string }) {
  if (!error) return null;
  const agents = inUseAgents(error);
  if (agents) return <InUseNotice agents={agents} what={what} />;
  return <ErrorNotice>{errorMessage(error)}</ErrorNotice>;
}

/**
 * Extra request headers as name/value rows. Values are secrets: a password
 * field, never filled in from the server.
 */
export function HeadersEditor({
  rows,
  onChange,
  noun = 'header',
  namePlaceholder = 'X-Header-Name',
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  /** What a row is, lower case: "header", "variable". */
  noun?: string;
  namePlaceholder?: string;
}) {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const id = useId();
  const [visible, setVisible] = useState<Set<number>>(new Set());
  const set = (index: number, change: Partial<HeaderRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place
        <div key={index} className="flex items-center gap-2">
          <input
            id={`${id}-name-${index}`}
            aria-label={`${Noun} ${index + 1} name`}
            value={row.name}
            onChange={(event) => set(index, { name: event.target.value })}
            placeholder={namePlaceholder}
            autoComplete="off"
            spellCheck={false}
            className={cn(FIELD, 'flex-1 font-mono text-xs')}
          />
          <input
            type={visible.has(index) ? 'text' : 'password'}
            aria-label={`${Noun} ${index + 1} value`}
            value={row.value}
            onChange={(event) => set(index, { value: event.target.value })}
            placeholder="Value"
            autoComplete="new-password"
            className={cn(FIELD, 'flex-1')}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${visible.has(index) ? 'Hide' : 'Show'} ${noun} ${index + 1} value`}
            aria-pressed={visible.has(index)}
            onClick={() =>
              setVisible((before) => {
                const next = new Set(before);
                if (next.has(index)) next.delete(index);
                else next.add(index);
                return next;
              })
            }
          >
            {visible.has(index) ? <EyeOff /> : <Eye />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${noun} ${index + 1}${row.name ? ` (${row.name})` : ''}`}
            title="Remove"
            onClick={() => {
              setVisible(new Set());
              onChange(rows.filter((_, i) => i !== index));
            }}
          >
            <X />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange([...rows, { name: '', value: '' }]);
            // Focus the new row's name once it is drawn.
            requestAnimationFrame(() =>
              document.getElementById(`${id}-name-${rows.length}`)?.focus(),
            );
          }}
        >
          <Plus />
          Add {noun}
        </Button>
      </div>
    </div>
  );
}

/**
 * "Delete this?" with the request's error (an in-use list, say) shown in the
 * dialog rather than lost in a toast.
 */
export function ConfirmDialog({
  title,
  description,
  action,
  what,
  onConfirm,
  onClose,
}: {
  title: string;
  description: ReactNode;
  action: string;
  /** "This model", for an in-use error. */
  what: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <RequestError error={error} what={what} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                onClose();
              } catch (caught) {
                setError(caught);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner className="size-4 text-current" />}
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
