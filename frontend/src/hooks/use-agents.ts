import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Agent,
  type AgentApprovals,
  type AgentBudget,
  type AgentKnowledge,
  type AgentMcpServer,
  type AgentSecurity,
  type AgentTemplate,
  type AgentThread,
  type AgentWorkspaceInput,
  agentPath,
  api,
  type CatalogModel,
  threadPath,
  type WebTools,
} from '~/api/client';

export const AGENTS_KEY = ['agents'] as const;
export const threadsKey = (agentId: string) => ['agents', agentId, 'threads'] as const;

/**
 * The local agents, newest first. Listing never starts a runtime. Their status
 * (asleep, awake, error) arrives live as `agent` events on /api/events; the
 * slow refresh only covers a stream that was down.
 */
export function useAgents() {
  return useQuery({
    queryKey: AGENTS_KEY,
    queryFn: () => api.get<Agent[]>('/api/agents'),
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
}

export function useAgent(agentId: string | undefined): Agent | undefined {
  const { data } = useAgents();
  return agentId ? data?.find((agent) => agent.id === agentId) : undefined;
}

/** Agents someone can talk to: enabled ones. */
export function chattable(agents: readonly Agent[] | undefined): Agent[] {
  return (agents ?? []).filter((agent) => agent.enabled);
}

/**
 * An agent's conversations, most recent first, from the app's own index: it
 * never wakes the agent. Still only read for agents open in the sidebar or on
 * screen (`enabled`).
 */
export function useAgentThreads(agentId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: threadsKey(agentId ?? ''),
    queryFn: () => api.get<AgentThread[]>(agentPath(agentId!, '/threads')),
    enabled: Boolean(agentId) && enabled,
    staleTime: 15_000,
  });
}

/** A conversation as the cached list has it, if known. */
export function useThreadInfo(agentId: string, threadId: string): AgentThread | undefined {
  const { data } = useAgentThreads(agentId);
  return data?.find((thread) => thread.threadId === threadId);
}

/** A conversation's title from the cached list, if known. */
export function useThreadTitle(agentId: string, threadId: string): string | undefined {
  return useThreadInfo(agentId, threadId)?.title;
}

/** Stops and removes a conversation from the agent's list. */
export function useDeleteThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, threadId }: { agentId: string; threadId: string }) =>
      api.delete(threadPath(agentId, threadId)),
    onMutate: async ({ agentId, threadId }) => {
      await queryClient.cancelQueries({ queryKey: threadsKey(agentId) });
      queryClient.setQueryData<AgentThread[]>(threadsKey(agentId), (threads) =>
        threads?.filter((thread) => thread.threadId !== threadId),
      );
    },
    onSettled: (_data, _error, { agentId }) =>
      queryClient.invalidateQueries({ queryKey: threadsKey(agentId) }),
  });
}

/** Renames a conversation; the list shows the new name at once. */
export function useRenameThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      threadId,
      title,
    }: {
      agentId: string;
      threadId: string;
      title: string;
    }) => api.patch(threadPath(agentId, threadId), { title }),
    onMutate: async ({ agentId, threadId, title }) => {
      await queryClient.cancelQueries({ queryKey: threadsKey(agentId) });
      const before = queryClient.getQueryData<AgentThread[]>(threadsKey(agentId));
      queryClient.setQueryData<AgentThread[]>(threadsKey(agentId), (threads) =>
        threads?.map((thread) => (thread.threadId === threadId ? { ...thread, title } : thread)),
      );
      return { before };
    },
    onError: (_error, { agentId }, context) =>
      queryClient.setQueryData(threadsKey(agentId), context?.before),
    onSettled: (_data, _error, { agentId }) =>
      queryClient.invalidateQueries({ queryKey: threadsKey(agentId) }),
  });
}

/**
 * Puts a just-started conversation at the top of its agent's list straight
 * away, before the platform lists it (the title is the agent's own: the
 * start of the first message).
 */
export function noteNewThread(
  queryClient: ReturnType<typeof useQueryClient>,
  agentId: string,
  threadId: string,
  firstMessage: string,
) {
  const now = Date.now();
  queryClient.setQueryData<AgentThread[]>(threadsKey(agentId), (threads) => {
    if (threads?.some((thread) => thread.threadId === threadId)) return threads;
    const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New conversation';
    return [
      {
        threadId,
        title,
        createdAt: now,
        updatedAt: now,
        busy: true,
        visibility: 'private',
        participants: [],
      },
      ...(threads ?? []),
    ];
  });
}

/**
 * A message was just sent: its conversation is busy in the list now, before
 * the platform's event says so, so its row does not flicker out of Working.
 */
export function markThreadBusy(
  queryClient: ReturnType<typeof useQueryClient>,
  agentId: string,
  threadId: string,
) {
  queryClient.setQueryData<AgentThread[]>(threadsKey(agentId), (threads) =>
    threads?.map((thread) =>
      thread.threadId === threadId ? { ...thread, busy: true, updatedAt: Date.now() } : thread,
    ),
  );
}

/**
 * Makes a new conversation from one: `beforeMessageId` keeps everything before
 * that user message (edit it: send the new text next), `afterMessageId` keeps
 * everything up to and with that message (branch). The source is untouched.
 * The new one is listed at once.
 */
export function useForkThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      threadId,
      ...body
    }: { agentId: string; threadId: string } & (
      | { beforeMessageId: string }
      | { afterMessageId: string }
    )) => api.post<AgentThread>(threadPath(agentId, threadId, '/fork'), body),
    onSuccess: (thread, { agentId }) => {
      const key = threadsKey(agentId);
      if (queryClient.getQueryData(key) === undefined)
        void queryClient.invalidateQueries({ queryKey: key });
      else
        queryClient.setQueryData<AgentThread[]>(key, (threads) => [
          thread,
          ...(threads ?? []).filter((candidate) => candidate.threadId !== thread.threadId),
        ]);
    },
  });
}

/** A new conversation ID, in the form the API accepts (1-64 of [A-Za-z0-9_-]). */
export function newThreadId(): string {
  return crypto.randomUUID();
}

// ── Making and managing agents (docs/api.md, Agents) ────────────────────────────────────────

export interface AgentCatalog {
  /** The templates for the New agent gallery, in order (built-ins first). */
  templates: AgentTemplate[];
  /** Every enabled model of every enabled provider, and the demo model. */
  models: CatalogModel[];
  defaultModelId: string | null;
  allowModelChoice: boolean;
  limit: number;
  used: number;
}

export const CATALOG_KEY = ['agents', 'catalog'] as const;

export const useAgentCatalog = (enabled = true) =>
  useQuery({
    queryKey: CATALOG_KEY,
    queryFn: () => api.get<AgentCatalog>('/api/agents/catalog'),
    enabled,
    staleTime: 60_000,
  });

export function useCreateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      description?: string;
      /** A template's ID: the agent starts from it; the fields here still win. */
      templateId: string;
      modelId?: string;
      /** Left out or empty: the template's instructions. */
      instructions?: string;
      /** Left out: the kind's default tools (coding: read, write, edit, bash) in its own folder. */
      workspace?: AgentWorkspaceInput;
      /** Folders of documents it can search (Document Q&A). */
      knowledge?: AgentKnowledge;
    }) => api.post<Agent>('/api/agents', body),
    onSuccess: (agent) =>
      queryClient.setQueryData<Agent[]>(AGENTS_KEY, (list) =>
        applyAgentEvent(list, agent.id, agent),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true });
      void queryClient.invalidateQueries({ queryKey: CATALOG_KEY });
    },
  });
}

export function useUpdateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      description?: string;
      modelId?: string;
      instructions?: string;
      kindSettings?: Record<string, unknown>;
      canCall?: string[];
      workspace?: AgentWorkspaceInput;
      approvals?: AgentApprovals;
      mcp?: AgentMcpServer[];
      schedules?: { agentMade: boolean };
      web?: WebTools;
      /** Replaces the knowledge folders. */
      knowledge?: AgentKnowledge;
      security?: AgentSecurity;
      /** null removes the agent's budget. */
      budget?: AgentBudget | null;
    }) => api.patch<Agent>(agentPath(id), body),
    onSuccess: (agent) =>
      queryClient.setQueryData<Agent[]>(AGENTS_KEY, (list) =>
        applyAgentEvent(list, agent.id, agent),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true }),
  });
}

export function useRemoveAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(agentPath(id)),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<Agent[]>(AGENTS_KEY, (list) => applyAgentEvent(list, id, null));
      queryClient.removeQueries({ queryKey: threadsKey(id) });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true });
      void queryClient.invalidateQueries({ queryKey: CATALOG_KEY });
    },
  });
}

/**
 * The agent list with one agent changed (or added at the top, the list being
 * newest first), or removed when `agent` is null.
 */
export function applyAgentEvent(
  list: Agent[] | undefined,
  agentId: string,
  agent: Agent | null | undefined,
): Agent[] | undefined {
  if (!list) return list;
  if (!agent) return list.filter((candidate) => candidate.id !== agentId);
  const index = list.findIndex((candidate) => candidate.id === agentId);
  if (index < 0) return [agent, ...list];
  const next = list.slice();
  next[index] = agent;
  return next;
}
