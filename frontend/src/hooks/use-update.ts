import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type UpdateStage, type UpdateStatus } from '~/api/client';
import { isEventsLive } from '~/lib/events-live';

/**
 * Updating Pi Local from its GitHub releases (docs/api.md, "Updates"). The
 * status also arrives live as `update` events on /api/events
 * (use-platform-events.ts), so an install's stages follow without polling.
 * Every endpoint answers 501 where there are no updates at all.
 */
export const UPDATE_KEY = ['update'] as const;

/** An install under way: everything but nothing and `failed`. */
export function installing(stage: UpdateStage | null | undefined): boolean {
  return Boolean(stage) && stage !== 'failed';
}

/** A 501: this build or server has no updates. */
export function updatesUnsupported(error: unknown): boolean {
  return error instanceof ApiError && error.status === 501;
}

export function useUpdateStatus() {
  return useQuery({
    queryKey: UPDATE_KEY,
    queryFn: () => api.get<UpdateStatus>('/api/update'),
    staleTime: 60_000,
    retry: (count, error) => !updatesUnsupported(error) && count < 2,
    // An install's stages come as events; without the stream, look now and then.
    refetchInterval: (query) =>
      installing(query.state.data?.stage) && !isEventsLive() ? 2_000 : false,
  });
}

function useStatusMutation<T>(mutationFn: (value: T) => Promise<UpdateStatus>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (status) => queryClient.setQueryData(UPDATE_KEY, status),
  });
}

/** Asks GitHub for the latest release now. */
export const useCheckForUpdate = () =>
  useStatusMutation<void>(() => api.post<UpdateStatus>('/api/update/check'));

/** Downloads, verifies and installs the latest release, then restarts (in the background: 202). */
export const useInstallUpdate = () =>
  useStatusMutation<void>(() => api.post<UpdateStatus>('/api/update/install'));

/** Checks for updates on its own (at start and now and then), or stops doing so. */
export function useSetUpdateAutoCheck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (autoCheck: boolean) =>
      api.put<UpdateStatus>('/api/update/settings', { autoCheck }),
    onMutate: async (autoCheck) => {
      await queryClient.cancelQueries({ queryKey: UPDATE_KEY });
      const before = queryClient.getQueryData<UpdateStatus>(UPDATE_KEY);
      if (before) queryClient.setQueryData<UpdateStatus>(UPDATE_KEY, { ...before, autoCheck });
      return { before };
    },
    onSuccess: (status) => queryClient.setQueryData(UPDATE_KEY, status),
    onError: (_error, _value, context) => {
      if (context?.before) queryClient.setQueryData(UPDATE_KEY, context.before);
    },
  });
}
