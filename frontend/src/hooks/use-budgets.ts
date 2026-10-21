import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type AgentBudget, api, type BudgetOverview } from '~/api/client';

export const BUDGETS_KEY = ['budgets'] as const;
const APP_BUDGET_KEY = ['settings', 'budget'] as const;

/** This month's budgets: the app's and each agent's that has one, with what is spent. */
export function useBudgets() {
  return useQuery({
    queryKey: BUDGETS_KEY,
    queryFn: () => api.get<BudgetOverview>('/api/budgets'),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

/** Reads budgets and usage again (a `budget` event, a reply that ended). */
export function useRefreshBudgets() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: BUDGETS_KEY });
    void queryClient.invalidateQueries({ queryKey: ['me', 'usage'] });
  };
}

/** The app-wide monthly budget (Settings → Usage); null: none. */
export function useAppBudget() {
  return useQuery({
    queryKey: APP_BUDGET_KEY,
    queryFn: async () =>
      (await api.get<{ budget: AgentBudget | null }>('/api/settings/budget')).budget,
  });
}

export function useSaveAppBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (budget: AgentBudget | null) =>
      (await api.put<{ budget: AgentBudget | null }>('/api/settings/budget', { budget })).budget,
    onSuccess: (budget) => {
      queryClient.setQueryData(APP_BUDGET_KEY, budget);
      void queryClient.invalidateQueries({ queryKey: BUDGETS_KEY });
      void queryClient.invalidateQueries({ queryKey: ['me', 'usage'] });
    },
  });
}
