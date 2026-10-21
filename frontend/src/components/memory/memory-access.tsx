import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { type Agent, type AgentMemory, errorMessage } from '~/api/client';
import { AgentAvatar } from '~/components/agent/agent-avatar';
import { saveAgentChange } from '~/components/agent-manager/panel';
import { ErrorNotice } from '~/components/models/fields';
import { Switch } from '~/components/ui/switch';
import { memoryOf, useSaveAgentMemory } from '~/hooks/use-memory';
import { categoryLabel } from '~/lib/memory';
import { cn } from '~/lib/utils';

/**
 * Whether an agent's memory is on and which of the person's categories it
 * sees, each change saved at once (`PATCH /api/agents/{id}` `{memory}`), with
 * the agent's saved toast.
 */
export function useAgentMemoryAccess(agent: Agent, shareable: readonly string[]) {
  const save = useSaveAgentMemory();
  const memory = memoryOf(agent);
  const set = (next: AgentMemory) =>
    saveAgentChange(agent, () => save.mutateAsync({ id: agent.id, memory: next }));
  return {
    memory,
    pending: save.isPending,
    error: save.error,
    setOn: (on: boolean) => set({ ...memory, off: !on }),
    setShared: (category: string, shared: boolean) => {
      const share = shared
        ? [...memory.share.filter((c) => c !== category), category]
        : memory.share.filter((c) => c !== category);
      // In the categories' own order.
      const known = shareable.filter((c) => share.includes(c));
      set({ ...memory, share: [...known, ...share.filter((c) => !known.includes(c))] });
    },
  };
}

export const ALWAYS_SHARED_NOTE =
  'Every agent with memory on sees your About me card and your preferences.';

/** Settings → You: agents as rows, the shareable categories as columns. */
export function MemoryAccessTable({
  agents,
  shareable,
}: {
  agents: readonly Agent[];
  shareable: readonly string[];
}) {
  if (agents.length === 0)
    return <p className="text-sm text-[var(--text-muted)]">No agents yet.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
      <table className="w-full min-w-max border-collapse text-sm">
        <caption className="sr-only">Which agents see what</caption>
        <thead>
          <tr className="border-b border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Agent
            </th>
            <th scope="col" className="px-2 py-2 text-center font-medium">
              Memory on
            </th>
            {shareable.map((category) => (
              <th key={category} scope="col" className="px-2 py-2 text-center font-medium">
                {categoryLabel(category)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-subtle)]">
          {agents.map((agent) => (
            <AccessRow key={agent.id} agent={agent} shareable={shareable} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccessRow({ agent, shareable }: { agent: Agent; shareable: readonly string[] }) {
  const access = useAgentMemoryAccess(agent, shareable);
  const { memory } = access;
  return (
    <tr data-agent-row={agent.id}>
      <th scope="row" className="px-3 py-2 text-left font-normal">
        <Link
          to="/settings/agents/$agentId"
          params={{ agentId: agent.id }}
          search={{ tab: 'memory' }}
          className="flex min-w-0 items-center gap-2 hover:underline"
        >
          <AgentAvatar agent={agent} size="sm" />
          <span className="truncate font-medium">{agent.name}</span>
        </Link>
        {access.error ? (
          <span role="alert" className="mt-1 block text-xs text-[var(--danger-on-tint)]">
            {errorMessage(access.error, 'Not saved.')}
          </span>
        ) : null}
      </th>
      <td className="px-2 py-2 text-center">
        <Switch
          checked={!memory.off}
          disabled={access.pending}
          aria-label={`Memory for ${agent.name}`}
          onCheckedChange={access.setOn}
          className="align-middle"
        />
      </td>
      {shareable.map((category) => (
        <td key={category} className="px-2 py-2 text-center">
          <input
            type="checkbox"
            checked={memory.share.includes(category)}
            disabled={memory.off || access.pending}
            aria-label={`${agent.name} sees ${categoryLabel(category).toLowerCase()}`}
            onChange={(event) => access.setShared(category, event.target.checked)}
            className={cn('size-4 accent-[var(--accent)] align-middle', memory.off && 'opacity-40')}
          />
        </td>
      ))}
    </tr>
  );
}

/** The agent's Memory tab: the same switch and categories, for one agent. */
export function AgentMemoryAccess({
  agent,
  shareable,
}: {
  agent: Agent;
  shareable: readonly string[];
}) {
  const id = useId();
  const access = useAgentMemoryAccess(agent, shareable);
  const { memory } = access;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p id={`${id}-on-label`} className="text-sm font-medium">
            Memory on
          </p>
          <p id={`${id}-on-hint`} className="mt-0.5 text-xs text-[var(--text-muted)]">
            {memory.off
              ? `${agent.name} doesn't see what you've told agents, keeps no notes, and has no memory tools.`
              : `${agent.name} sees what's shared with it below, keeps its own notes, and can remember things.`}
          </p>
        </div>
        <Switch
          checked={!memory.off}
          disabled={access.pending}
          aria-labelledby={`${id}-on-label`}
          aria-describedby={`${id}-on-hint`}
          onCheckedChange={access.setOn}
        />
      </div>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" disabled={memory.off}>
        <legend className="mb-1 text-sm font-medium">What it sees about you</legend>
        <p className="text-xs text-[var(--text-muted)]">{ALWAYS_SHARED_NOTE} Also:</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {shareable.map((category) => (
            <label
              key={category}
              className={cn(
                'flex items-center gap-2 text-sm',
                memory.off && 'text-[var(--text-muted)]',
              )}
            >
              <input
                type="checkbox"
                checked={memory.share.includes(category)}
                disabled={memory.off || access.pending}
                onChange={(event) => access.setShared(category, event.target.checked)}
                className="size-4 accent-[var(--accent)]"
              />
              {categoryLabel(category)}
            </label>
          ))}
        </div>
      </fieldset>
      {access.error ? <ErrorNotice>{errorMessage(access.error)}</ErrorNotice> : null}
    </div>
  );
}
