import { useQuery } from '@tanstack/react-query';
import { api, type UsageReport } from '~/api/client';
import { type UsageQuery, usageQueryString } from '~/lib/usage';

/** What the agents asked of their models: the last days or one month, all of it or one agent's or model's. */
export function useUsage(query: UsageQuery) {
  return useQuery({
    queryKey: ['me', 'usage', query],
    queryFn: () => api.get<UsageReport>(`/api/me/usage?${usageQueryString(query)}`),
    // The previous period stays on screen (dimmed) while the next one loads.
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });
}
