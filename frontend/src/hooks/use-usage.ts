import { useQuery } from '@tanstack/react-query';
import { api, type UsageReport } from '~/api/client';
import type { UsageRange } from '~/lib/usage';

/** What the agents asked of their models over the last `days` days. */
export function useUsage(days: UsageRange) {
  return useQuery({
    queryKey: ['me', 'usage', days],
    queryFn: () => api.get<UsageReport>(`/api/me/usage?days=${days}`),
    // The previous period stays on screen (dimmed) while the next one loads.
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });
}
