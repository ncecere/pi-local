import { X } from 'lucide-react';
import { useId, useState } from 'react';
import { errorMessage } from '~/api/client';
import { FIELD } from '~/components/models/fields';
import { SettingsSection } from '~/components/settings/settings-layout';
import { Spinner } from '~/components/ui/spinner';
import { AppBudgetForm, BudgetMeter } from '~/components/usage/budget-parts';
import {
  DailyBars,
  PeriodPicker,
  Stat,
  StatStrip,
  TotalsStats,
  UsageTable,
  type UsageView,
  whole,
} from '~/components/usage/usage-parts';
import { useBudgets } from '~/hooks/use-budgets';
import { useUsage } from '~/hooks/use-usage';
import { dollars, percentText } from '~/lib/budget';
import { usePageTitle } from '~/lib/document-title';
import { byUse, fillDays, monthLabel, type UsageQuery } from '~/lib/usage';
import { cn } from '~/lib/utils';

/** What the agents asked of their models: requests, tokens and an estimated cost, and the monthly budgets. */
export function SettingsUsagePage() {
  usePageTitle('Usage · Settings');
  const id = useId();
  const [view, setView] = useState<UsageView>({ kind: 'days', days: 30 });
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const query: UsageQuery = {
    ...(view.kind === 'month' ? { month: view.month } : { days: view.days }),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
  };
  const usage = useUsage(query);
  const budgets = useBudgets();
  const data = usage.data;
  const period = view.kind === 'month' ? monthLabel(view.month) : `these ${view.days} days`;
  const filtered = Boolean(agent || model);

  // The filters offer everything used in the period, and keep what is chosen even when this period has none of it.
  const agentOptions = withChosen(
    data?.options?.agents.map((a) => ({ id: a.agentId, name: a.name })) ??
      data?.agents.map((a) => ({ id: a.agentId, name: a.name })) ??
      [],
    agent,
  );
  const modelOptions = withChosen(
    data?.options?.models.map((m) => ({ id: m.modelId, name: m.name })) ??
      data?.models.map((m) => ({ id: m.modelId, name: m.name })) ??
      [],
    model,
  );
  const agentBudgets = new Map(budgets.data?.agents.map((b) => [b.agentId ?? '', b]));
  // The budgets are this month's; a month view shows that month's.
  const shownBudget = data?.budget ?? null;

  return (
    <SettingsSection title="Usage" first>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-[var(--text-muted)]">
          How much your agents use their models: requests, tokens and a cost estimated from the
          prices set in Settings → Models. Days are in this computer's time zone.
        </p>
        <PeriodPicker value={view} onChange={setView} />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-agent`} className="text-xs font-medium text-[var(--text-muted)]">
            Agent
          </label>
          <select
            id={`${id}-agent`}
            value={agent}
            onChange={(event) => setAgent(event.target.value)}
            className={cn(FIELD, 'h-9 w-52')}
          >
            <option value="">All agents</option>
            {agentOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-model`} className="text-xs font-medium text-[var(--text-muted)]">
            Model
          </label>
          <select
            id={`${id}-model`}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className={cn(FIELD, 'h-9 w-52')}
          >
            <option value="">All models</option>
            {modelOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
        {filtered && (
          <button
            type="button"
            onClick={() => {
              setAgent('');
              setModel('');
            }}
            className="flex h-9 items-center gap-1 rounded-lg px-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <X className="size-4" aria-hidden="true" />
            Clear filters
          </button>
        )}
      </div>

      {usage.isError && !data ? (
        <p
          role="alert"
          className="rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-on-tint)]"
        >
          Usage could not be read: {errorMessage(usage.error)}
        </p>
      ) : !data ? (
        <div className="py-12">
          <Spinner className="mx-auto" />
        </div>
      ) : (
        <div
          aria-busy={usage.isPlaceholderData}
          className={cn('space-y-8', usage.isPlaceholderData && 'opacity-60')}
        >
          {shownBudget && (shownBudget.app || shownBudget.agent) && (
            <section aria-label="Budget" className="space-y-4">
              <p className="text-xs text-[var(--text-muted)]">
                Budgets cover the whole calendar month shown, across all models, regardless of the
                filters.
              </p>
              {shownBudget.agent && <BudgetMeter status={shownBudget.agent} showUnpriced={false} />}
              {shownBudget.app && (
                <BudgetMeter
                  status={shownBudget.app}
                  title="All agents together"
                  showUnpriced={false}
                />
              )}
            </section>
          )}
          <StatStrip>
            <TotalsStats total={data.total} />
            <Stat
              label="Agents"
              value={whole.format(data.agents.length)}
              hint={filtered ? 'in this selection' : 'used in this period'}
            />
          </StatStrip>
          {(data.total.unpricedRequests > 0 ||
            (budgets.data?.app?.unpricedRequests ?? 0) > 0 ||
            (shownBudget?.agent?.unpricedRequests ?? 0) > 0) && (
            <p data-unpriced-warning className="-mt-4 text-xs text-[var(--text-muted)]">
              Costs and budgets don't include requests to models without prices. Set a model's
              prices in Settings → Models to count them.
              {data.total.unpricedRequests > 0 &&
                ` This selection has ${whole.format(data.total.unpricedRequests)} unpriced requests.`}
            </p>
          )}
          <section aria-labelledby="usage-days">
            <h3 id="usage-days" className="mb-3 text-base font-semibold">
              Tokens per day
            </h3>
            <DailyBars
              days={fillDays(data.byDay, data.from, data.to)}
              from={data.from}
              to={data.to}
            />
          </section>
          <section aria-labelledby="usage-agents">
            <h3 id="usage-agents" className="mb-3 text-base font-semibold">
              By agent
            </h3>
            {data.agents.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                {filtered ? 'No agents match in' : 'No agents have been used in'} {period}.
              </p>
            ) : (
              <UsageTable
                label="Agent"
                rows={byUse(data.agents)}
                rowKey={(row) => row.agentId}
                plainDetail
                onPick={agent ? undefined : (row) => setAgent(row.agentId)}
                detail={(row) => {
                  const b = agentBudgets.get(row.agentId);
                  return b
                    ? `Budget ${dollars(b.monthlyUsd)} · ${percentText(b.percent)} used in ${b.monthName}`
                    : undefined;
                }}
              />
            )}
          </section>
          <section aria-labelledby="usage-models">
            <h3 id="usage-models" className="mb-3 text-base font-semibold">
              By model
            </h3>
            {data.models.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                {filtered ? 'No models match in' : 'No models have been used in'} {period}.
              </p>
            ) : (
              <UsageTable
                label="Model"
                rows={byUse(data.models)}
                rowKey={(row) => row.modelId}
                onPick={model ? undefined : (row) => setModel(row.modelId)}
                detail={(row) => (row.name !== row.modelId ? row.modelId : undefined)}
              />
            )}
          </section>
        </div>
      )}

      <section
        aria-labelledby="usage-budget"
        className="space-y-4 border-t border-[var(--border-subtle)] pt-6"
      >
        <div>
          <h3 id="usage-budget" className="text-base font-semibold">
            Budget for all agents · current month · all models
          </h3>
          <p className="mt-1 max-w-xl text-sm text-[var(--text-muted)]">
            A monthly limit on what every agent together may spend. You hear at 80% and at 100%.
            With "Stop every agent", messages, schedule runs and asks are refused at the limit. Each
            agent can have a budget of its own in its settings.
          </p>
        </div>
        <AppBudgetForm status={budgets.data?.app} />
      </section>
    </SettingsSection>
  );
}

/** The options, plus the chosen one when the period has no usage of it. */
function withChosen(options: { id: string; name: string }[], chosen: string) {
  return chosen && !options.some((option) => option.id === chosen)
    ? [...options, { id: chosen, name: chosen }]
    : options;
}
