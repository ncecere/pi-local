import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner';
import {
  api,
  type DetectedServer,
  type DiscoveredModel,
  type Model,
  type Provider,
  type ProviderKindId,
  type ProviderSetupResult,
  type ProvidersResponse,
} from '~/api/client';
import { AGENTS_KEY, type AgentCatalog, CATALOG_KEY } from '~/hooks/use-agents';
import { defaultModelNotice, modelPath, providerPath } from '~/lib/models';

export const PROVIDERS_KEY = ['providers'] as const;

/** The providers, their models, the kinds and presets to add one from, and the default model. */
export function useProviders() {
  return useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => api.get<ProvidersResponse>('/api/providers'),
    staleTime: 30_000,
  });
}

/** Known unpriced choices, joined from providers rather than guessing catalog prices. */
export function useUnpricedModels() {
  const providers = useProviders();
  return new Set(
    providers.data?.providers.flatMap((provider) =>
      provider.models
        .filter((model) => model.inputPrice == null && model.outputPrice == null)
        .map((model) => model.id),
    ) ?? [],
  );
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
  /** USD per million cached tokens; null: counted at the input price. */
  cacheReadPrice?: number | null;
  cacheWritePrice?: number | null;
  /** Set every price to the app's list prices for this model. */
  priceFromList?: boolean;
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

/** Its own key, not under PROVIDERS_KEY: every model change shouldn't look for servers again. */
export const DETECT_KEY = ['provider-detect'] as const;

/** Model servers running on this computer (Ollama, LM Studio). Takes up to about a second. */
export function useDetectedServers(enabled = true) {
  return useQuery({
    queryKey: DETECT_KEY,
    queryFn: () => api.get<DetectedServer[]>('/api/providers/detect'),
    enabled,
    staleTime: 0,
  });
}

export interface ProviderSetup {
  preset: string;
  apiKey?: string;
  /** Models to add. Absent: every model of a local server, none of a remote one. */
  models?: string[];
}

/** A provider from a preset in one step: created (or reused), its models listed, the chosen ones added. */
export function useSetupProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ProviderSetup) =>
      api.post<ProviderSetupResult>('/api/providers/setup', body),
    onSettled: () =>
      Promise.all([
        invalidateModels(queryClient),
        queryClient.invalidateQueries({ queryKey: DETECT_KEY }),
      ]),
  });
}

export const useSetDefaultModel = () =>
  useModelsMutation((modelId: string) =>
    api.put<{ defaultModelId: string }>('/api/settings/default-model', { modelId }),
  );

/**
 * Turning off (or removing) the default model, or the provider it comes from,
 * moves the default silently. Call the result before such a change: it notes
 * the default, and the function it returns, called once the change is saved,
 * says so with a toast when the default is another model now.
 */
export function useDefaultModelWatch() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    const before =
      queryClient.getQueryData<ProvidersResponse>(PROVIDERS_KEY)?.defaultModelId ??
      queryClient.getQueryData<AgentCatalog>(CATALOG_KEY)?.defaultModelId ??
      null;
    return async () => {
      try {
        const after = await queryClient.fetchQuery({
          queryKey: PROVIDERS_KEY,
          queryFn: () => api.get<ProvidersResponse>('/api/providers'),
          staleTime: 0,
        });
        const notice = defaultModelNotice(before, after);
        if (notice) toast(notice);
      } catch {
        // Nothing to say if the page can't be read again.
      }
    };
  }, [queryClient]);
}
