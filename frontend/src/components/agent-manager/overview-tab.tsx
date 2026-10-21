import { Link } from '@tanstack/react-router';
import { FolderOpen, Moon, Sun } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { type Agent, errorMessage } from '~/api/client';
import { AgentStatus } from '~/components/agent-manager/agent-status';
import { ModelSelect } from '~/components/agent-manager/model-select';
import { Fact, Panel, saveAgentChange } from '~/components/agent-manager/panel';
import { ErrorNotice, FIELD, Field, Optional } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useAgentPower, useReveal } from '~/hooks/use-agent-manager';
import { type AgentCatalog, useUpdateAgent } from '~/hooks/use-agents';
import { agentKindLabel } from '~/lib/agent-groups';
import { agentFieldText } from '~/lib/agent-text';
import { formatDayTime } from '~/lib/dates';
import { cn, formatRelativeTime } from '~/lib/utils';

/**
 * An agent's name, description, model and instructions (saved together), and
 * what it is: its kind, its runtime's status with Wake and Sleep, when it was
 * last used, and its folder.
 */
export function OverviewTab({ agent, catalog }: { agent: Agent; catalog: AgentCatalog }) {
  return (
    <div className="flex flex-col gap-6">
      {/* A saved change bumps the revision: the form starts again from what was saved. */}
      <AgentForm key={agent.revision} agent={agent} catalog={catalog} />
      <RuntimePanel agent={agent} />
    </div>
  );
}

function AgentForm({ agent, catalog }: { agent: Agent; catalog: AgentCatalog }) {
  const id = useId();
  const update = useUpdateAgent();
  const initial = {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions ?? '',
    modelId: agent.model?.id ?? '',
  };
  const [form, setForm] = useState(initial);
  const set = (change: Partial<typeof form>) => setForm((before) => ({ ...before, ...change }));
  const text = agentFieldText(agent.agentKind);

  const changes = {
    ...(form.name.trim() !== agent.name ? { name: form.name.trim() } : {}),
    ...(form.description.trim() !== agent.description.trim()
      ? { description: form.description.trim() }
      : {}),
    // "" is meaningful: back to the kind's default prompt.
    ...(form.instructions.trim() !== initial.instructions.trim()
      ? { instructions: form.instructions.trim() }
      : {}),
    ...(form.modelId && form.modelId !== agent.model?.id ? { modelId: form.modelId } : {}),
  };
  const dirty = Object.keys(changes).length > 0;
  const missingModel =
    agent.model && !catalog.models.some((model) => model.id === agent.model?.id)
      ? agent.model
      : null;

  return (
    <Panel
      title="Details"
      description={
        agent.running
          ? 'Saving a change restarts the agent (it is awake).'
          : 'Changes apply the next time the agent wakes.'
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!dirty || !form.name.trim()) return;
          saveAgentChange(agent, () => update.mutateAsync({ id: agent.id, ...changes }));
        }}
      >
        <Field id={`${id}-name`} label="Name">
          <input
            id={`${id}-name`}
            maxLength={60}
            value={form.name}
            onChange={(event) => set({ name: event.target.value })}
            className={cn(FIELD, 'max-w-md')}
          />
        </Field>
        <Field
          id={`${id}-description`}
          label={
            <>
              Description <Optional />
            </>
          }
        >
          <input
            id={`${id}-description`}
            maxLength={500}
            value={form.description}
            onChange={(event) => set({ description: event.target.value })}
            placeholder={text.description}
            className={FIELD}
          />
        </Field>
        <Field
          id={`${id}-model`}
          label="Model"
          hint={
            missingModel && form.modelId === missingModel.id ? (
              <span className="text-[var(--danger-on-tint)]">
                {missingModel.name} was removed or turned off, so this agent can't start. Pick
                another model.
              </span>
            ) : (
              <>
                Add providers and models in{' '}
                <Link
                  to="/settings/models"
                  className="text-[var(--accent-bright)] underline-offset-4 hover:underline"
                >
                  Settings → Models
                </Link>
                .
              </>
            )
          }
        >
          <ModelSelect
            id={`${id}-model`}
            catalog={catalog}
            current={agent.model}
            value={form.modelId}
            onChange={(modelId) => set({ modelId })}
            describedBy={`${id}-model-hint`}
          />
        </Field>
        <Field
          id={`${id}-instructions`}
          label={
            <>
              Instructions <Optional />
            </>
          }
          hint={text.instructionsHint}
        >
          <textarea
            id={`${id}-instructions`}
            rows={10}
            maxLength={20_000}
            value={form.instructions}
            onChange={(event) => set({ instructions: event.target.value })}
            placeholder={text.instructions}
            aria-describedby={`${id}-instructions-hint`}
            className={cn(FIELD, 'h-auto min-h-40 resize-y py-2 leading-relaxed')}
          />
        </Field>
        {update.error && <ErrorNotice>{errorMessage(update.error)}</ErrorNotice>}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={!dirty || !form.name.trim()}>
            {update.isPending && <Spinner className="size-4 text-current" />}
            Save
          </Button>
          {dirty && (
            <Button
              type="button"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => {
                setForm(initial);
                update.reset();
              }}
            >
              Undo changes
            </Button>
          )}
        </div>
      </form>
    </Panel>
  );
}

/** Its runtime process, when it was used, and where it lives. */
function RuntimePanel({ agent }: { agent: Agent }) {
  const power = useAgentPower();
  const reveal = useReveal();
  const awakeOrWaking = agent.status === 'awake' || agent.status === 'starting';
  const revealFolder = (target: 'agent' | 'workspace') =>
    reveal.mutate(
      { target, agentId: agent.id },
      { onError: (error) => toast.error(errorMessage(error, 'Could not open the folder.')) },
    );

  return (
    <Panel title="Runtime">
      <dl className="-my-2.5 divide-y divide-[var(--border-subtle)]">
        <Fact label="Kind">{agentKindLabel(agent)}</Fact>
        <Fact label="Status">
          <div className="flex flex-wrap items-center gap-3">
            <AgentStatus agent={agent} className="text-sm" />
            {awakeOrWaking ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={power.isPending}
                onClick={() =>
                  power.mutate(
                    { id: agent.id, action: 'sleep' },
                    {
                      onSuccess: () => toast(`${agent.name} is asleep.`),
                      onError: (error) => toast.error(errorMessage(error, 'Could not sleep.')),
                    },
                  )
                }
              >
                {power.isPending ? <Spinner className="size-3.5 text-current" /> : <Moon />}
                Sleep
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={power.isPending}
                onClick={() =>
                  power.mutate(
                    { id: agent.id, action: 'wake' },
                    {
                      onSuccess: (woken) =>
                        woken.status === 'error'
                          ? toast.error(`${agent.name} couldn't start.`)
                          : toast(`${agent.name} is awake.`),
                      onError: (error) => toast.error(errorMessage(error, 'Could not wake it.')),
                    },
                  )
                }
              >
                {power.isPending ? <Spinner className="size-3.5 text-current" /> : <Sun />}
                Wake
              </Button>
            )}
          </div>
          {agent.status === 'error' && agent.lastError && (
            <p className="mt-2 rounded-lg bg-[var(--danger)]/10 px-3 py-2 text-sm text-[var(--danger-on-tint)]">
              {agent.lastError}
            </p>
          )}
          <p className="mt-1.5 text-xs text-[var(--text-muted)]">
            An agent sleeps when idle and wakes on its next message. Sleeping keeps work in flight;
            it resumes on the next start.
          </p>
        </Fact>
        <Fact label="Last used">
          {agent.lastUsedAt ? (
            <time dateTime={agent.lastUsedAt} title={formatDayTime(agent.lastUsedAt)}>
              {formatRelativeTime(agent.lastUsedAt)}
            </time>
          ) : (
            <span className="text-[var(--text-muted)]">Never</span>
          )}
        </Fact>
        <Fact label="Created">
          <time dateTime={agent.createdAt}>{formatDayTime(agent.createdAt)}</time>
        </Fact>
        <Fact label="Folder">
          {agent.dir ? (
            <code className="block break-all font-mono text-xs text-[var(--text-secondary)]">
              {agent.dir}
            </code>
          ) : (
            <span className="text-[var(--text-muted)]">—</span>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={reveal.isPending}
              onClick={() => revealFolder('agent')}
            >
              <FolderOpen />
              Show in Finder
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={reveal.isPending}
              onClick={() => revealFolder('workspace')}
            >
              Open workspace
            </Button>
          </div>
        </Fact>
        {agent.workspace?.folder && agent.workspace.dir && (
          <Fact label="Project folder">
            <code className="block break-all font-mono text-xs text-[var(--text-secondary)]">
              {agent.workspace.dir}
            </code>
            <p className="mt-1.5 text-xs text-[var(--text-muted)]">
              Its tools work here. Open workspace shows this folder.
            </p>
          </Fact>
        )}
        {agent.piDurableVersion && (
          <Fact label="Storage">
            <span className="text-[var(--text-secondary)]">
              Written by pi-durable {agent.piDurableVersion}
            </span>
          </Fact>
        )}
      </dl>
    </Panel>
  );
}
