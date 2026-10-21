import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type AgentTemplate, ApiError, agentPath, api, type TemplateCategory } from '~/api/client';
import { CATALOG_KEY } from '~/hooks/use-agents';
import { filenameFromContentDisposition, saveBlob } from '~/lib/download';

/**
 * Agent templates (docs/api.md, Templates): the built-ins and the person's
 * own, for the New agent gallery; importing, exporting and deleting them, and
 * saving an agent as one.
 */

export const TEMPLATES_KEY = ['templates'] as const;

export interface TemplateList {
  templates: AgentTemplate[];
  categories: TemplateCategory[];
}

export const templatePath = (id: string, rest = '') =>
  `/api/templates/${encodeURIComponent(id)}${rest}`;

export function useTemplates(enabled = true) {
  return useQuery({
    queryKey: TEMPLATES_KEY,
    queryFn: () => api.get<TemplateList>('/api/templates'),
    enabled,
    staleTime: 60_000,
  });
}

function refresh(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY });
  void queryClient.invalidateQueries({ queryKey: CATALOG_KEY });
}

/** Puts a template the API answered with into the cached list (at once, before the refetch). */
function noteTemplate(queryClient: QueryClient, template: AgentTemplate) {
  queryClient.setQueryData<TemplateList>(TEMPLATES_KEY, (list) =>
    list
      ? {
          ...list,
          templates: [...list.templates.filter((item) => item.id !== template.id), template],
        }
      : list,
  );
}

/**
 * Keeps a shared template file. Its bytes go as an ArrayBuffer (the desktop
 * app drops Blob bodies). `400 invalid_template` says what is wrong.
 */
export function useImportTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) =>
      api.upload<AgentTemplate>(
        '/api/templates',
        new TextEncoder().encode(await file.text()).buffer as ArrayBuffer,
        'application/yaml',
      ),
    onSuccess: (template) => noteTemplate(queryClient, template),
    onSettled: () => refresh(queryClient),
  });
}

/** Deletes one of the person's templates (`409 builtin` for a built-in). */
export function useDeleteTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(templatePath(id)),
    onSuccess: (_data, id) =>
      queryClient.setQueryData<TemplateList>(TEMPLATES_KEY, (list) =>
        list ? { ...list, templates: list.templates.filter((item) => item.id !== id) } : list,
      ),
    onSettled: () => refresh(queryClient),
  });
}

/**
 * Saves a template's YAML file: through the desktop app's Save dialog, or as a download in a browser. Answers the
 * file's path or name, or null when the dialog was cancelled.
 */
export function useExportTemplate() {
  return useMutation({
    mutationFn: async (template: Pick<AgentTemplate, 'id'>) => {
      try {
        const saved = await api.post<{ path?: string; cancelled?: boolean }>(
          templatePath(template.id, '/export-save'),
        );
        if (saved?.cancelled) return null;
        if (saved?.path) return saved.path;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 501) throw error;
      }
      const file = await api.download(templatePath(template.id, '/export'));
      const filename =
        filenameFromContentDisposition(file.contentDisposition) ??
        `${template.id}.pi-template.yaml`;
      saveBlob(file.blob, filename);
      return filename;
    },
  });
}

/** Makes a template of the person's ("yours") from an agent. */
export function useSaveAsTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, ...body }: { agentId: string; name?: string; description?: string }) =>
      api.post<AgentTemplate>(agentPath(agentId, '/save-template'), body),
    onSuccess: (template) => noteTemplate(queryClient, template),
    onSettled: () => refresh(queryClient),
  });
}
