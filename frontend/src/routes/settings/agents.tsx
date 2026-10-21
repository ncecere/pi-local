import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronRight, MessageSquarePlus, Plus, Upload } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { type Agent, ApiError, type CatalogModel, errorMessage } from '~/api/client';
import { AgentAvatar } from '~/components/agent/agent-avatar';
import { AgentStatus } from '~/components/agent-manager/agent-status';
import {
  PROJECT_FOLDER_HINT,
  ProjectFolderInput,
} from '~/components/agent-manager/project-folder-field';
import { ErrorNotice } from '~/components/models/fields';
import { SettingsSection } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SCROLLING_DIALOG,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { useImportAgent } from '~/hooks/use-agent-manager';
import {
  type AgentCatalog,
  useAgentCatalog,
  useAgents,
  useCreateAgent,
  useUpdateAgent,
} from '~/hooks/use-agents';
import { agentKindLabel } from '~/lib/agent-groups';
import { agentFieldText } from '~/lib/agent-text';
import { usePageTitle } from '~/lib/document-title';
import { groupModelsByProvider } from '~/lib/models';
import { cn } from '~/lib/utils';

const FIELD =
  'h-10 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)]/60 px-3 text-sm placeholder:text-[var(--text-muted)]';

/** A coding agent's tools: pi's own. Sent with a project folder (a `workspace` without tools has none). */
const CODING_TOOLS = ['read', 'write', 'edit', 'bash'] as const;

/**
 * Making an agent, or changing one: its name, description, instructions and
 * (if allowed) its model; a new one also its template (the runtime kind).
 * Empty instructions mean the kind's default prompt.
 */
export function AgentDialog({
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
  const [folder, setFolder] = useState('');
  const busy = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const kind = agent ? agent.agentKind : templateId;
  const coding = kind === 'coding';
  const text = agentFieldText(kind);
  const folderError =
    error instanceof ApiError && error.code === 'invalid_workspace_folder' ? error.message : null;
  // An agent whose model was removed or turned off keeps it until given another.
  const missingModel =
    agent?.model && !catalog.models.some((model) => model.id === agent.model?.id)
      ? agent.model
      : null;
  const groups = groupModelsByProvider(catalog.models);

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
          ...(coding && folder.trim()
            ? { workspace: { tools: [...CODING_TOOLS], folder: folder.trim() } }
            : {}),
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
      <DialogContent className={SCROLLING_DIALOG}>
        <DialogHeader>
          <DialogTitle>{agent ? `Edit ${agent.name}` : 'New agent'}</DialogTitle>
          <DialogDescription>
            {agent
              ? 'Change its name, description or instructions. If it is awake, it restarts.'
              : 'An agent on this computer, with its own folder for its memory and conversations.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
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
              placeholder={text.description}
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
          {!agent && coding && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-folder`} className="text-sm font-medium">
                Project folder{' '}
                <span className="font-normal text-[var(--text-muted)]">(optional)</span>
              </label>
              <ProjectFolderInput
                id={`${id}-folder`}
                value={folder}
                onChange={(path) => {
                  setFolder(path);
                  if (folderError) create.reset();
                }}
                invalid={Boolean(folderError)}
                describedBy={`${id}-folder-hint`}
              />
              <span
                id={`${id}-folder-hint`}
                className={cn(
                  'text-xs',
                  folderError ? 'text-[var(--danger-on-tint)]' : 'text-[var(--text-muted)]',
                )}
              >
                {folderError ?? PROJECT_FOLDER_HINT}
              </span>
            </div>
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
              placeholder={text.instructions}
              aria-describedby={`${id}-instructions-hint`}
              className={cn(FIELD, 'h-auto min-h-24 resize-y py-2 font-normal')}
            />
            <span
              id={`${id}-instructions-hint`}
              className="text-xs font-normal text-[var(--text-muted)]"
            >
              {text.instructionsHint}
            </span>
          </label>
          {catalog.allowModelChoice && (catalog.models.length > 1 || missingModel) && (
            <label htmlFor={`${id}-model`} className="flex flex-col gap-1.5 text-sm font-medium">
              Model
              <select
                id={`${id}-model`}
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                aria-describedby={`${id}-model-hint`}
                className={FIELD}
              >
                {!catalog.defaultModelId && <option value="">The default model</option>}
                {missingModel && (
                  <option value={missingModel.id} disabled>
                    {missingModel.name} (no longer available)
                  </option>
                )}
                {groups.map((group) =>
                  groups.length > 1 ? (
                    <optgroup key={group.key} label={group.label}>
                      {group.models.map((model) => (
                        <ModelOption key={model.id} model={model} catalog={catalog} />
                      ))}
                    </optgroup>
                  ) : (
                    group.models.map((model) => (
                      <ModelOption key={model.id} model={model} catalog={catalog} />
                    ))
                  ),
                )}
              </select>
              <span
                id={`${id}-model-hint`}
                className={cn(
                  'text-xs font-normal',
                  missingModel && modelId === missingModel.id
                    ? 'text-[var(--danger-on-tint)]'
                    : 'text-[var(--text-muted)]',
                )}
              >
                {missingModel && modelId === missingModel.id ? (
                  `${missingModel.name} was removed or turned off, so this agent can't start. Pick another model.`
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
                )}
              </span>
            </label>
          )}
          {error && !folderError && (
            <p role="alert" className="text-sm text-[var(--danger-on-tint)]">
              {errorMessage(error)}
            </p>
          )}
        </DialogBody>
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

function ModelOption({ model, catalog }: { model: CatalogModel; catalog: AgentCatalog }) {
  return (
    <option value={model.id}>
      {model.name}
      {model.id === catalog.defaultModelId ? ' (default)' : ''}
    </option>
  );
}

function AgentRow({ agent }: { agent: Agent }) {
  const about = [agent.description || agentKindLabel(agent), agent.model?.name]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--bg-control)]/50">
      <AgentAvatar agent={agent} size={32} />
      <span className="min-w-0 flex-1">
        <Link
          to="/settings/agents/$agentId"
          params={{ agentId: agent.id }}
          className="block truncate text-sm font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
        >
          {agent.name}
        </Link>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <span className="truncate">{about}</span>
          <span aria-hidden="true">·</span>
          <AgentStatus agent={agent} />
        </span>
        {agent.status === 'error' && agent.lastError && (
          <span
            className="mt-0.5 line-clamp-2 text-xs text-[var(--danger-on-tint)]"
            title={agent.lastError}
          >
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
        className="relative z-10"
      >
        <Link to="/" search={{ agent: agent.id }}>
          <MessageSquarePlus />
        </Link>
      </Button>
      <ChevronRight className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
    </li>
  );
}

/**
 * Import agent: a zip an export made. Read into an ArrayBuffer and sent as the
 * raw body (Wails drops Blob bodies); the new agent opens.
 */
function ImportAgentButton({ onError }: { onError: (error: unknown) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const importAgent = useImportAgent();
  const navigate = useNavigate();
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // The same file can be picked again after a failure.
          event.target.value = '';
          if (!file) return;
          onError(null);
          importAgent.mutate(file, {
            onSuccess: (agent) => {
              toast(`${agent.name} imported.`);
              void navigate({ to: '/settings/agents/$agentId', params: { agentId: agent.id } });
            },
            onError,
          });
        }}
      />
      <Button
        variant="secondary"
        disabled={importAgent.isPending}
        onClick={() => input.current?.click()}
      >
        {importAgent.isPending ? <Spinner className="size-4 text-current" /> : <Upload />}
        Import agent
      </Button>
    </>
  );
}

export function SettingsAgentsPage() {
  usePageTitle('Agents · Settings');
  const agents = useAgents();
  const catalog = useAgentCatalog();
  const navigate = useNavigate();
  // `?new=true` opens on the New agent dialog.
  const asked = (useSearch({ strict: false }) as { new?: boolean }).new === true;
  const [creating, setCreating] = useState(asked);
  const stopCreating = () => {
    setCreating(false);
    // Closed: a reload doesn't open it again.
    if (asked) void navigate({ to: '/settings/agents', search: {}, replace: true });
  };
  const [importError, setImportError] = useState<unknown>(null);

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
            : 'Agents that run on this computer, each with its own memory and conversations. Open one to change it, see its logs, or export it.'}
        </p>
        {mine.length > 0 && (
          <ul className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-xl border border-[var(--border-subtle)]">
            {mine.map((agent) => (
              <AgentRow key={agent.id} agent={agent} />
            ))}
          </ul>
        )}
        {importError ? (
          <ErrorNotice>
            {importError instanceof ApiError && importError.code === 'invalid_archive'
              ? `That file can't be imported: ${importError.message}`
              : errorMessage(importError, 'Not imported.')}
          </ErrorNotice>
        ) : null}
        {limit > 0 && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={full || catalog.data.templates.length === 0}
              title={
                full
                  ? `You have ${limit}, the most allowed. Delete one to make another.`
                  : undefined
              }
              onClick={() => setCreating(true)}
            >
              <Plus />
              New agent
            </Button>
            <ImportAgentButton onError={setImportError} />
          </div>
        )}
      </SettingsSection>

      {creating && limit > 0 && !full && catalog.data.templates.length > 0 && (
        <AgentDialog agent={null} catalog={catalog.data} onClose={stopCreating} />
      )}
    </>
  );
}
