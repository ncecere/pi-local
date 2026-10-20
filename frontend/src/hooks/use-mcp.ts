import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  errorMessage,
  type McpImportList,
  type McpImportResult,
  type McpImportSourceId,
  type McpServer,
  type McpTransport,
} from '~/api/client';
import { AGENTS_KEY } from '~/hooks/use-agents';
import { applyMcpEvent, mcpServerPath } from '~/lib/mcp';

/** The catalog of MCP servers; the `mcp` live event keeps it current. */
export const MCP_SERVERS_KEY = ['mcp', 'servers'] as const;
export const MCP_IMPORT_KEY = ['mcp', 'import'] as const;

export function useMcpServers(enabled = true) {
  return useQuery({
    queryKey: MCP_SERVERS_KEY,
    queryFn: () => api.get<McpServer[]>('/api/mcp/servers'),
    enabled,
    staleTime: 30_000,
  });
}

/** One server as the answer to a request has it, put in the catalog at once. */
function putServer(queryClient: QueryClient, server: McpServer) {
  queryClient.setQueryData<McpServer[]>(MCP_SERVERS_KEY, (list) =>
    applyMcpEvent(list, server.slug, server),
  );
}

/**
 * After a change: the catalog, and the agents (a change restarts the ones
 * using the server; deleting one changes their choices).
 */
function invalidateMcp(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: MCP_SERVERS_KEY }),
    queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true }),
  ]);
}

/** A mutation answering a server: it goes into the catalog, then the lists are re-read. */
function useServerMutation<V>(mutationFn: (variables: V) => Promise<McpServer>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (server) => putServer(queryClient, server),
    onSettled: () => invalidateMcp(queryClient),
  });
}

export interface NewMcpServer {
  slug?: string;
  name: string;
  description?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: boolean;
}

/** Adds a server; the backend tests it before it answers (up to a minute). */
export const useCreateMcpServer = () =>
  useServerMutation((body: NewMcpServer) => api.post<McpServer>('/api/mcp/servers', body));

export interface McpServerChange {
  slug: string;
  name?: string;
  description?: string;
  command?: string;
  args?: string[];
  /** "" or null: the default (${workspace}). */
  cwd?: string | null;
  /** Replaces every value. */
  env?: Record<string, string>;
  url?: string;
  /** Replaces every value. */
  headers?: Record<string, string>;
  oauth?: boolean;
  enabled?: boolean;
}

export const useUpdateMcpServer = () =>
  useServerMutation(({ slug, ...body }: McpServerChange) =>
    api.patch<McpServer>(mcpServerPath(slug), body),
  );

export function useDeleteMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.delete<{ ok: true }>(mcpServerPath(slug)),
    onSuccess: (_data, slug) =>
      queryClient.setQueryData<McpServer[]>(MCP_SERVERS_KEY, (list) =>
        applyMcpEvent(list, slug, null),
      ),
    onSettled: () => invalidateMcp(queryClient),
  });
}

/** Connects to it and lists its tools (stdio: starts it), at most 60 s. */
export const useTestMcpServer = () =>
  useServerMutation((slug: string) => api.post<McpServer>(mcpServerPath(slug, '/test')));

/**
 * Starts an OAuth sign-in in the browser. It answers at once; the outcome
 * comes as an `mcp` live event.
 */
export function useSignInMcpServer() {
  return useMutation({
    mutationFn: (slug: string) =>
      api.post<{ authorizeUrl: string }>(mcpServerPath(slug, '/sign-in')),
  });
}

export const useSignOutMcpServer = () =>
  useServerMutation((slug: string) => api.post<McpServer>(mcpServerPath(slug, '/sign-out')));

/** Servers found in other apps' configs. Read fresh each time it is asked for. */
export function useMcpImportList(enabled: boolean) {
  return useQuery({
    queryKey: MCP_IMPORT_KEY,
    queryFn: () => api.get<McpImportList>('/api/mcp/import'),
    enabled,
    staleTime: 0,
    gcTime: 0,
  });
}

/** Imports servers from one or more sources (one request per source), each tested. */
export function useImportMcpServers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (requests: { source: McpImportSourceId; names: string[] }[]) => {
      const out: McpImportResult = { servers: [], skipped: [] };
      for (const body of requests) {
        try {
          const result = await api.post<McpImportResult>('/api/mcp/import', body);
          out.servers.push(...(result.servers ?? []));
          out.skipped.push(...(result.skipped ?? []));
        } catch (error) {
          // One source failing must not lose what the others added.
          if (requests.length === 1) throw error;
          const reason = errorMessage(error, 'Not imported.');
          out.skipped.push(...body.names.map((name) => ({ name, reason })));
        }
      }
      return out;
    },
    onSuccess: (result) => {
      for (const server of result.servers) putServer(queryClient, server);
    },
    onSettled: () =>
      Promise.all([
        invalidateMcp(queryClient),
        queryClient.invalidateQueries({ queryKey: MCP_IMPORT_KEY }),
      ]),
  });
}
