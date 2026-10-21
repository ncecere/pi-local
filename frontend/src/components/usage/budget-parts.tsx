import { Link } from '@tanstack/react-router';
import { type ReactNode, useId, useState } from 'react';
import { toast } from 'sonner';
import { type AgentBudget, type BudgetStatus, errorMessage } from '~/api/client';
import { ErrorNotice, FIELD, Field } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useAppBudget, useSaveAppBudget } from '~/hooks/use-budgets';
import {
  type BudgetNotice,
  dollars,
  parseBudgetAmount,
  percentText,
  sameBudget,
  spent,
} from '~/lib/budget';
import { cn } from '~/lib/utils';

/** How much of a budget this month is used: a bar, the dollars, and what happens at the limit. */
export function BudgetMeter({ status, title }: { status: BudgetStatus; title?: ReactNode }) {
  const width = Math.min(100, Math.max(0, status.percent));
  const tone =
    status.state === 'over'
      ? 'bg-[var(--danger)]'
      : status.state === 'near'
        ? 'bg-[var(--warning)]'
        : 'bg-[var(--accent-bright)]/80';
  const label = `${status.name}: ${spent(status.spentUsd)} of ${dollars(status.monthlyUsd)} in ${status.monthName}`;
  return (
    <div className="space-y-2" data-budget-state={status.state}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-medium">{title ?? `${status.name}'s budget`}</p>
        <p className="text-sm tabular-nums text-[var(--text-secondary)]">
          {spent(status.spentUsd)} of {dollars(status.monthlyUsd)} · {percentText(status.percent)}
        </p>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(width)}
        className="h-2 overflow-hidden rounded-full bg-[var(--border-subtle)]"
      >
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${width}%` }} />
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        {status.blocked
          ? `${status.scope === 'app' ? 'Agents are' : 'It is'} stopped until you raise the budget or ${status.monthName} ends.`
          : status.state === 'over'
            ? 'Over the budget, which only warns.'
            : status.onExceed === 'stop'
              ? `At the limit ${status.scope === 'app' ? 'agents stop' : 'it stops'} taking new work.`
              : 'At the limit it only warns.'}
        {status.unpricedRequests > 0 &&
          ` Not counting ${status.unpricedRequests.toLocaleString()} requests to models without prices.`}
      </p>
    </div>
  );
}

/** The amount and what happens at the limit: shared by an agent's budget and the app's. */
export function BudgetFields({
  amount,
  onAmount,
  mode,
  onMode,
  stopLabel,
  error,
}: {
  amount: string;
  onAmount: (value: string) => void;
  mode: AgentBudget['onExceed'];
  onMode: (mode: AgentBudget['onExceed']) => void;
  stopLabel: string;
  error?: string | null;
}) {
  const id = useId();
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field
        id={`${id}-amount`}
        label="Monthly budget"
        hint={
          error ? (
            <span className="text-[var(--danger-on-tint)]">{error}</span>
          ) : (
            'US dollars per calendar month.'
          )
        }
      >
        <input
          id={`${id}-amount`}
          inputMode="decimal"
          value={amount}
          placeholder="20"
          onChange={(event) => onAmount(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-amount-hint`}
          className={FIELD}
        />
      </Field>
      <Field id={`${id}-mode`} label="At the limit">
        <select
          id={`${id}-mode`}
          value={mode}
          onChange={(event) => onMode(event.target.value as AgentBudget['onExceed'])}
          className={FIELD}
        >
          <option value="stop">{stopLabel}</option>
          <option value="warn">Only warn me</option>
        </select>
      </Field>
    </div>
  );
}

/** Settings → Usage: the monthly budget for all agents together. */
export function AppBudgetForm({ status }: { status: BudgetStatus | null | undefined }) {
  const budget = useAppBudget();
  const save = useSaveAppBudget();
  if (budget.isLoading) return <Spinner className="size-4" />;
  // Drawn again from what was saved.
  return (
    <AppBudgetFields
      key={`${budget.data?.monthlyUsd ?? 'none'}-${budget.data?.onExceed ?? ''}`}
      current={budget.data ?? null}
      status={status}
      save={save}
    />
  );
}

function AppBudgetFields({
  current,
  status,
  save,
}: {
  current: AgentBudget | null;
  status: BudgetStatus | null | undefined;
  save: ReturnType<typeof useSaveAppBudget>;
}) {
  const [amount, setAmount] = useState(current ? String(current.monthlyUsd) : '');
  const [mode, setMode] = useState<AgentBudget['onExceed']>(current?.onExceed ?? 'stop');
  const [problem, setProblem] = useState<string | null>(null);
  const parsed = parseBudgetAmount(amount);
  const next: AgentBudget | null = parsed === null ? null : { monthlyUsd: parsed, onExceed: mode };
  const dirty =
    amount.trim() === '' ? current !== null : next === null || !sameBudget(next, current);

  const submit = (change: AgentBudget | null) =>
    save.mutate(change, {
      onSuccess: (saved) =>
        toast(
          saved ? `The budget is ${dollars(saved.monthlyUsd)} a month.` : 'The budget is removed.',
        ),
    });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (amount.trim() === '') return submit(null);
        if (!next) return setProblem('A budget is from $0.01 to $1,000,000.');
        setProblem(null);
        submit(next);
      }}
    >
      {status && <BudgetMeter status={status} title="All agents together" />}
      <BudgetFields
        amount={amount}
        onAmount={(value) => {
          setAmount(value);
          setProblem(null);
        }}
        mode={mode}
        onMode={setMode}
        stopLabel="Stop every agent"
        error={problem}
      />
      {save.error && <ErrorNotice>{errorMessage(save.error)}</ErrorNotice>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={!dirty || save.isPending}>
          {save.isPending && <Spinner className="size-4 text-current" />}
          Save
        </Button>
        {current && (
          <Button
            type="button"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => submit(null)}
          >
            Remove the budget
          </Button>
        )}
      </div>
    </form>
  );
}

/** Above a conversation's message box: this agent's (or the app's) budget is nearly used, over, or used up. */
export function BudgetBanner({ notice }: { notice: BudgetNotice | null }) {
  if (!notice) return null;
  const { status } = notice;
  return (
    <div
      role={notice.kind === 'stopped' ? 'alert' : 'status'}
      data-budget-banner={notice.kind}
      className={cn(
        'mx-auto flex w-full max-w-[46rem] flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl px-4 py-2.5 text-sm',
        notice.kind === 'stopped'
          ? 'bg-[var(--danger)]/15 text-[var(--danger-on-tint)]'
          : 'bg-[var(--bg-control)] text-[var(--text-secondary)]',
      )}
    >
      <span>{notice.text}</span>
      {status.scope === 'app' ? (
        <Link to="/settings/usage" className="shrink-0 font-medium underline underline-offset-4">
          Open usage
        </Link>
      ) : (
        <Link
          to="/settings/agents/$agentId"
          params={{ agentId: status.agentId ?? '' }}
          className="shrink-0 font-medium underline underline-offset-4"
        >
          Open its settings
        </Link>
      )}
    </div>
  );
}
