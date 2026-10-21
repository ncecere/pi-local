import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  ApiError,
  api,
  type ElicitationAction,
  type ElicitationContent,
  type McpElicitation,
} from '~/api/client';
import { noteElicitationAnswer } from '~/lib/elicitation-outcomes';
import { applyElicitationEvent, elicitationsByThread, isElicitation } from '~/lib/elicitations';

/**
 * MCP servers asking the person something during a tool call (docs/api.md,
 * "MCP elicitation"). `['elicitations']` holds every agent's pending ones
 * (`GET /api/elicitations`); the `elicitation` events of /api/events keep it
 * current (use-platform-events.ts), so the slow refresh only covers a stream
 * that was down.
 */

export const ELICITATIONS_KEY = ['elicitations'] as const;

const NONE: McpElicitation[] = [];

export function useElicitations() {
  return useQuery({
    queryKey: ELICITATIONS_KEY,
    queryFn: () => api.get<McpElicitation[]>('/api/elicitations'),
    staleTime: 30_000,
    refetchInterval: 120_000,
    // An older backend has no elicitations: nothing waits.
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
}

/** The pending ones (an empty list while loading, or on an older backend). */
export function usePendingElicitations(): McpElicitation[] {
  const { data } = useElicitations();
  return useMemo(
    () => data?.filter((elicitation) => elicitation.state === 'pending') ?? NONE,
    [data],
  );
}

/** Pending ones by conversation key (`agentId/threadId`), oldest first. */
export function useElicitationsByThread(): Map<string, McpElicitation[]> {
  const { data } = useElicitations();
  return useMemo(() => elicitationsByThread(data), [data]);
}

/**
 * An `elicitation` event's data applied to the pending list: added or updated
 * while pending, dropped otherwise. Says what it was, and whether it is newly
 * asked (not in the list before), or null when the data isn't one.
 */
export function applyElicitationData(
  queryClient: QueryClient,
  data: string,
): { elicitation: McpElicitation; isNew: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isElicitation(parsed)) {
    void queryClient.invalidateQueries({ queryKey: ELICITATIONS_KEY });
    return null;
  }
  noteElicitationAnswer(parsed);
  const list = queryClient.getQueryData<McpElicitation[]>(ELICITATIONS_KEY);
  const isNew =
    parsed.state === 'pending' && !list?.some((candidate) => candidate.id === parsed.id);
  if (list === undefined) void queryClient.invalidateQueries({ queryKey: ELICITATIONS_KEY });
  else
    queryClient.setQueryData<McpElicitation[]>(ELICITATIONS_KEY, (current) =>
      applyElicitationEvent(current, parsed),
    );
  return { elicitation: parsed, isNew };
}

/**
 * Answers one: accept (with the form's content), decline or cancel. The answer
 * (and the `elicitation` event) take it out of the pending list; `409
 * not_pending`: it was already answered or expired, so the list is read again.
 */
export function useAnswerElicitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      content,
    }: {
      id: string;
      action: ElicitationAction;
      content?: ElicitationContent;
    }) =>
      api.post<McpElicitation>(
        `/api/elicitations/${encodeURIComponent(id)}`,
        action === 'accept' ? { action, content: content ?? {} } : { action },
      ),
    onSuccess: (answered, { id }) => {
      if (answered && typeof answered === 'object') noteElicitationAnswer(answered);
      queryClient.setQueryData<McpElicitation[]>(ELICITATIONS_KEY, (list) =>
        answered && typeof answered === 'object'
          ? applyElicitationEvent(list, answered)
          : list?.filter((candidate) => candidate.id !== id),
      );
    },
    onError: (error) => {
      if (error instanceof ApiError && (error.code === 'not_pending' || error.status === 404))
        void queryClient.invalidateQueries({ queryKey: ELICITATIONS_KEY });
    },
  });
}
