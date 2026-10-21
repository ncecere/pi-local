import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  agentPath,
  api,
  type KnowledgeInfo,
  type KnowledgeProblem,
  type KnowledgeSearch,
} from '~/api/client';

/** An agent's knowledge folders and the index of their documents (docs/api.md, Knowledge). */

export const knowledgeKey = (agentId: string) => ['agents', agentId, 'knowledge'] as const;

/** Whether any folder is still being read. */
export const isIndexing = (info: KnowledgeInfo | undefined) =>
  info?.folders.some((folder) => folder.state === 'indexing' || folder.state === 'waiting') ??
  false;

/**
 * The folders with their status. Read again every 2 s while one is being read
 * (the index has no per-file events), and every 30 s otherwise, which also
 * shows what the folder watcher picked up.
 */
export function useKnowledge(agentId: string, enabled = true) {
  return useQuery({
    queryKey: knowledgeKey(agentId),
    queryFn: () => api.get<KnowledgeInfo>(agentPath(agentId, '/knowledge')),
    enabled,
    staleTime: 5_000,
    refetchInterval: (query) => (isIndexing(query.state.data) ? 2_000 : 30_000),
  });
}

/** Reads the folders again now, including the files that failed (one folder, or all). */
export function useRescanKnowledge(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path?: string) =>
      api.post(agentPath(agentId, '/knowledge/rescan'), path ? { path } : {}),
    onSettled: () => queryClient.invalidateQueries({ queryKey: knowledgeKey(agentId) }),
  });
}

/** The files of a folder that could not be read, or only in part. */
export function useKnowledgeProblems(agentId: string, folder: string, enabled: boolean) {
  return useQuery({
    queryKey: [...knowledgeKey(agentId), 'problems', folder],
    queryFn: () =>
      api.get<KnowledgeProblem[]>(
        agentPath(agentId, `/knowledge/problems?folder=${encodeURIComponent(folder)}`),
      ),
    enabled,
    staleTime: 5_000,
  });
}

/** Tries a search the way the agent's tool does (without fast judgments). */
export function useKnowledgeSearch(agentId: string) {
  return useMutation({
    mutationFn: (query: string) =>
      api.get<KnowledgeSearch>(
        agentPath(agentId, `/knowledge/search?q=${encodeURIComponent(query)}`),
      ),
  });
}

/** Opens a file of the agent's folders in the system's application (or shows it in the Finder). */
export function useOpenKnowledgeFile(agentId: string) {
  return useMutation({
    mutationFn: ({ path, reveal = false }: { path: string; reveal?: boolean }) =>
      api.post(agentPath(agentId, '/knowledge/open'), { path, reveal }),
  });
}
