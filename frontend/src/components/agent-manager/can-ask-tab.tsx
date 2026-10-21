import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { type Agent, errorMessage } from '~/api/client';
import { AgentAvatar } from '~/components/agent/agent-avatar';
import { Panel, SaveBar, saveAgentChange } from '~/components/agent-manager/panel';
import { ErrorNotice } from '~/components/models/fields';
import { useUpdateAgent } from '~/hooks/use-agents';
import { agentKindLabel } from '~/lib/agent-groups';
import { cn } from '~/lib/utils';

/**
 * Who this agent may ask (its `ask_agent` tool): the agents chosen here
 * (`canCall`), and everyone its teams allow, shown as the effective list.
 */
export function CanAskTab({ agent, agents }: { agent: Agent; agents: Agent[] }) {
  return (
    <div className="flex flex-col gap-6">
      <CanCallForm key={agent.revision} agent={agent} agents={agents} />
      <Panel
        title="Everyone it may ask"
        description="All rules applied: the agents chosen above, and its teams (a lead may ask its members; members may ask each other when the team allows it)."
      >
        {(agent.callable ?? []).length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            Nobody yet: it works alone. Choose agents above, or put it in a{' '}
            <Link to="/settings/teams" className="text-[var(--accent-bright)] hover:underline">
              team
            </Link>
            .
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)]">
            {agent.callable.map((callable) => (
              <li
                key={`${callable.id}-${callable.via}`}
                className="flex items-center justify-between gap-3 py-2"
              >
                <Link
                  to="/settings/agents/$agentId"
                  params={{ agentId: callable.id }}
                  className="min-w-0 truncate text-sm hover:underline"
                >
                  {callable.name}
                </Link>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-xs',
                    callable.via === 'team'
                      ? 'bg-[var(--accent-soft)] text-[var(--accent-bright)]'
                      : 'bg-[var(--bg-control)] text-[var(--text-secondary)]',
                  )}
                >
                  {callable.via === 'team' ? 'via team' : 'direct'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function CanCallForm({ agent, agents }: { agent: Agent; agents: Agent[] }) {
  const update = useUpdateAgent();
  const others = agents.filter((other) => other.id !== agent.id);
  const known = new Set(others.map((other) => other.id));
  const saved = (agent.canCall ?? []).filter((id) => known.has(id));
  const [chosen, setChosen] = useState<string[]>(saved);
  const dirty = [...chosen].sort().join() !== [...saved].sort().join();

  return (
    <Panel
      title="Can ask"
      description={`Agents ${agent.name} may ask for help in a conversation. Each asked agent answers in a conversation of its own, listed under it, so you can always read what they said.`}
    >
      {others.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">There are no other agents yet.</p>
      ) : (
        <fieldset className="m-0 border-0 p-0">
          <legend className="sr-only">Agents {agent.name} may ask</legend>
          <ul className="flex flex-col gap-1">
            {others.map((other) => (
              <li key={other.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--bg-control)]">
                  <input
                    type="checkbox"
                    checked={chosen.includes(other.id)}
                    onChange={(event) =>
                      setChosen((before) =>
                        event.target.checked
                          ? [...before, other.id]
                          : before.filter((id) => id !== other.id),
                      )
                    }
                    className="size-4 accent-[var(--accent)]"
                  />
                  <AgentAvatar agent={other} size={20} frozen />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{other.name}</span>
                    <span className="block truncate text-xs text-[var(--text-muted)]">
                      {other.description || agentKindLabel(other)}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {update.error && (
        <div className="mt-3">
          <ErrorNotice>{errorMessage(update.error)}</ErrorNotice>
        </div>
      )}
      {others.length > 0 && (
        <div className="mt-4">
          <SaveBar
            dirty={dirty}
            busy={update.isPending}
            onSave={() =>
              saveAgentChange(agent, () => update.mutateAsync({ id: agent.id, canCall: chosen }))
            }
            onReset={() => {
              setChosen(saved);
              update.reset();
            }}
          />
        </div>
      )}
    </Panel>
  );
}
