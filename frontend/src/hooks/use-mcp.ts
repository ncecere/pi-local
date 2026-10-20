import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  api,
  errorMessage,
  type McpImportList,
  type McpImportResult,
  type McpImportSourceId,
  type McpLoginStatus,
  type McpServer,
  type McpTransport,
} from '~/api/client';
import { AGENTS_KEY } from '~/hooks/use-agents';
import { applyLoginStatus, applyMcpEvent, mcpServerPath } from '~/lib/mcp';

/** The catalog of MCP servers; the `mcp` live event keeps it current. */
export const MCP_SERVERS_KEY = ['mcp', 'servers'] as const;
export const MCP_IMPORT_KEY = ['mcp', 'import'] as const;
/** Every server's sign-in command status; the `mcp-login` live event keeps them current. */
export const MCP_LOGINS_KEY = ['mcp', 'login'] as const;
export const mcpLoginKey = (slug: string) => [...MCP_LOGINS_KEY, slug] as const;

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
  /** stdio: its own sign-in command's arguments. */
  loginArgs?: string[];
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
  /** []: no sign-in command. */
  loginArgs?: string[];
  /** "" or null: the default (${workspace}). */
  cwd?: string | null;
  /** Replaces every value. */
  env?: Record<string, string>;
  url?: string;
  /** Replaces every value. */
  headers?: Record<string, string>;
  /** Change or add some values, keeping the rest (applied after env/headers: remove, then set). */
  envSet?: Record<string, string>;
  envRemove?: string[];
  headersSet?: Record<string, string>;
  headersRemove?: string[];
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

/** A sign-in status put in its query, unless what is there is newer (answers and events can cross). */
export function putMcpLogin(queryClient: QueryClient, status: McpLoginStatus) {
  queryClient.setQueryData<McpLoginStatus>(mcpLoginKey(status.slug), (before) =>
    applyLoginStatus(before, status),
  );
}

/**
 * A stdio server's own sign-in command: the one running, or the last one
 * (`state: "idle"`: none yet). The `mcp-login` live event keeps it current.
 */
export function useMcpLogin(slug: string, enabled = true) {
  return useQuery({
    queryKey: mcpLoginKey(slug),
    queryFn: () => api.get<McpLoginStatus>(mcpServerPath(slug, '/login')),
    enabled,
    staleTime: 30_000,
  });
}

/** `409 login_running`: one is running already (its status is read again). */
export const isLoginRunning = (error: unknown) =>
  error instanceof ApiError && error.code === 'login_running';

/**
 * Runs the server's sign-in command. It answers at once (202); its output and
 * outcome come as `mcp-login` live events, and after a success the backend
 * tests the server again (an `mcp` event).
 */
export function useStartMcpLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.post<McpLoginStatus>(mcpServerPath(slug, '/login')),
    onSuccess: (status) => putMcpLogin(queryClient, status),
    onError: (error, slug) => {
      if (isLoginRunning(error))
        void queryClient.invalidateQueries({ queryKey: mcpLoginKey(slug) });
    },
  });
}

/** Stops the sign-in command that is running. */
export function useCancelMcpLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.delete<McpLoginStatus>(mcpServerPath(slug, '/login')),
    onSuccess: (status) => putMcpLogin(queryClient, status),
    // It may have ended meanwhile: read what it came to.
    onError: (_error, slug) => queryClient.invalidateQueries({ queryKey: mcpLoginKey(slug) }),
  });
}

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

/** One stored env value or header of a server, shown on request (`POST …/reveal`). */
export function revealMcpSecret(
  slug: string,
  kind: 'env' | 'header',
  name: string,
): Promise<string> {
  return api
    .post<{ value: string }>(`${mcpServerPath(slug)}/reveal`, { kind, name })
    .then((data) => data.value);
}
