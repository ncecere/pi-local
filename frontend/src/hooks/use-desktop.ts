import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DesktopSettings } from '~/api/client';

/** The desktop app's own settings (docs/api.md, "The desktop app"); `available` is false in a browser. */
export const DESKTOP_KEY = ['settings', 'desktop'] as const;

export function useDesktopSettings() {
  return useQuery({
    queryKey: DESKTOP_KEY,
    queryFn: () => api.get<DesktopSettings>('/api/settings/desktop'),
    staleTime: 60_000,
  });
}

/** Opens Pi Local (in the menu bar, its window closed) when you log in, or stops doing so. */
export function useSetLaunchAtLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (launchAtLogin: boolean) =>
      api.put<DesktopSettings>('/api/settings/desktop', { launchAtLogin }),
    onMutate: async (launchAtLogin) => {
      await queryClient.cancelQueries({ queryKey: DESKTOP_KEY });
      const before = queryClient.getQueryData<DesktopSettings>(DESKTOP_KEY);
      if (before)
        queryClient.setQueryData<DesktopSettings>(DESKTOP_KEY, { ...before, launchAtLogin });
      return { before };
    },
    onSuccess: (settings) => queryClient.setQueryData(DESKTOP_KEY, settings),
    onError: (_error, _value, context) => {
      if (context?.before) queryClient.setQueryData(DESKTOP_KEY, context.before);
    },
  });
}
