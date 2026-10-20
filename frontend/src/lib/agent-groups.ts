import type { Agent } from '~/api/client';

/**
 * How the agents divide up. Locally every agent is the person's own
 * (`kind: "personal"`); `provided` and `teams` stay (empty) for the shared
 * renderers that still group by them.
 */
export function groupAgents(agents: readonly Agent[]) {
  return {
    provided: [] as Agent[],
    mine: agents.slice(),
    teams: [] as Agent[],
  };
}

const KIND_LABELS: Record<Agent['agentKind'], string> = {
  assistant: 'Assistant',
  triage: 'Triage',
  researcher: 'Researcher',
};

/** What an agent is, for people (in place of the platform's template name). */
export function agentKindLabel(agent: Pick<Agent, 'agentKind'>): string {
  return KIND_LABELS[agent.agentKind] ?? agent.agentKind ?? '';
}
