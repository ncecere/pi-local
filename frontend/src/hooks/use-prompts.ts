import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type LibraryPrompt, type PromptInput } from '~/api/client';
import { filenameFromContentDisposition, saveBlob } from '~/lib/download';

/**
 * The prompt library (docs/api.md, Prompts): saved prompts in the app's prompts folder, offered by the composer's
 * slash menu and edited in Settings → Prompts.
 */

export const PROMPTS_KEY = ['prompts'] as const;

const promptPath = (id: string, rest = '') => `/api/prompts/${encodeURIComponent(id)}${rest}`;

export function usePrompts(enabled = true) {
  return useQuery({
    queryKey: PROMPTS_KEY,
    queryFn: async () => (await api.get<{ prompts: LibraryPrompt[] }>('/api/prompts')).prompts,
    enabled,
    staleTime: 30_000,
  });
}

const refresh = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: PROMPTS_KEY });

export function useCreatePrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PromptInput) => api.post<LibraryPrompt>('/api/prompts', input),
    onSettled: () => refresh(queryClient),
  });
}

export function useUpdatePrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: PromptInput & { id: string }) =>
      api.put<LibraryPrompt>(promptPath(id), input),
    onSettled: () => refresh(queryClient),
  });
}

export function useDeletePrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(promptPath(id)),
    onSettled: () => refresh(queryClient),
  });
}

/**
 * Keeps prompts from a Markdown file or a zip an export made (its bytes as an ArrayBuffer). Answers what was added and
 * how many files were skipped.
 */
export function useImportPrompts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 8 * 1024 * 1024) throw new Error('An import is at most 8 MB.');
      return api.upload<{ prompts: LibraryPrompt[]; skipped: number }>(
        `/api/prompts/import?name=${encodeURIComponent(file.name)}`,
        await file.arrayBuffer(),
        file.name.toLowerCase().endsWith('.zip') ? 'application/zip' : 'text/markdown',
      );
    },
    onSettled: () => refresh(queryClient),
  });
}

/**
 * Saves the whole library as a zip: through the desktop app's Save dialog, or as a download in a browser. Answers the
 * file's path or name, or null when the dialog was cancelled.
 */
export function useExportPrompts() {
  return useMutation({
    mutationFn: async () => {
      try {
        const saved = await api.post<{ path?: string; cancelled?: boolean }>(
          '/api/prompts/export-save',
        );
        if (saved?.cancelled) return null;
        if (saved?.path) return saved.path;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 501) throw error;
      }
      const file = await api.download('/api/prompts/export');
      const filename =
        filenameFromContentDisposition(file.contentDisposition) ?? 'pi-local-prompts.zip';
      saveBlob(file.blob, filename);
      return filename;
    },
  });
}
