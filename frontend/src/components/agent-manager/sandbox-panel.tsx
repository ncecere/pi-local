import { TriangleAlert } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { type Agent, errorMessage } from '~/api/client';
import { Panel, saveAgentChange } from '~/components/agent-manager/panel';
import { ErrorNotice } from '~/components/models/fields';
import { Switch } from '~/components/ui/switch';
import { useUpdateAgent } from '~/hooks/use-agents';
import { normaliseTools } from '~/lib/approvals';

/** What the sandbox allows, as the panel says it (docs/api.md, "Sandboxed shell"). */
export const SANDBOX_ALLOWS = [
  'Read files anywhere, except your keys and credentials (~/.ssh, ~/.aws, ~/.gnupg, the keychain) and other agents’ data.',
  'Write only in its workspace, its temp folder and /tmp.',
  'Run any program.',
] as const;

/**
 * "Run commands in a sandbox" and the network switch, each saved as soon as it
 * is switched. Shown for an agent that has the `bash` tool. A save sends the
 * saved tools and folder with it (the API replaces them), so `disabled` keeps
 * it from discarding unsaved edits of the Tools form beside it.
 */
export function SandboxPanel({ agent, disabled = false }: { agent: Agent; disabled?: boolean }) {
  const id = useId();
  const update = useUpdateAgent();
  const workspace = agent.workspace;
  if (!workspace || !normaliseTools(workspace.tools).includes('bash')) return null;

  const available = workspace.sandboxAvailable !== false;
  // While a change saves, the switches show it.
  const pending = update.isPending ? update.variables?.workspace : undefined;
  const sandbox = pending?.sandbox ?? workspace.sandbox ?? false;
  const network = pending?.network ?? workspace.network ?? true;
  const set = (change: { sandbox?: boolean; network?: boolean }) =>
    saveAgentChange(agent, () =>
      update.mutateAsync({
        id: agent.id,
        workspace: {
          tools: normaliseTools(workspace.tools),
          folder: workspace.folder ?? '',
          ...change,
        },
      }),
    );
  const busy = update.isPending || disabled;

  const row = (
    key: string,
    label: string,
    hint: ReactNode,
    checked: boolean,
    off: boolean,
    onChange: (on: boolean) => void,
  ) => (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <p id={`${id}-${key}-label`} className="text-sm font-medium">
          {label}
        </p>
        <div id={`${id}-${key}-hint`} className="mt-0.5 text-xs text-[var(--text-muted)]">
          {hint}
        </div>
      </div>
      <Switch
        checked={checked}
        disabled={busy || off}
        aria-labelledby={`${id}-${key}-label`}
        aria-describedby={`${id}-${key}-hint`}
        onCheckedChange={onChange}
      />
    </div>
  );

  return (
    <Panel
      title="Sandbox"
      description="A sandbox keeps what a command can change small, even when you aren't watching."
    >
      <div className="flex flex-col gap-4">
        {row(
          'sandbox',
          'Run commands in a sandbox',
          <>
            <p>Its commands can:</p>
            <ul className="m-0 mt-1 list-disc pl-4">
              {SANDBOX_ALLOWS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="mt-1.5">
              With the sandbox on, the Balanced profile stops asking before commands. The built-in
              rules (rm -rf, sudo and the others) still ask.
            </p>
          </>,
          sandbox,
          !available && !sandbox,
          (on) => set({ sandbox: on }),
        )}
        {!available && (
          <p
            role="note"
            className="flex gap-2 rounded-lg border border-[var(--warning)]/45 bg-[var(--warning)]/[0.08] px-3 py-2 text-xs text-[var(--text-primary)]"
          >
            <TriangleAlert
              className="mt-px size-3.5 shrink-0 text-[var(--warning)]"
              aria-hidden="true"
            />
            The sandbox isn’t available on this computer yet (it needs macOS). With it on, commands
            are refused instead of running without it.
          </p>
        )}
        {!sandbox && available && (
          <p
            role="note"
            className="flex gap-2 rounded-lg border border-[var(--warning)]/45 bg-[var(--warning)]/[0.08] px-3 py-2 text-xs text-[var(--text-primary)]"
          >
            <TriangleAlert
              className="mt-px size-3.5 shrink-0 text-[var(--warning)]"
              aria-hidden="true"
            />
            Without the sandbox, a command can reach anything you can.
          </p>
        )}
        {row(
          'network',
          'Let commands use the network',
          sandbox
            ? 'Downloads, git, package installs, curl. Off: commands can’t connect to anything.'
            : 'Applies in the sandbox. Turn the sandbox on to choose.',
          network,
          !sandbox,
          (on) => set({ network: on }),
        )}
        {update.error && <ErrorNotice>{errorMessage(update.error)}</ErrorNotice>}
      </div>
    </Panel>
  );
}
