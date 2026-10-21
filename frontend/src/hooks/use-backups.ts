import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type Backup, type BackupList } from '~/api/client';
import { filenameFromContentDisposition, saveBlob } from '~/lib/download';

/**
 * Backups of the data folder, and the diagnostics bundle (docs/api.md,
 * "Backups and diagnostics (v0.3)"). A `backup` event on /api/events (a
 * backup made, deleted, a setting changed, a restore recorded) reads the list
 * again (use-platform-events.ts).
 */
export const BACKUPS_KEY = ['backups'] as const;

export function useBackups() {
  return useQuery({
    queryKey: BACKUPS_KEY,
    queryFn: () => api.get<BackupList>('/api/backups'),
    // A backup of a big workspace takes a while: while one runs, look now and then.
    refetchInterval: (query) => (query.state.data?.running ? 3_000 : false),
  });
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: BACKUPS_KEY });
}

/**
 * Makes a backup now, in the backup folder or in `folder`. Agents that are awake sleep while their conversations are
 * copied, then wake again.
 */
export function useCreateBackup() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (folder?: string) =>
      api.post<Backup>('/api/backups', folder ? { folder } : undefined),
    onSettled: refresh,
  });
}

/** The daily automatic backup, on or off. */
export function useSetBackupAuto() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (auto: boolean) => api.put<BackupList>('/api/backups/settings', { auto }),
    onMutate: async (auto) => {
      await queryClient.cancelQueries({ queryKey: BACKUPS_KEY });
      const before = queryClient.getQueryData<BackupList>(BACKUPS_KEY);
      if (before) queryClient.setQueryData<BackupList>(BACKUPS_KEY, { ...before, auto });
      return { before };
    },
    onSuccess: (list) => queryClient.setQueryData(BACKUPS_KEY, list),
    onError: (_error, _value, context) => {
      if (context?.before) queryClient.setQueryData(BACKUPS_KEY, context.before);
    },
  });
}

export function useDeleteBackup() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/api/backups/${id}`),
    onSettled: refresh,
  });
}

/** Shows the backup's file in Finder. */
export function useRevealBackup() {
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true }>(`/api/backups/${id}/reveal`),
  });
}

/**
 * Restores a backup: the app restarts (`restarting`), or has to be quit and opened by hand (it says so), and
 * applies it as it starts. The current data is moved aside, not deleted.
 */
export function useRestoreBackup() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ restarting: boolean }>(`/api/backups/${id}/restore`, { confirm: 'restore' }),
    onSettled: refresh,
  });
}

/** Takes back a restore that is waiting for the restart. */
export function useCancelRestore() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => api.delete<{ ok: true }>('/api/backups/pending-restore'),
    onSettled: refresh,
  });
}

/**
 * Saves the diagnostics zip: through the desktop app's Save dialog, or as a download in a browser. Answers the file's
 * path or name, or null when the dialog was cancelled.
 */
export function useSaveDiagnostics() {
  return useMutation({
    mutationFn: async () => {
      try {
        const saved = await api.post<{ path?: string; cancelled?: boolean }>('/api/diagnostics');
        if (saved?.cancelled) return null;
        if (saved?.path) return saved.path;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 501) throw error;
      }
      const file = await api.download('/api/diagnostics');
      const filename =
        filenameFromContentDisposition(file.contentDisposition) ?? 'pi-local-diagnostics.zip';
      saveBlob(file.blob, filename);
      return filename;
    },
  });
}
