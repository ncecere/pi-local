import { useState } from 'react';
import { type Agent, type AgentBudget, errorMessage } from '~/api/client';
import { Panel, saveAgentChange } from '~/components/agent-manager/panel';
import { ErrorNotice } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { BudgetFields, BudgetMeter } from '~/components/usage/budget-parts';
import { useUpdateAgent } from '~/hooks/use-agents';
import { useBudgets } from '~/hooks/use-budgets';
import { parseBudgetAmount, sameBudget } from '~/lib/budget';

/**
 * An agent's monthly budget: how much it may spend on its model each calendar month, counted from its usage at the
 * models' prices. At the limit it stops taking new messages, schedule runs and asks, or only warns.
 */
export function BudgetPanel({ agent }: { agent: Agent }) {
  const update = useUpdateAgent();
  const budgets = useBudgets();
  const current = agent.budget ?? null;
  const status = budgets.data?.agents.find((candidate) => candidate.agentId === agent.id);
  const [amount, setAmount] = useState(current ? String(current.monthlyUsd) : '');
  const [mode, setMode] = useState<AgentBudget['onExceed']>(current?.onExceed ?? 'stop');
  const [problem, setProblem] = useState<string | null>(null);
  const parsed = parseBudgetAmount(amount);
  const next: AgentBudget | null = parsed === null ? null : { monthlyUsd: parsed, onExceed: mode };
  const dirty =
    amount.trim() === '' ? current !== null : next === null || !sameBudget(next, current);

  const save = (budget: AgentBudget | null) =>
    saveAgentChange(agent, () => update.mutateAsync({ id: agent.id, budget }));

  return (
    <Panel
      title="Budget"
      description={
        <>
          The most {agent.name} may spend on its model each month, at the prices in Settings →
          Models. Models without prices can't be counted.
        </>
      }
    >
      <form
        aria-label="Budget"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (amount.trim() === '') return current ? save(null) : undefined;
          if (!next) return setProblem('A budget is from $0.01 to $1,000,000.');
          setProblem(null);
          save(next);
        }}
      >
        {status && current && <BudgetMeter status={status} title="This month" />}
        <BudgetFields
          amount={amount}
          onAmount={(value) => {
            setAmount(value);
            setProblem(null);
          }}
          mode={mode}
          onMode={setMode}
          stopLabel={`Stop ${agent.name}`}
          error={problem}
        />
        {update.error && <ErrorNotice>{errorMessage(update.error)}</ErrorNotice>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={!dirty || update.isPending}>
            {update.isPending && <Spinner className="size-4 text-current" />}
            Save
          </Button>
          {current && (
            <Button
              type="button"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => save(null)}
            >
              Remove the budget
            </Button>
          )}
        </div>
      </form>
    </Panel>
  );
}
