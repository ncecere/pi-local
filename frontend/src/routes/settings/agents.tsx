import { Link } from '@tanstack/react-router';
import { MessageSquarePlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { type Agent, errorMessage } from '~/api/client';
import { AgentAvatar } from '~/components/agent/agent-avatar';
import { SettingsSection } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import {
  type AgentCatalog,
  useAgentCatalog,
  useAgents,
  useCreateAgent,
  useRemoveAgent,
  useUpdateAgent,
} from '~/hooks/use-agents';
import { agentKindLabel } from '~/lib/agent-groups';
import { usePageTitle } from '~/lib/document-title';
import { cn } from '~/lib/utils';

const FIELD =
  'h-10 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)]/60 px-3 text-sm placeholder:text-[var(--text-muted)]';

/**
 * Making an agent, or changing one: its name, description, instructions and
 * (if allowed) its model; a new one also its template (the runtime kind).
 * Empty instructions mean the kind's default prompt.
 */
function AgentDialog({
  agent,
  catalog,
  onClose,
}: {
  agent: Agent | null;
  catalog: AgentCatalog;
  onClose: () => void;
}) {
  const create = useCreateAgent();
  const update = useUpdateAgent();
  const id = useId();
  const [name, setName] = useState(agent?.name ?? '');
  const [templateId, setTemplateId] = useState(catalog.templates[0]?.id ?? '');
  const [modelId, setModelId] = useState(agent?.model?.id ?? catalog.defaultModelId ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [instructions, setInstructions] = useState(agent?.instructions ?? '');
  const busy = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const submit = () => {
    if (agent)
      update.mutate(
        {
          id: agent.id,
          ...(name.trim() !== agent.name ? { name: name.trim() } : {}),
          ...(description.trim() !== agent.description.trim()
            ? { description: description.trim() }
            : {}),
          // "" is meaningful here: back to the kind's default prompt.
          ...(instructions.trim() !== (agent.instructions ?? '').trim()
            ? { instructions: instructions.trim() }
            : {}),
          ...(catalog.allowModelChoice && modelId && modelId !== agent.model?.id
            ? { modelId }
            : {}),
        },
        {
          onSuccess: () => {
            toast(`${name.trim()} saved.`);
            onClose();
          },
        },
      );
    else
      create.mutate(
        {
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          templateId,
          ...(catalog.allowModelChoice && modelId ? { modelId } : {}),
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        },
        {
          onSuccess: () => {
            toast(`${name.trim()} is ready.`);
            onClose();
          },
        },
      );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{agent ? `Edit ${agent.name}` : 'New agent'}</DialogTitle>
          <DialogDescription>
            {agent
              ? 'Change its name, description or instructions. If it is awake, it restarts.'
              : 'An agent on this computer, with its own folder for its memory and conversations.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <label htmlFor={`${id}-name`} className="flex flex-col gap-1.5 text-sm font-medium">
            Name
            <input
              id={`${id}-name`}
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Research helper"
              className={FIELD}
            />
          </label>
          <label
            htmlFor={`${id}-description`}
            className="flex flex-col gap-1.5 text-sm font-medium"
          >
            <span>
              Description <span className="font-normal text-[var(--text-muted)]">(optional)</span>
            </span>
            <input
              id={`${id}-description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Finds and summarizes papers"
              className={FIELD}
            />
          </label>
          {!agent && (
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-1.5 text-sm font-medium">Start from</legend>
              {catalog.templates.map((template) => (
                <label
                  key={template.id}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm has-[:checked]:border-[var(--accent-button-border)] has-[:checked]:bg-[var(--accent-soft)]"
                >
                  <input
                    type="radio"
                    name={`${id}-template`}
                    checked={templateId === template.id}
                    onChange={() => setTemplateId(template.id)}
                    className="mt-0.5 accent-[var(--accent)]"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{template.name}</span>
                    {template.description && (
                      <span className="block text-xs text-[var(--text-muted)]">
                        {template.description}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <label
            htmlFor={`${id}-instructions`}
            className="flex flex-col gap-1.5 text-sm font-medium"
          >
            <span>
              Instructions <span className="font-normal text-[var(--text-muted)]">(optional)</span>
            </span>
            <textarea
              id={`${id}-instructions`}
              rows={agent ? 8 : 4}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="You help me keep track of research papers…"
              aria-describedby={`${id}-instructions-hint`}
              className={cn(FIELD, 'h-auto min-h-24 resize-y py-2 font-normal')}
            />
            <span
              id={`${id}-instructions-hint`}
              className="text-xs font-normal text-[var(--text-muted)]"
            >
              Leave empty to use the default prompt for its kind.
            </span>
          </label>
          {catalog.allowModelChoice && catalog.models.length > 1 && (
            <label htmlFor={`${id}-model`} className="flex flex-col gap-1.5 text-sm font-medium">
              Model
              <select
                id={`${id}-model`}
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                className={FIELD}
              >
                {!catalog.defaultModelId && <option value="">The default model</option>}
                {catalog.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                    {model.id === catalog.defaultModelId ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-[var(--danger-on-tint)]">
              {errorMessage(error)}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim() || (!agent && !templateId) || busy}
            onClick={submit}
          >
            {busy && <Spinner className="size-4" />}
            {agent ? 'Save' : 'Make agent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const STATUS_LABEL: Record<Agent['status'], string> = {
  asleep: 'asleep',
  starting: 'waking',
  awake: 'awake',
  error: 'error',
};

/** The agent's runtime process, subtly: asleep, waking, awake, or why it failed to start. */
export function AgentStatus({ agent }: { agent: Pick<Agent, 'status' | 'lastError'> }) {
  const label = STATUS_LABEL[agent.status] ?? agent.status;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1',
        agent.status === 'error' && 'text-[var(--danger-on-tint)]',
      )}
      title={agent.status === 'error' && agent.lastError ? agent.lastError : undefined}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          agent.status === 'awake' && 'bg-[var(--success,#22c55e)]',
          agent.status === 'starting' && 'bg-[var(--warning)]',
          agent.status === 'error' && 'bg-[var(--danger)]',
          agent.status === 'asleep' && 'bg-[var(--text-muted)] opacity-60',
        )}
      />
      {label}
    </span>
  );
}

function AgentRow({
  agent,
  onEdit,
  onDelete,
}: {
  agent: Agent;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const about = [agent.description || agentKindLabel(agent), agent.model?.name]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <AgentAvatar agent={agent} size={32} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{agent.name}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <span className="truncate">{about}</span>
          <span aria-hidden="true">·</span>
          <AgentStatus agent={agent} />
        </span>
        {agent.status === 'error' && agent.lastError && (
          <span className="mt-0.5 block truncate text-xs text-[var(--danger-on-tint)]">
            {agent.lastError}
          </span>
        )}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        asChild
        aria-label={`New chat with ${agent.name}`}
        title="New chat"
      >
        <Link to="/" search={{ agent: agent.id }}>
          <MessageSquarePlus />
        </Link>
      </Button>
      {onEdit && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit ${agent.name}`}
          title="Edit"
          onClick={onEdit}
        >
          <Pencil />
        </Button>
      )}
      {onDelete && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${agent.name}`}
          title="Delete"
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      )}
    </li>
  );
}

export function SettingsAgentsPage() {
  usePageTitle('Agents · Settings');
  const agents = useAgents();
  const catalog = useAgentCatalog();
  const remove = useRemoveAgent();
  const [editing, setEditing] = useState<Agent | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Agent | null>(null);

  if (!agents.data || !catalog.data)
    return (
      <div className="py-12">
        <Spinner className="mx-auto" />
      </div>
    );
  const mine = agents.data;
  const { limit } = catalog.data;
  const full = mine.length >= limit;

  return (
    <>
      <SettingsSection title="Your agents" first>
        <p className="-mt-2 text-sm text-[var(--text-muted)]">
          {limit === 0
            ? 'Making agents is turned off for now.'
            : 'Agents that run on this computer, each with its own memory and conversations.'}
        </p>
        {mine.length > 0 && (
          <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
            {mine.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                onEdit={() => setEditing(agent)}
                onDelete={() => setDeleting(agent)}
              />
            ))}
          </ul>
        )}
        {limit > 0 && (
          <div>
            <Button
              variant="primary"
              disabled={full || catalog.data.templates.length === 0}
              title={
                full
                  ? `You have ${limit}, the most allowed. Delete one to make another.`
                  : undefined
              }
              onClick={() => setEditing('new')}
            >
              <Plus />
              New agent
            </Button>
          </div>
        )}
      </SettingsSection>

      {editing && (
        <AgentDialog
          agent={editing === 'new' ? null : editing}
          catalog={catalog.data}
          onClose={() => setEditing(null)}
        />
      )}

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleting?.name}?</DialogTitle>
            <DialogDescription>
              The agent stops, and its folder (its memory and all its conversations) moves to the
              Trash.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={remove.isPending}
              onClick={() =>
                deleting &&
                remove.mutate(deleting.id, {
                  onSuccess: () => {
                    toast(`${deleting.name} deleted.`);
                    setDeleting(null);
                  },
                  onError: (error) => toast.error(errorMessage(error, 'Not deleted.')),
                })
              }
            >
              {remove.isPending ? <Spinner className="size-4" /> : <Trash2 />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
