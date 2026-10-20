import { SettingsRow, SettingsSection } from '~/components/settings/settings-layout';
import { useAgents } from '~/hooks/use-agents';
import { useCurrentUser } from '~/hooks/use-session';
import { usePageTitle } from '~/lib/document-title';

function Value({ children }: { children: string }) {
  return <p className="text-sm text-[var(--text-primary)] sm:text-right">{children}</p>;
}

/** Settings → About: who the app knows you as, and where your agents live. */
export function SettingsAccountPage() {
  usePageTitle('About · Settings');
  const { user } = useCurrentUser();
  const agents = useAgents();
  const awake = agents.data?.filter((agent) => agent.status === 'awake').length ?? 0;

  return (
    <SettingsSection title="Pi Local" first>
      <SettingsRow
        id="name"
        label="Name"
        description="Your name on this computer, from your user account. Agents see it in your messages."
      >
        <Value>{user.name || '—'}</Value>
      </SettingsRow>
      <SettingsRow
        id="agents"
        label="Agents"
        description="Each agent runs on this computer, with its own folder for its memory and conversations. An agent sleeps when idle and wakes when you talk to it."
      >
        <Value>
          {agents.data
            ? `${agents.data.length} ${agents.data.length === 1 ? 'agent' : 'agents'}, ${awake} awake`
            : '—'}
        </Value>
      </SettingsRow>
    </SettingsSection>
  );
}
