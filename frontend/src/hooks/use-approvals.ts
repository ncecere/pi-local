import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ApiError, type Approval, type ApprovalRule, agentPath, api } from '~/api/client';
import { AGENTS_KEY } from '~/hooks/use-agents';
import { applyApprovalEvent, approvalsByThread } from '~/lib/approvals';

/**
 * Tool calls waiting for the person (docs/api.md, Phase 4). `['approvals']`
 * holds every agent's pending requests (`GET /api/approvals`); the `approval`
 * events of /api/events keep it current (use-platform-events.ts), so the slow
 * refresh only covers a stream that was down.
 */

export const APPROVALS_KEY = ['approvals'] as const;

export function usePendingApprovals() {
  return useQuery({
    queryKey: APPROVALS_KEY,
    queryFn: () => api.get<Approval[]>('/api/approvals?status=pending'),
    staleTime: 30_000,
    refetchInterval: 120_000,
    // An older backend has no approvals: nothing waits.
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
}

/** Pending requests by conversation key (`agentId/threadId`). */
export function useApprovalsByThread(): Map<string, Approval[]> {
  const { data } = usePendingApprovals();
  return useMemo(() => approvalsByThread(data), [data]);
}

export type Decision = 'approve' | 'deny';

/**
 * Approves or denies a request. The answer (and the `approval` event) take it
 * out of the pending list; `409 approval_decided`: it no longer waits (decided
 * elsewhere, timed out), so the list is read again.
 */
export function useDecideApproval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      approvalId,
      decision,
      reason,
    }: {
      agentId: string;
      approvalId: string;
      decision: Decision;
      reason?: string;
    }) =>
      api.post<Approval>(agentPath(agentId, `/approvals/${encodeURIComponent(approvalId)}`), {
        decision,
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: (approval) => {
      queryClient.setQueryData<Approval[]>(APPROVALS_KEY, (list) =>
        applyApprovalEvent(list, approval),
      );
      // The agent's `pendingApprovals` changed too (an `agent` event may also say so).
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'approval_decided')
        void queryClient.invalidateQueries({ queryKey: APPROVALS_KEY });
    },
  });
}

/**
 * "Approve and always allow this" (the rule) and the Tools tab's list (remove):
 * `POST` and `DELETE /api/agents/{a}/approval-rules`. A change reaches the
 * running agent without a restart; the agent's rules (`agent.approvals.rules`)
 * are read again.
 */
export function useAddApprovalRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      ...rule
    }: {
      agentId: string;
      tool: string;
      args?: Record<string, string>;
      action?: ApprovalRule['action'];
    }) =>
      api.post<{ rule: ApprovalRule; rules: ApprovalRule[] }>(
        agentPath(agentId, '/approval-rules'),
        rule,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true }),
  });
}

export function useRemoveApprovalRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, ruleId }: { agentId: string; ruleId: string }) =>
      api.delete<{ rules: ApprovalRule[] }>(
        agentPath(agentId, `/approval-rules/${encodeURIComponent(ruleId)}`),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true }),
  });
}
