import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type DiscoveredModel,
  type Model,
  type Provider,
  type ProviderKindId,
  type ProvidersResponse,
} from '~/api/client';
import { AGENTS_KEY, CATALOG_KEY } from '~/hooks/use-agents';
import { modelPath, providerPath } from '~/lib/models';

export const PROVIDERS_KEY = ['providers'] as const;

/** The providers, their models, the kinds and presets to add one from, and the default model. */
export function useProviders() {
  return useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => api.get<ProvidersResponse>('/api/providers'),
    staleTime: 30_000,
  });
}

/**
 * After any change to providers or models: the lists, the agent catalog (its
 * models), and the agents (their model's name; a change restarts the ones on it).
 */
export function invalidateModels(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY }),
    queryClient.invalidateQueries({ queryKey: CATALOG_KEY }),
    queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true }),
  ]);
}

/** A mutation whose success and failure both re-read the lists. */
function useModelsMutation<V, R>(mutationFn: (variables: V) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => invalidateModels(queryClient),
  });
}

export interface NewProvider {
  id?: string;
  name: string;
  kind: ProviderKindId;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export const useCreateProvider = () =>
  useModelsMutation((body: NewProvider) => api.post<Provider>('/api/providers', body));

export interface ProviderChange {
  id: string;
  name?: string;
  baseUrl?: string;
  /** "" removes the key. */
  apiKey?: string;
  /** Replaces them all. */
  headers?: Record<string, string>;
  enabled?: boolean;
}

export const useUpdateProvider = () =>
  useModelsMutation(({ id, ...body }: ProviderChange) =>
    api.patch<Provider>(providerPath(id), body),
  );

export const useDeleteProvider = () =>
  useModelsMutation((id: string) => api.delete<{ ok: true }>(providerPath(id)));

/** Lists a provider's models from its API. Nothing changes, so nothing is re-read. */
export function useDiscoverModels() {
  return useMutation({
    mutationFn: (providerId: string) =>
      api.post<{ models: DiscoveredModel[] }>(providerPath(providerId, '/discover')),
  });
}

export interface ModelSettings {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  images?: boolean;
  inputPrice?: number | null;
  outputPrice?: number | null;
  enabled?: boolean;
}

export const usePutModel = () =>
  useModelsMutation(
    ({ provider, modelId, ...body }: ModelSettings & { provider: string; modelId: string }) =>
      api.put<Model>(modelPath(provider, modelId), body),
  );

export const useDeleteModel = () =>
  useModelsMutation(({ provider, modelId }: { provider: string; modelId: string }) =>
    api.delete<{ ok: true }>(modelPath(provider, modelId)),
  );

export const useSetDefaultModel = () =>
  useModelsMutation((modelId: string) =>
    api.put<{ defaultModelId: string }>('/api/settings/default-model', { modelId }),
  );
