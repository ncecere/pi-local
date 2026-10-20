import type { Agent, Team } from '~/api/types';

/** At most this many members besides the lead (docs/api.md, Teams). */
export const MAX_TEAM_MEMBERS = 20;
export const MAX_TEAM_NAME = 60;
export const MAX_TEAM_DESCRIPTION = 500;

/** The agents that can be a team's members: everyone but its lead. */
export function memberCandidates<A extends Pick<Agent, 'id'>>(
  agents: readonly A[],
  leadId: string,
): A[] {
  return agents.filter((agent) => agent.id !== leadId);
}

/**
 * The members once the lead is chosen: never the lead itself, each once, only
 * agents that exist (when `known` is given), in the order they were picked.
 */
export function normalizeMembers(
  memberIds: readonly string[],
  leadId: string,
  known?: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of memberIds) {
    if (!id || id === leadId || seen.has(id)) continue;
    if (known && !known.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Adds or removes one member; adding past the limit changes nothing. */
export function toggleMember(memberIds: readonly string[], id: string, on: boolean): string[] {
  if (!on) return memberIds.filter((member) => member !== id);
  if (memberIds.includes(id) || memberIds.length >= MAX_TEAM_MEMBERS) return memberIds.slice();
  return [...memberIds, id];
}

export interface TeamDraft {
  name: string;
  description: string;
  leadId: string;
  memberIds: string[];
  membersTalk: boolean;
}

/** Why the team can't be saved as it is, for people; null when it can. */
export function teamDraftProblem(draft: TeamDraft): string | null {
  const name = draft.name.trim();
  if (!name) return 'Give the team a name.';
  if (name.length > MAX_TEAM_NAME) return `A name has at most ${MAX_TEAM_NAME} characters.`;
  if (/[\r\n]/.test(name)) return 'A name is one line.';
  if (draft.description.trim().length > MAX_TEAM_DESCRIPTION)
    return `A description has at most ${MAX_TEAM_DESCRIPTION} characters.`;
  if (!draft.leadId) return 'Choose the lead: the agent you chat with for the team.';
  const members = normalizeMembers(draft.memberIds, draft.leadId);
  if (members.length === 0) return 'Choose at least one member besides the lead.';
  if (members.length > MAX_TEAM_MEMBERS) return `A team has at most ${MAX_TEAM_MEMBERS} members.`;
  return null;
}

/** The fields of a PATCH that differ from the team as it is. */
export function teamChanges(team: Team, draft: TeamDraft): Partial<TeamDraft> {
  const changes: Partial<TeamDraft> = {};
  if (draft.name.trim() !== team.name) changes.name = draft.name.trim();
  if (draft.description.trim() !== team.description) changes.description = draft.description.trim();
  if (draft.leadId !== team.leadId) changes.leadId = draft.leadId;
  const members = normalizeMembers(draft.memberIds, draft.leadId);
  if (members.join('\n') !== team.memberIds.join('\n')) changes.memberIds = members;
  if (draft.membersTalk !== team.membersTalk) changes.membersTalk = draft.membersTalk;
  return changes;
}

/** The team list with one team changed (or added at the end), or removed when `team` is null. */
export function applyTeamEvent(
  list: Team[] | undefined,
  teamId: string,
  team: Team | null | undefined,
): Team[] | undefined {
  if (!list) return list;
  if (!team) return list.filter((candidate) => candidate.id !== teamId);
  const index = list.findIndex((candidate) => candidate.id === teamId);
  if (index < 0) return [...list, team];
  const next = list.slice();
  next[index] = team;
  return next;
}

/** "Research team · Ada": a team as the composer shows it, with whom you chat. */
export function teamChatLabel(team: Pick<Team, 'name'>, lead: Pick<Agent, 'name'> | undefined) {
  return lead ? `${team.name} · ${lead.name}` : team.name;
}

/** The teams someone can chat with: those whose lead is among `agents`. */
export function chattableTeams<T extends Pick<Team, 'leadId'>>(
  teams: readonly T[] | undefined,
  agents: readonly Pick<Agent, 'id'>[],
): T[] {
  const ids = new Set(agents.map((agent) => agent.id));
  return (teams ?? []).filter((team) => ids.has(team.leadId));
}
