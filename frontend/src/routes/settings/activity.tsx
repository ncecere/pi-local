import { ActivityList } from '~/components/activity/activity-list';
import { SettingsSection } from '~/components/settings/settings-layout';
import { usePageTitle } from '~/lib/document-title';

/** Settings → Activity: what every agent did, and what was done to them. */
export function SettingsActivityPage() {
  usePageTitle('Activity · Settings');
  return (
    <SettingsSection title="Activity" first>
      <p className="-mt-2 max-w-2xl text-sm text-[var(--text-muted)]">
        A record of what your agents did: each tool call with what it was given, how it ended and
        how long it took, and the messages sent, schedules run, approvals decided, questions between
        agents, sign-ins, budget refusals and errors. Messages show only their first words.
        Arguments are kept with keys and tokens removed. Entries are kept for 90 days.
      </p>
      <ActivityList />
    </SettingsSection>
  );
}
