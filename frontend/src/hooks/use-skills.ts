import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Agent,
  type AgentSkills,
  agentPath,
  api,
  type SharedSkill,
  type Skill,
  type SkillDetail,
} from '~/api/client';
import { AGENTS_KEY, applyAgentEvent } from '~/hooks/use-agents';

/**
 * Skills (docs/api.md, Skills): shared ones in the app's skills folder, an agent's own in its folder. Adding sends a
 * zip's bytes as an ArrayBuffer (the desktop app drops Blob bodies).
 */

export const SKILLS_KEY = ['skills'] as const;
export const agentSkillsKey = (agentId: string) => ['agents', agentId, 'skills'] as const;

const sharedPath = (name: string, rest = '') => `/api/skills/${encodeURIComponent(name)}${rest}`;
const ownPath = (agentId: string, name: string, rest = '') =>
  agentPath(agentId, `/skills/${encodeURIComponent(name)}${rest}`);

export function useSharedSkills() {
  return useQuery({
    queryKey: SKILLS_KEY,
    queryFn: () => api.get<{ skills: SharedSkill[]; folder: string }>('/api/skills'),
    staleTime: 30_000,
  });
}

/** The agent's own skills and the shared ones with which it uses. */
export function useAgentSkills(agentId: string) {
  return useQuery({
    queryKey: agentSkillsKey(agentId),
    queryFn: () => api.get<AgentSkills>(agentPath(agentId, '/skills')),
    staleTime: 15_000,
  });
}

/** Where a skill lives: shared (the library) or an agent's own. */
export type SkillScope = { shared: true } | { agentId: string };

const detailKey = (scope: SkillScope, name: string) =>
  ['skill', 'agentId' in scope ? scope.agentId : 'shared', name] as const;

/** One skill with its instructions and files, read when it is opened. */
export function useSkillDetail(scope: SkillScope, name: string | null) {
  return useQuery({
    queryKey: detailKey(scope, name ?? ''),
    queryFn: async () => {
      const path = 'agentId' in scope ? ownPath(scope.agentId, name!) : sharedPath(name!);
      return (await api.get<{ skill: SkillDetail }>(path)).skill;
    },
    enabled: name !== null,
    staleTime: 0,
  });
}

/** A text file of a skill. */
export function useSkillFile(scope: SkillScope, name: string, path: string | null) {
  return useQuery({
    queryKey: [...detailKey(scope, name), 'file', path],
    queryFn: () => {
      const base =
        'agentId' in scope ? ownPath(scope.agentId, name, '/file') : sharedPath(name, '/file');
      return api.get<{ path: string; content: string; truncated: boolean }>(
        `${base}?path=${encodeURIComponent(path!)}`,
      );
    },
    enabled: path !== null,
    staleTime: 0,
    retry: false,
  });
}

function refresh(queryClient: QueryClient, scope: SkillScope) {
  if ('agentId' in scope)
    void queryClient.invalidateQueries({ queryKey: agentSkillsKey(scope.agentId) });
  else {
    void queryClient.invalidateQueries({ queryKey: SKILLS_KEY });
    void queryClient.invalidateQueries({ queryKey: ['agents'] });
  }
}

/** Adds a skill from a zip's bytes. `409 exists` when the name is taken (`replace` replaces it). */
export function useAddSkill(scope: SkillScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bytes, replace = false }: { bytes: ArrayBuffer; replace?: boolean }) => {
      const base = 'agentId' in scope ? agentPath(scope.agentId, '/skills') : '/api/skills';
      return api.upload<Skill>(
        `${base}${replace ? '?replace=true' : ''}`,
        bytes,
        'application/zip',
      );
    },
    onSettled: () => refresh(queryClient, scope),
  });
}

/** Deletes a skill: a shared one is taken off every agent that picked it. */
export function useDeleteSkill(scope: SkillScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.delete('agentId' in scope ? ownPath(scope.agentId, name) : sharedPath(name)),
    onSettled: () => refresh(queryClient, scope),
  });
}

/** Sets which shared skills the agent uses. The agent restarts with the change if it was awake. */
export function useEnableSkills(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: string[]) => api.put<Agent>(agentPath(agentId, '/skills'), { enabled }),
    onSuccess: (agent) =>
      queryClient.setQueryData<Agent[]>(AGENTS_KEY, (list) =>
        applyAgentEvent(list, agent.id, agent),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: agentSkillsKey(agentId) });
      void queryClient.invalidateQueries({ queryKey: SKILLS_KEY });
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true });
    },
  });
}
