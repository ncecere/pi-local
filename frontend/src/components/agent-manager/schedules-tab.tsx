import { useId } from 'react';
import { toast } from 'sonner';
import { type Agent, errorMessage } from '~/api/client';
import { ErrorNotice } from '~/components/models/fields';
import { ScheduleList } from '~/components/schedules/schedule-list';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { useUpdateAgent } from '~/hooks/use-agents';
import { useAgentSchedules } from '~/hooks/use-schedules';
import { AGENT_SCHEDULE_LIMITS } from '~/lib/schedules';

/** An agent's schedules, and whether it may set its own. */
export function SchedulesTab({ agent }: { agent: Agent }) {
  const id = useId();
  const schedules = useAgentSchedules(agent.id);
  const update = useUpdateAgent();
  const agentMade = agent.schedules?.agentMade ?? false;
  const { count, minMinutes, runsPerDay } = AGENT_SCHEDULE_LIMITS;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-6 rounded-xl border border-[var(--border-subtle)] p-4">
        <div className="min-w-0">
          <p id={`${id}-own-label`} className="text-sm font-medium">
            Let it set its own reminders and recurring work
          </p>
          <p
            id={`${id}-own-hint`}
            className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]"
          >
            {agent.name} gets tools to schedule a message to itself, list its schedules and cancel
            them, so "remind me tomorrow at 9" or "check this every morning" just works. Within
            limits: at most {count} schedules, each at most every {minMinutes} minutes, and{' '}
            {runsPerDay} runs a day. What it sets shows here, marked as set by the agent, and you
            can pause, change or delete it.
          </p>
        </div>
        <Switch
          checked={agentMade}
          disabled={update.isPending}
          aria-labelledby={`${id}-own-label`}
          aria-describedby={`${id}-own-hint`}
          onCheckedChange={(on) =>
            update.mutate(
              { id: agent.id, schedules: { agentMade: on } },
              {
                onSuccess: () =>
                  toast(
                    on
                      ? `${agent.name} can set its own schedules.`
                      : `${agent.name} can no longer set schedules. Those it set stay.`,
                  ),
                onError: (error) => toast.error(errorMessage(error)),
              },
            )
          }
        />
      </div>

      {schedules.isError ? (
        <ErrorNotice>
          {errorMessage(schedules.error, 'The schedules could not be loaded.')}
        </ErrorNotice>
      ) : !schedules.data ? (
        <Spinner className="mx-auto" />
      ) : (
        <div className="flex flex-col gap-4">
          <ScheduleList
            schedules={schedules.data}
            agents={[agent]}
            agentId={agent.id}
            emptyText={`${agent.name} has no schedules yet.`}
          />
        </div>
      )}
    </div>
  );
}
