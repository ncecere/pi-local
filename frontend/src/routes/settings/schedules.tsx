import { errorMessage } from '~/api/client';
import { ErrorNotice } from '~/components/models/fields';
import { ScheduleList } from '~/components/schedules/schedule-list';
import { SettingsSection } from '~/components/settings/settings-layout';
import { Spinner } from '~/components/ui/spinner';
import { useAgents } from '~/hooks/use-agents';
import { useSchedules } from '~/hooks/use-schedules';
import { usePageTitle } from '~/lib/document-title';

/** Settings → Schedules: every agent's schedules, next to fire first. */
export function SettingsSchedulesPage() {
  usePageTitle('Schedules · Settings');
  const schedules = useSchedules();
  const agents = useAgents();

  if (schedules.isError)
    return (
      <SettingsSection title="Schedules" first>
        <ErrorNotice>
          {errorMessage(schedules.error, 'The schedules could not be loaded.')}
        </ErrorNotice>
      </SettingsSection>
    );
  if (!schedules.data || !agents.data)
    return (
      <div className="py-12">
        <Spinner className="mx-auto" />
      </div>
    );

  return (
    <SettingsSection title="Schedules" first>
      <p className="-mt-2 text-sm text-[var(--text-muted)]">
        A schedule sends an agent a message at set times: a reminder once, or recurring work. Pi
        Local keeps running in the menu bar when its window is closed, so they still run; quit it
        and they wait until it opens again.
      </p>
      <ScheduleList
        schedules={schedules.data}
        agents={agents.data.filter((agent) => agent.enabled)}
        emptyText="No schedules yet. Make one here, or let an agent set its own on its Schedules tab."
      />
    </SettingsSection>
  );
}
