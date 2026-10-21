import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  type About,
  type Agent,
  type AgentLogs,
  ApiError,
  agentPath,
  api,
  type ChosenFolder,
  type RevealTarget,
} from '~/api/client';
import { AGENTS_KEY, applyAgentEvent, CATALOG_KEY, threadsKey } from '~/hooks/use-agents';
import { TEAMS_KEY } from '~/hooks/use-teams';
import { filenameFromContentDisposition, saveBlob } from '~/lib/download';

/**
 * The agent manager (docs/api.md, "Agent manager (Phase 3)"): an agent's
 * agent.yaml, logs, waking and sleeping, duplicating, exporting and importing,
 * and showing its folders in Finder.
 */

export const configKey = (agentId: string) => ['agents', agentId, 'config'] as const;
export const logsKey = (agentId: string) => ['agents', agentId, 'logs'] as const;
export const ABOUT_KEY = ['about'] as const;

/** Puts an agent the API answered with into the cached list. */
function useNoteAgent() {
  const queryClient = useQueryClient();
  return (agent: Agent) =>
    queryClient.setQueryData<Agent[]>(AGENTS_KEY, (list) => applyAgentEvent(list, agent.id, agent));
}

/**
 * Its agent.yaml as text, for one revision of the agent: read when the editor
 * opens and again after any change to the agent (the revision), never behind
 * someone typing otherwise.
 */
export function useAgentConfig(agentId: string, revision: number, enabled = true) {
  return useQuery({
    queryKey: [...configKey(agentId), revision],
    queryFn: () => api.get<{ yaml: string }>(agentPath(agentId, '/config')),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

/** Replaces agent.yaml. `400 invalid_yaml` says where it is wrong. */
export function usePutAgentConfig(agentId: string) {
  const queryClient = useQueryClient();
  const note = useNoteAgent();
  return useMutation({
    mutationFn: (yaml: string) => api.put<Agent>(agentPath(agentId, '/config'), { yaml }),
    onSuccess: (agent) => {
      note(agent);
      void queryClient.invalidateQueries({ queryKey: configKey(agentId) });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true }),
  });
}

/**
 * The last lines of its runtime log. `live`: read again every 3 s (only while
 * the page is visible: React Query pauses intervals in the background).
 */
export function useAgentLogs(agentId: string, { enabled = true, live = false } = {}) {
  return useQuery({
    queryKey: logsKey(agentId),
    queryFn: () => api.get<AgentLogs>(agentPath(agentId, '/logs?lines=300')),
    enabled,
    refetchInterval: live ? 3_000 : false,
    refetchIntervalInBackground: false,
  });
}

/** Starts its runtime now, or hibernates it. */
export function useAgentPower() {
  const queryClient = useQueryClient();
  const note = useNoteAgent();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'wake' | 'sleep' }) =>
      api.post<Agent>(agentPath(id, `/${action}`)),
    onSuccess: note,
    onSettled: (_data, _error, { id }) => {
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true });
      void queryClient.invalidateQueries({ queryKey: logsKey(id) });
    },
  });
}

/** A new agent with the same configuration and no conversations. */
export function useDuplicateAgent() {
  const queryClient = useQueryClient();
  const note = useNoteAgent();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name?: string }) =>
      api.post<Agent>(agentPath(id, '/duplicate'), name ? { name } : {}),
    onSuccess: note,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true });
      void queryClient.invalidateQueries({ queryKey: CATALOG_KEY });
    },
  });
}

/** Saves (desktop) or downloads (browser) the agent's zip, with or without its conversations (which puts it to sleep). Null: cancelled. */
export function useExportAgent() {
  return useMutation({
    mutationFn: async ({
      agent,
      conversations,
    }: {
      agent: Pick<Agent, 'id' | 'name'>;
      conversations: boolean;
    }) => {
      // The desktop app saves through a native Save dialog (a WKWebView ignores downloads); a browser downloads.
      try {
        const saved = await api.post<{ path?: string; cancelled?: boolean }>(
          agentPath(agent.id, '/export-save'),
          { conversations },
        );
        if (saved?.cancelled) return null;
        if (saved?.path) return saved.path;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 501) throw error;
      }
      const file = await api.download(
        agentPath(agent.id, `/export?conversations=${conversations ? 'true' : 'false'}`),
      );
      const filename =
        filenameFromContentDisposition(file.contentDisposition) ?? fallbackExportName(agent.name);
      saveBlob(file.blob, filename);
      return filename;
    },
  });
}

/** "Research helper.zip" when the server names no file. */
export function fallbackExportName(name: string): string {
  const base = name.replace(/[/\\:*?"<>|]+/g, ' ').trim() || 'agent';
  return `${base}.zip`;
}

/** A new agent from a zip an export made. The bytes go as an ArrayBuffer (Wails drops Blob bodies). */
export function useImportAgent() {
  const queryClient = useQueryClient();
  const note = useNoteAgent();
  return useMutation({
    mutationFn: async (file: File) =>
      api.upload<Agent>('/api/agents/import', await file.arrayBuffer(), 'application/zip'),
    onSuccess: note,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true });
      void queryClient.invalidateQueries({ queryKey: CATALOG_KEY });
    },
  });
}

/** Deletes an agent: its folder goes to the Trash; teams and others' `canCall` forget it. */
export function useDeleteAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(agentPath(id)),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<Agent[]>(AGENTS_KEY, (list) => applyAgentEvent(list, id, null));
      queryClient.removeQueries({ queryKey: threadsKey(id) });
      queryClient.removeQueries({ queryKey: configKey(id) });
      queryClient.removeQueries({ queryKey: logsKey(id) });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true });
      void queryClient.invalidateQueries({ queryKey: CATALOG_KEY });
      void queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
    },
  });
}

/** Opens a folder in Finder: the data folder, an agent's, or its workspace. */
export function useReveal() {
  return useMutation({
    mutationFn: (target: RevealTarget) => api.post<{ ok: true }>('/api/reveal', target),
    onSuccess: () => toast('Opened the folder in Finder.'),
  });
}

/**
 * Opens the native folder dialog (`POST /api/choose-folder`, desktop app only:
 * `features.folderDialog`): the folder picked, or `{cancelled: true}`.
 */
export function useChooseFolder() {
  return useMutation({
    // `title`: what the dialog says (default: "Choose the project folder").
    mutationFn: (title?: string) =>
      api.post<ChosenFolder>('/api/choose-folder', title ? { title } : undefined),
  });
}

/** `GET /api/about`: the app's version, data folder and runtime. */
export function useAbout() {
  return useQuery({
    queryKey: ABOUT_KEY,
    queryFn: () => api.get<About>('/api/about'),
    staleTime: 60_000,
  });
}
