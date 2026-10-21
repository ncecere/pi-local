import { X } from 'lucide-react';
import type { Agent } from '~/api/client';
import { AgentAvatar } from '~/components/agent/agent-avatar';

export interface RouteQuestion {
  text: string;
  /** The likeliest first, with how likely when fast judgments said. */
  options: { agent: Agent; probability: number | null }[];
  /** Fast judgments couldn't be asked: the person chooses from their agents. */
  unavailable: boolean;
}

/**
 * Auto couldn't decide which agent a new chat's message is for: a small
 * question above the message, with the likeliest agents. Picking one sends it.
 */
export function RouteChooser({
  question,
  onPick,
  onCancel,
  disabled = false,
}: {
  question: RouteQuestion;
  onPick: (agent: Agent) => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  return (
    <section
      aria-label="Which agent should take this?"
      className="mb-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control-alt)]/60 px-3 py-2.5"
      data-route-chooser=""
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            Which agent should take this?
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            {question.unavailable
              ? "Auto couldn't pick one just now."
              : "Auto wasn't sure. These fit best."}
          </p>
        </div>
        <button
          type="button"
          aria-label="Cancel"
          title="Cancel"
          onClick={onCancel}
          className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {question.options.map(({ agent, probability }) => (
          <button
            key={agent.id}
            type="button"
            disabled={disabled}
            onClick={() => onPick(agent)}
            aria-label={`Send to ${agent.name}`}
            className="inline-flex h-8 items-center gap-2 rounded-lg bg-[var(--bg-control)] px-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <AgentAvatar agent={agent} size="sm" />
            {agent.name}
            {probability !== null && (
              <span className="text-xs font-normal tabular-nums text-[var(--text-muted)]">
                {Math.round(probability * 100)}%
              </span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * The agents to offer, likeliest first: the top three alternatives (with the
 * best guess among them), at least two when there are; without an answer, the
 * first few agents.
 */
export function routeOptions(
  agents: readonly Agent[],
  route: {
    agentId: string;
    alternatives: { agentId: string; probability: number }[];
  } | null,
): RouteQuestion['options'] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  if (!route) return agents.slice(0, 6).map((agent) => ({ agent, probability: null }));
  const ranked = [...route.alternatives].sort((a, b) => b.probability - a.probability);
  const options: RouteQuestion['options'] = [];
  for (const alternative of [
    ...ranked,
    ...(ranked.some((alt) => alt.agentId === route.agentId)
      ? []
      : [{ agentId: route.agentId, probability: null }]),
  ]) {
    const agent = byId.get(alternative.agentId);
    if (agent && !options.some((option) => option.agent.id === agent.id))
      options.push({ agent, probability: alternative.probability });
  }
  for (const agent of agents) {
    if (options.length >= 2) break;
    if (!options.some((option) => option.agent.id === agent.id))
      options.push({ agent, probability: null });
  }
  return options.slice(0, 3);
}
