import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type ThreadDocument, threadPath } from '~/api/client';

export const threadDocumentKey = (
  agentId: string,
  threadId: string,
  kind: string,
  revision?: string,
) => ['thread-document', agentId, threadId, kind, ...(revision === undefined ? [] : [revision])];

/**
 * One exposed document of a conversation, at the revision the chat view says
 * it has: a new revision (a `document.updated` event) is a new read, and the
 * previous value stays on screen until it arrives. A revision's value never
 * changes, so it is never read twice.
 */
export function useThreadDocument(
  agentId: string,
  threadId: string,
  kind: string,
  revision: string,
  enabled = true,
) {
  return useQuery({
    queryKey: threadDocumentKey(agentId, threadId, kind, revision),
    queryFn: () =>
      api.get<ThreadDocument>(
        threadPath(agentId, threadId, `/documents/${encodeURIComponent(kind)}`),
      ),
    placeholderData: keepPreviousData,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: 1,
    enabled,
  });
}
