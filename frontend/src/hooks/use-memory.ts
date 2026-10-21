import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Agent,
  type AgentMemory,
  agentPath,
  api,
  type Basics,
  type Fact,
  type MemoryNote,
  type MemorySuggestionSettings,
  type YouInfo,
} from '~/api/client';
import { AGENTS_KEY, applyAgentEvent } from '~/hooks/use-agents';
import { filenameFromContentDisposition, saveBlob } from '~/lib/download';

/** What agents know about the person, and each agent's own notes (docs/api.md, Memory). */

export const YOU_KEY = ['you'] as const;
export const FACTS_KEY = ['you', 'memories'] as const;
export const notesKey = (agentId: string) => ['agents', agentId, 'memory'] as const;

const youPath = (rest = '') => `/api/you${rest}`;
const factPath = (id: string) => youPath(`/memories/${encodeURIComponent(id)}`);
const notePath = (agentId: string, noteId?: string) =>
  agentPath(agentId, noteId ? `/memory/${encodeURIComponent(noteId)}` : '/memory');

export function useYou() {
  return useQuery({
    queryKey: YOU_KEY,
    queryFn: () => api.get<YouInfo>(youPath()),
    staleTime: 30_000,
  });
}

export function useSaveBasics() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (basics: Basics) => api.put<Basics>(youPath('/basics'), basics),
    onSuccess: (basics) =>
      queryClient.setQueryData<YouInfo>(YOU_KEY, (you) =>
        you ? { ...you, basics, saved: true } : you,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: YOU_KEY, exact: true }),
  });
}

/**
 * Turns suggestions from conversations on or off (the one system-wide switch). The switch
 * moves at once; a refusal puts it back.
 */
export function useSaveSuggestions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.put<MemorySuggestionSettings>(youPath('/settings'), { suggestions: enabled }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: YOU_KEY, exact: true });
      const before = queryClient.getQueryData<YouInfo>(YOU_KEY);
      queryClient.setQueryData<YouInfo>(YOU_KEY, (you) =>
        you ? { ...you, suggestions: { judged: you.suggestions?.judged ?? false, enabled } } : you,
      );
      return { before };
    },
    onError: (_error, _enabled, context) => queryClient.setQueryData(YOU_KEY, context?.before),
    onSettled: () => queryClient.invalidateQueries({ queryKey: YOU_KEY, exact: true }),
  });
}

/** Every fact, known and suggested: the page splits them. */
export function useFacts() {
  return useQuery({
    queryKey: FACTS_KEY,
    queryFn: () => api.get<Fact[]>(youPath('/memories')),
    staleTime: 15_000,
  });
}

/**
 * Suggestions waiting for a yes (`?status=suggested`), for the badge that says so
 * outside Settings → You. Under `FACTS_KEY`, so every change to the facts, and the
 * `memory` live event, refreshes it.
 */
export const SUGGESTED_KEY = [...FACTS_KEY, 'suggested'] as const;
export function useSuggestedFacts() {
  return useQuery({
    queryKey: SUGGESTED_KEY,
    queryFn: () => api.get<Fact[]>(youPath('/memories?status=suggested')),
    staleTime: 15_000,
    // A server without the filter lists everything: only suggestions count.
    select: (facts) => facts.filter((fact) => fact.status === 'suggested'),
  });
}

function useFactMutation<V>(request: (variables: V) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSettled: () => queryClient.invalidateQueries({ queryKey: FACTS_KEY }),
  });
}

export const useAddFact = () =>
  useFactMutation((body: { category: string; text: string; pinned?: boolean }) =>
    api.post<Fact>(youPath('/memories'), body),
  );

export const useUpdateFact = () =>
  useFactMutation(
    ({
      id,
      ...body
    }: {
      id: string;
      category?: string;
      text?: string;
      pinned?: boolean;
      accept?: true;
    }) => api.patch<Fact>(factPath(id), body),
  );

export function useDeleteFact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(factPath(id)),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: FACTS_KEY });
      queryClient.setQueryData<Fact[]>(FACTS_KEY, (facts) => facts?.filter((f) => f.id !== id));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: FACTS_KEY }),
  });
}

/** Forgets everything about the person, the About me card included. */
export function useEraseYou() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(youPath('/erase'), { confirm: 'erase' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: YOU_KEY }),
  });
}

/** Downloads everything about the person as JSON. */
export function useExportYou() {
  return useMutation({
    mutationFn: async () => {
      const file = await api.download(youPath('/export'));
      saveBlob(
        file.blob,
        filenameFromContentDisposition(file.contentDisposition) ?? 'pi-local-about-you.json',
      );
    },
  });
}

// ── An agent's own notes ────────────────────────────────────────────────────────────────────

/** Its notes, newest first. */
export function useAgentNotes(agentId: string) {
  return useQuery({
    queryKey: notesKey(agentId),
    queryFn: () => api.get<MemoryNote[]>(notePath(agentId)),
    staleTime: 15_000,
    select: (notes) => [...notes].sort((a, b) => b.updatedAt - a.updatedAt),
  });
}

function useNoteMutation<V extends { agentId: string }>(
  request: (variables: V) => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSettled: (_data, _error, { agentId }) =>
      queryClient.invalidateQueries({ queryKey: notesKey(agentId) }),
  });
}

export const useAddNote = () =>
  useNoteMutation(({ agentId, text }: { agentId: string; text: string }) =>
    api.post<MemoryNote>(notePath(agentId), { text }),
  );

export const useUpdateNote = () =>
  useNoteMutation(({ agentId, id, text }: { agentId: string; id: string; text: string }) =>
    api.patch<MemoryNote>(notePath(agentId, id), { text }),
  );

export const useDeleteNote = () =>
  useNoteMutation(({ agentId, id }: { agentId: string; id: string }) =>
    api.delete(notePath(agentId, id)),
  );

/** Forgets all of an agent's notes. */
export const useResetNotes = () =>
  useNoteMutation(({ agentId }: { agentId: string }) => api.delete(notePath(agentId)));

/** An agent's memory settings, as the agent list has them (on, sharing nothing more, when absent). */
export const memoryOf = (agent: Pick<Agent, 'memory'>): AgentMemory => ({
  off: agent.memory?.off ?? false,
  share: agent.memory?.share ?? [],
});

/**
 * Saves an agent's memory settings. The list shows the change at once, so a
 * table of switches and checkboxes does not flicker back while it saves.
 */
export function useSaveAgentMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, memory }: { id: string; memory: AgentMemory }) =>
      api.patch<Agent>(agentPath(id), { memory }),
    onMutate: async ({ id, memory }) => {
      await queryClient.cancelQueries({ queryKey: AGENTS_KEY, exact: true });
      const before = queryClient.getQueryData<Agent[]>(AGENTS_KEY);
      queryClient.setQueryData<Agent[]>(AGENTS_KEY, (list) =>
        list?.map((agent) => (agent.id === id ? { ...agent, memory } : agent)),
      );
      return { before };
    },
    onError: (_error, _variables, context) => queryClient.setQueryData(AGENTS_KEY, context?.before),
    onSuccess: (agent) =>
      queryClient.setQueryData<Agent[]>(AGENTS_KEY, (list) =>
        applyAgentEvent(list, agent.id, agent),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true }),
  });
}

/**
 * What a `remember` tool call saved, from its result's text: "Saved (um_…, work).",
 * "Saved as a suggestion … (um_…); …", "Saved to your notes (an_…)." Null for anything else.
 */
export interface RememberResult {
  kind: 'known' | 'suggested' | 'note';
  id: string;
}

export function rememberResultOf(text: string | null | undefined): RememberResult | null {
  if (!text) return null;
  const id = /\(((?:um|an)_[A-Za-z0-9_-]+)/.exec(text)?.[1];
  if (!id) return null;
  const trimmed = text.trimStart();
  if (trimmed.startsWith('Saved to your notes')) return { kind: 'note', id };
  if (trimmed.startsWith('Saved as a suggestion')) return { kind: 'suggested', id };
  if (trimmed.startsWith('Saved (')) return { kind: id.startsWith('an_') ? 'note' : 'known', id };
  return null;
}

/** Deletes what a `remember` saved: a fact about the person (`um_…`) or one of the agent's notes (`an_…`). */
export function useUndoRemember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, id }: { agentId: string | undefined; id: string }) => {
      if (id.startsWith('an_')) {
        if (!agentId) throw new Error('No agent for this note.');
        return api.delete(notePath(agentId, id));
      }
      return api.delete(factPath(id));
    },
    onSettled: (_data, _error, { agentId, id }) =>
      id.startsWith('an_') && agentId
        ? queryClient.invalidateQueries({ queryKey: notesKey(agentId) })
        : queryClient.invalidateQueries({ queryKey: FACTS_KEY }),
  });
}
