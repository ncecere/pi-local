import { FolderOpen } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '~/api/client';
import { SettingsRow, SettingsSection } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import { useAbout, useReveal } from '~/hooks/use-agent-manager';
import { useAgents } from '~/hooks/use-agents';
import { useCurrentUser } from '~/hooks/use-session';
import { usePageTitle } from '~/lib/document-title';

function Value({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <p
      className={
        mono
          ? 'break-all font-mono text-xs text-[var(--text-primary)] sm:max-w-sm sm:text-right'
          : 'text-sm text-[var(--text-primary)] sm:text-right'
      }
    >
      {children}
    </p>
  );
}

/** Settings → About: who the app knows you as, its version, and where your agents live. */
export function SettingsAccountPage() {
  usePageTitle('About · Settings');
  const { user } = useCurrentUser();
  const agents = useAgents();
  const about = useAbout();
  const reveal = useReveal();
  const awake = agents.data?.filter((agent) => agent.status === 'awake').length ?? 0;
  const count = about.data?.agents ?? agents.data?.length;
  const runtime = about.data?.runtime;

  return (
    <>
      <SettingsSection title="Pi Local" first>
        <SettingsRow
          id="name"
          label="Name"
          description="Your name on this computer, from your user account. Agents see it in your messages."
        >
          <Value>{user.name || '—'}</Value>
        </SettingsRow>
        <SettingsRow id="version" label="Version" description="The version of Pi Local running.">
          <Value>{about.data?.version ?? (about.isError ? 'Unknown' : '…')}</Value>
        </SettingsRow>
        <SettingsRow
          id="agents"
          label="Agents"
          description="Each agent runs on this computer, with its own folder for its memory and conversations. An agent sleeps when idle and wakes when you talk to it."
        >
          <Value>
            {count === undefined
              ? '—'
              : `${count} ${count === 1 ? 'agent' : 'agents'}${agents.data ? `, ${awake} awake` : ''}`}
          </Value>
        </SettingsRow>
        <SettingsRow
          id="data"
          label="Data folder"
          description="Where Pi Local keeps your agents, their conversations and its settings."
        >
          <div className="flex flex-col gap-2 sm:items-end">
            <Value mono>{about.data?.dataDir ?? '—'}</Value>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={reveal.isPending}
              onClick={() =>
                reveal.mutate(
                  { target: 'data' },
                  {
                    onError: (error) =>
                      toast.error(errorMessage(error, 'Could not open the folder.')),
                  },
                )
              }
            >
              <FolderOpen />
              Show in Finder
            </Button>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Runtime">
        <SettingsRow
          id="node"
          label="Node.js"
          description="The Node.js that runs each agent's runtime."
        >
          <div className="flex flex-col gap-1 sm:items-end">
            <Value>{runtime?.nodeVersion ?? '—'}</Value>
            {runtime?.node && <Value mono>{runtime.node}</Value>}
          </div>
        </SettingsRow>
        <SettingsRow
          id="pi-durable"
          label="pi-durable"
          description="The agent runtime: it keeps conversations and work in flight across restarts."
        >
          <Value>
            {runtime?.piDurableVersion ?? '—'}
            {runtime?.contractVersion !== undefined && runtime?.contractVersion !== '' && (
              <span className="text-[var(--text-muted)]">
                {' '}
                · contract {String(runtime.contractVersion)}
              </span>
            )}
          </Value>
        </SettingsRow>
        {about.isError && (
          <p className="text-sm text-[var(--danger-on-tint)]">
            {errorMessage(about.error, 'The details could not be read.')}
          </p>
        )}
      </SettingsSection>
    </>
  );
}
