import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { type ActivityFilters, type ActivityPage, ApiError, api } from '~/api/client';
import { activityQuery } from '~/lib/activity';
import { filenameFromContentDisposition, saveBlob } from '~/lib/download';

/**
 * The audit log (docs/api.md, "Activity (v0.3)"). It isn't pushed: a list is read again when its page is shown
 * again, and a conversation's timeline now and then while its panel is open.
 */
export const ACTIVITY_KEY = ['activity'] as const;

const PAGE = 100;

/** Entries newest first, a page at a time (`fetchNextPage` reads the older ones). */
export function useActivity(filters: ActivityFilters, { enabled = true } = {}) {
  return useInfiniteQuery({
    queryKey: [...ACTIVITY_KEY, 'list', filters] as const,
    queryFn: ({ pageParam }) =>
      api.get<ActivityPage>(
        `/api/activity?${activityQuery(filters, { before: pageParam, limit: PAGE })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled,
    staleTime: 10_000,
  });
}

/** What the log says about one conversation (up to 500 entries, the newest), read again every few seconds while `live`. */
export function useThreadActivity(
  agentId: string,
  threadId: string,
  { enabled = true, live = false } = {},
) {
  return useQuery({
    queryKey: [...ACTIVITY_KEY, 'thread', agentId, threadId] as const,
    queryFn: () =>
      api.get<ActivityPage>(
        `/api/activity?${activityQuery({ agent: agentId, thread: threadId }, { limit: 500 })}`,
      ),
    enabled,
    refetchInterval: live ? 4_000 : false,
    staleTime: 2_000,
  });
}

/**
 * Saves the entries a filter matches as CSV: through the desktop app's Save dialog, or as a download in a browser.
 * Answers the file's path or name, or null when the dialog was cancelled.
 */
export function useExportActivity() {
  return useMutation({
    mutationFn: async (filters: ActivityFilters) => {
      const query = activityQuery(filters);
      try {
        const saved = await api.post<{ path?: string; cancelled?: boolean }>(
          `/api/activity/export?${query}`,
        );
        if (saved?.cancelled) return null;
        if (saved?.path) return saved.path;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 501) throw error;
      }
      const file = await api.download(`/api/activity/export?${query}`);
      const name =
        filenameFromContentDisposition(file.contentDisposition) ?? 'pi-local-activity.csv';
      saveBlob(file.blob, name);
      return name;
    },
  });
}
