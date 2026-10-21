import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type McpServer } from '~/api/client';
import { AGENTS_KEY } from '~/hooks/use-agents';
import { MCP_SERVERS_KEY } from '~/hooks/use-mcp';

export interface Connection {
  id: string;
  name: string;
  icon: string;
  group: 'apps' | 'mail' | 'computer';
  description: string;
  transport: 'http' | 'stdio';
  url?: string;
  command?: string;
  auth: string;
  docsUrl: string;
  advanced: boolean;
  automatic: boolean;
  setup: string[];
  checkedAt: string;
  state: 'not_connected' | 'connected' | 'needs_sign_in' | 'error';
  server: McpServer | null;
  usedBy: { id: string; name: string }[];
  problem?: string;
}
export const CONNECTIONS_KEY = ['connections'] as const;
export function useConnections() {
  return useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: () => api.get<Connection[]>('/api/connections'),
    staleTime: 15_000,
    // Events handle normal updates; this also covers a dropped event stream during sign-in.
    refetchInterval: 30_000,
  });
}
export function useConnectionAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      disconnect,
    }: {
      id: string;
      disconnect?: boolean;
    }): Promise<{ ok: true } | { connection: Connection; authorizeUrl?: string }> =>
      disconnect
        ? api.delete<{ ok: true }>(`/api/connections/${encodeURIComponent(id)}`)
        : api.post<{ connection: Connection; authorizeUrl?: string }>(
            `/api/connections/${encodeURIComponent(id)}/connect`,
          ),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: CONNECTIONS_KEY }),
        client.invalidateQueries({ queryKey: MCP_SERVERS_KEY }),
        client.invalidateQueries({ queryKey: AGENTS_KEY, exact: true }),
        client.invalidateQueries({ queryKey: ['agents', 'catalog'] }),
        client.invalidateQueries({ queryKey: ['templates'] }),
      ]),
  });
}
