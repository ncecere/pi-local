import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  api,
  type JudgmentsInfo,
  type JudgmentTest,
  type RouteResult,
} from '~/api/client';
import { ME_KEY } from '~/hooks/use-session';

/** Fast judgments: the optional System One service (docs/api.md, Fast judgments). */

export const JUDGMENTS_KEY = ['settings', 'judgments'] as const;

export function useJudgments() {
  return useQuery({
    queryKey: JUDGMENTS_KEY,
    queryFn: () => api.get<JudgmentsInfo>('/api/settings/judgments'),
    staleTime: 30_000,
  });
}

export interface JudgmentsInput {
  enabled?: boolean;
  url?: string;
  model?: string;
  /** Left out: the stored key stays; "": it is removed. */
  apiKey?: string;
  uses?: Record<string, boolean>;
  threshold?: number;
}

export function useSaveJudgments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: JudgmentsInput) =>
      api.put<JudgmentsInfo['settings']>('/api/settings/judgments', body),
    onSuccess: (settings) =>
      queryClient.setQueryData<JudgmentsInfo>(JUDGMENTS_KEY, (info) =>
        info ? { ...info, settings } : info,
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: JUDGMENTS_KEY });
      // Agent routing is a feature of /api/me: the new-chat picker offers Auto while it is on.
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

/** The service to list the models of: the form's current values, over the saved ones. */
export interface JudgmentModelsInput {
  url?: string;
  /** Left out: the stored key is used. */
  apiKey?: string;
}

/**
 * The service's models, asked of the address and key typed in the form
 * (`POST …/models`): `502 judge_failed` when it can't be reached. A server
 * without that route (`404`/`405`) answers the saved settings' models (`GET`).
 */
export function useJudgmentModels() {
  return useMutation({
    mutationFn: async (input: JudgmentModelsInput = {}) => {
      try {
        return await api.post<string[]>('/api/settings/judgments/models', input);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 405))
          return api.get<string[]>('/api/settings/judgments/models');
        throw error;
      }
    },
  });
}

/** One question with the saved settings: `502 judge_failed` with a message for people. */
export function useTestJudgments() {
  return useMutation({
    mutationFn: () => api.post<JudgmentTest>('/api/settings/judgments/test', {}),
  });
}

/** Which agent should take a message sent without one: `409 off` when agent routing is off. */
export const routeMessage = (text: string) => api.post<RouteResult>('/api/route', { text });
