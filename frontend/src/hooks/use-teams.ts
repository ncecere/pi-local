import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Team } from '~/api/client';
import { AGENTS_KEY } from '~/hooks/use-agents';
import { applyTeamEvent, type TeamDraft } from '~/lib/teams';

export const TEAMS_KEY = ['teams'] as const;

const teamPath = (teamId: string) => `/api/teams/${encodeURIComponent(teamId)}`;

/** The teams. Changes arrive live as `team` events on /api/events. */
export function useTeams(enabled = true) {
  return useQuery({
    queryKey: TEAMS_KEY,
    queryFn: () => api.get<Team[]>('/api/teams'),
    enabled,
    staleTime: 30_000,
  });
}

/**
 * After a team changes: the list, and the agents (who may ask whom, their
 * `callable`, follows from the teams).
 */
function settle(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: TEAMS_KEY }),
    queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true }),
  ]);
}

export function useCreateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TeamDraft) => api.post<Team>('/api/teams', body),
    onSuccess: (team) =>
      queryClient.setQueryData<Team[]>(TEAMS_KEY, (list) => applyTeamEvent(list, team.id, team)),
    onSettled: () => settle(queryClient),
  });
}

export function useUpdateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<TeamDraft> & { id: string }) =>
      api.patch<Team>(teamPath(id), body),
    onSuccess: (team) =>
      queryClient.setQueryData<Team[]>(TEAMS_KEY, (list) => applyTeamEvent(list, team.id, team)),
    onSettled: () => settle(queryClient),
  });
}

export function useDeleteTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(teamPath(id)),
    onSuccess: (_data, id) =>
      queryClient.setQueryData<Team[]>(TEAMS_KEY, (list) => applyTeamEvent(list, id, null)),
    onSettled: () => settle(queryClient),
  });
}
