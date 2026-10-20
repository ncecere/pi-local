import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agentPath, api, type Schedule, type ScheduleInput, type ScheduleRun } from '~/api/client';
import { applyRunToHistory, applyScheduleEvent, applyScheduleRun } from '~/lib/schedules';

/**
 * Schedules (docs/api.md, "Always on"). One cached list of every agent's
 * (['schedules']); an agent's page filters it. Changes arrive live as
 * `schedule` and `schedule_run` events on /api/events (use-platform-events.ts).
 */
export const SCHEDULES_KEY = ['schedules'] as const;
export const scheduleRunsKey = (scheduleId: string) => ['schedule-runs', scheduleId] as const;

const schedulePath = (id: string, rest = '') => `/api/schedules/${encodeURIComponent(id)}${rest}`;

export function useSchedules(enabled = true) {
  return useQuery({
    queryKey: SCHEDULES_KEY,
    queryFn: () => api.get<Schedule[]>('/api/schedules'),
    enabled,
    staleTime: 30_000,
    // Next-fire times move on; the list is cheap.
    refetchInterval: 120_000,
  });
}

/** One agent's schedules, from the shared list. */
export function useAgentSchedules(agentId: string) {
  const query = useSchedules();
  return {
    ...query,
    data: query.data?.filter((schedule) => schedule.agentId === agentId),
  };
}

/** A schedule's runs, newest first: read when its row is opened. */
export function useScheduleRuns(scheduleId: string, enabled = true, limit = 20) {
  return useQuery({
    queryKey: scheduleRunsKey(scheduleId),
    queryFn: () => api.get<ScheduleRun[]>(schedulePath(scheduleId, `/runs?limit=${limit}`)),
    enabled,
    staleTime: 15_000,
  });
}

function useSetSchedule() {
  const queryClient = useQueryClient();
  return (schedule: Schedule) =>
    queryClient.setQueryData<Schedule[]>(SCHEDULES_KEY, (list) =>
      applyScheduleEvent(list, schedule.id, schedule),
    );
}

export function useCreateSchedule() {
  const queryClient = useQueryClient();
  const set = useSetSchedule();
  return useMutation({
    mutationFn: ({ agentId, ...body }: ScheduleInput & { agentId: string }) =>
      api.post<Schedule>(agentPath(agentId, '/schedules'), body),
    onSuccess: set,
    onSettled: () => queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY }),
  });
}

export function useUpdateSchedule() {
  const queryClient = useQueryClient();
  const set = useSetSchedule();
  return useMutation({
    mutationFn: ({ id, ...body }: ScheduleInput & { id: string }) =>
      api.patch<Schedule>(schedulePath(id), body),
    onSuccess: set,
    onSettled: () => queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY }),
  });
}

export function useDeleteSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(schedulePath(id)),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<Schedule[]>(SCHEDULES_KEY, (list) =>
        applyScheduleEvent(list, id, null),
      );
      queryClient.removeQueries({ queryKey: scheduleRunsKey(id) });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY }),
  });
}

/** Runs it now (its next time doesn't change): the run starts, and its row says so. */
export function useRunSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ScheduleRun>(schedulePath(id, '/run')),
    onSuccess: (run) => {
      queryClient.setQueryData<Schedule[]>(SCHEDULES_KEY, (list) =>
        applyScheduleRun(list, { scheduleId: run.scheduleId, run }),
      );
      queryClient.setQueryData<ScheduleRun[]>(scheduleRunsKey(run.scheduleId), (runs) =>
        applyRunToHistory(runs, run),
      );
    },
  });
}
