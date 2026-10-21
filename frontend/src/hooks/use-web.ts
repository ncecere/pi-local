import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type WebSearchResult, type WebSettings } from '~/api/client';

/** The web search service agents use (docs/api.md, Web tools). */

export const WEB_SETTINGS_KEY = ['settings', 'web'] as const;

export function useWebSettings(enabled = true) {
  return useQuery({
    queryKey: WEB_SETTINGS_KEY,
    queryFn: () => api.get<WebSettings>('/api/settings/web'),
    enabled,
    staleTime: 30_000,
  });
}

export interface WebSettingsInput {
  /** "": web search off. */
  provider: WebSettings['provider'];
  url?: string;
  /** Left out: the stored key stays; "": it is removed. */
  apiKey?: string;
}

export function useSaveWebSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: WebSettingsInput) => api.put<WebSettings>('/api/settings/web', body),
    onSuccess: (settings) => queryClient.setQueryData(WEB_SETTINGS_KEY, settings),
    onSettled: () => queryClient.invalidateQueries({ queryKey: WEB_SETTINGS_KEY }),
  });
}

/** One search with the saved settings: `409 not_set_up`, or `502 search_failed` with a message. */
export function useTestWebSearch() {
  return useMutation({
    mutationFn: (query?: string) =>
      api.post<{ results: WebSearchResult[] }>('/api/settings/web/test', query ? { query } : {}),
  });
}

/** Whether a search service is chosen: null while unknown (not loaded, or the request failed). */
export function useWebSearchReady(enabled = true): boolean | null {
  const { data } = useWebSettings(enabled);
  return data ? data.provider !== '' : null;
}
