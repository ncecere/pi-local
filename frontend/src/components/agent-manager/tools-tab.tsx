import { Link } from '@tanstack/react-router';
import { ChevronRight, FolderOpen, Lock, Trash2, TriangleAlert } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { toast } from 'sonner';
import {
  type Agent,
  ApiError,
  type ApprovalProfile,
  type ApprovalRule,
  errorMessage,
  type WebTools,
  type WorkspaceTool,
} from '~/api/client';
import { Panel, SaveBar, saveAgentChange } from '~/components/agent-manager/panel';
import { ProjectFolderInput } from '~/components/agent-manager/project-folder-field';
import { SandboxPanel } from '~/components/agent-manager/sandbox-panel';
import { ErrorNotice, FIELD } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { Switch } from '~/components/ui/switch';
import { useReveal } from '~/hooks/use-agent-manager';
import { useUpdateAgent } from '~/hooks/use-agents';
import { useRemoveApprovalRule } from '~/hooks/use-approvals';
import { useMcpServers } from '~/hooks/use-mcp';
import { useWebSearchReady } from '~/hooks/use-web';
import {
  APPROVAL_PRESETS,
  actionLabel,
  applyPreset,
  approvalPatternsError,
  DEFAULT_PRESET,
  describeRule,
  formatTimeout,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  minutesToTimeout,
  normaliseTools,
  PROFILE_OPTIONS,
  type PresetId,
  presetOf,
  readToolSettings,
  TIMEOUT_CHOICES,
  type TimeoutChoice,
  timeoutChoiceOf,
  unguardedTools,
  WORKSPACE_TOOLS,
} from '~/lib/approvals';
import { formatToolList, parseToolList } from '~/lib/kind-settings';
import { approvalSuggestions, readAgentMcp } from '~/lib/mcp';
import { cn } from '~/lib/utils';

const TOOL_TEXT: Record<WorkspaceTool, { label: string; hint: (sandboxed: boolean) => ReactNode }> =
  {
    read: {
      label: 'Read files',
      hint: () => 'Open files in its workspace, including files you attach to a message.',
    },
    write: {
      label: 'Write files',
      hint: () => 'Create files in its workspace, or replace their content.',
    },
    edit: { label: 'Edit files', hint: () => 'Change parts of files in its workspace.' },
    bash: {
      label: 'Run commands',
      hint: (sandboxed) =>
        sandboxed ? (
          'Run shell commands in its workspace, in the sandbox below.'
        ) : (
          <>
            Run shell commands in its workspace.{' '}
            <strong className="font-medium text-[var(--text-secondary)]">
              Not confined: a command can reach anything you can.
            </strong>
          </>
        ),
    },
  };

/**
 * Whether turning a tool on should choose the recommended "Ask first" for the
 * agent: nothing of it asks first (saved or in the form), and the person has
 * not chosen an option here. An agent whose approvals were set keeps them.
 */
export function preselectsAskFirst({
  on,
  preset,
  presetChosen,
  savedApprovals,
}: {
  on: boolean;
  preset: PresetId | 'custom';
  presetChosen: boolean;
  savedApprovals: readonly string[];
}): boolean {
  return on && preset === 'none' && !presetChosen && savedApprovals.length === 0;
}

/** Server errors that belong to one field. */
const FIELD_ERRORS = {
  folder: 'invalid_workspace_folder',
  tools: 'invalid_workspace_tools',
  patterns: 'invalid_approval_tools',
  timeout: 'invalid_approval_timeout',
} as const;

/**
 * Settings → Agents → an agent → Tools: its workspace tools (read, write,
 * edit, bash) and which of its tools ask you first, with how long a request
 * waits (docs/api.md, Phase 4).
 */
export function ToolsTab({ agent }: { agent: Agent }) {
  // Whether Advanced is open, kept here: a save draws the form again (a new revision).
  const [advancedOpen, setAdvancedOpen] = useState<boolean | null>(null);
  return (
    <ToolsForm
      key={agent.revision}
      agent={agent}
      advancedOpen={advancedOpen}
      onAdvancedOpen={setAdvancedOpen}
    />
  );
}

function ToolsForm({
  agent,
  advancedOpen,
  onAdvancedOpen,
}: {
  agent: Agent;
  /** Opened or closed by the person; null: open when the list is custom. */
  advancedOpen: boolean | null;
  onAdvancedOpen: (open: boolean) => void;
}) {
  const id = useId();
  const saved = readToolSettings(agent);
  const initialChoice = timeoutChoiceOf(saved.approvals.timeoutSeconds);
  const savedFolder = agent.workspace?.folder ?? '';
  const initial = {
    folder: savedFolder,
    tools: saved.tools,
    profile: saved.approvals.profile,
    patterns: formatToolList(saved.approvals.tools),
    timeoutChoice: initialChoice,
    minutes: String(Math.round(saved.approvals.timeoutSeconds / 60)),
  };
  const [form, setForm] = useState(initial);
  const advanced = advancedOpen ?? presetOf(saved.approvals.tools) === 'custom';
  const custom = form.profile === 'custom';
  // The person chose an approvals option here: turning tools on leaves it alone.
  const [presetChosen, setPresetChosen] = useState(false);
  const update = useUpdateAgent();
  const reveal = useReveal();

  const patterns = parseToolList(form.patterns);
  const preset = presetOf(patterns);
  const patternsError = approvalPatternsError(patterns);
  const timeoutSeconds =
    form.timeoutChoice === 'custom'
      ? minutesToTimeout(form.minutes)
      : (TIMEOUT_CHOICES.find((choice) => choice.id === form.timeoutChoice)?.seconds ?? null);
  const valid = (!custom || patternsError === null) && timeoutSeconds !== null;

  const next = {
    // The whole workspace: a `workspace` without `tools` would leave it none.
    workspace: { tools: normaliseTools(form.tools), folder: form.folder.trim() },
    // No `rules`: they are added and removed on their own, and a save leaves them as they are.
    approvals: {
      // Only a profile the person chose: an agent without one stays as it is.
      ...(form.profile !== saved.approvals.profile ? { profile: form.profile } : {}),
      tools: patterns,
      timeoutSeconds: timeoutSeconds ?? 0,
    },
  };
  const dirty =
    next.workspace.folder !== savedFolder ||
    JSON.stringify(next.workspace.tools) !== JSON.stringify(saved.tools) ||
    form.profile !== saved.approvals.profile ||
    JSON.stringify(patterns) !== JSON.stringify(saved.approvals.tools) ||
    (timeoutSeconds !== null && timeoutSeconds !== saved.approvals.timeoutSeconds);

  const serverError = update.error instanceof ApiError ? update.error : null;
  const fieldError = (field: keyof typeof FIELD_ERRORS) =>
    serverError?.code === FIELD_ERRORS[field] ? serverError.message : null;
  const otherError =
    update.error && !Object.values(FIELD_ERRORS).some((code) => serverError?.code === code)
      ? errorMessage(update.error)
      : null;

  const toggleTool = (tool: WorkspaceTool, on: boolean) => {
    const tools = normaliseTools(on ? [...form.tools, tool] : form.tools.filter((t) => t !== tool));
    setForm({
      ...form,
      tools,
      patterns:
        custom &&
        preselectsAskFirst({
          on,
          preset,
          presetChosen,
          savedApprovals: saved.approvals.tools,
        })
          ? formatToolList(applyPreset(patterns, DEFAULT_PRESET))
          : form.patterns,
    });
  };
  const choosePreset = (choice: PresetId) => {
    setPresetChosen(true);
    setForm({ ...form, patterns: formatToolList(applyPreset(patterns, choice)) });
  };

  // Tools that change things or run commands without asking.
  const unguarded = unguardedTools(form.profile, normaliseTools(form.tools), patterns);
  const noTools = form.tools.length === 0;

  const save = () => saveAgentChange(agent, () => update.mutateAsync({ id: agent.id, ...next }));

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Project folder"
        description={
          agent.agentKind === 'coding'
            ? "The folder its tools work in. It also follows the folder's AGENTS.md or CLAUDE.md. Leave empty to give it a folder of its own."
            : 'The folder its tools work in. Leave empty to give it a folder of its own.'
        }
        actions={
          <Button
            size="sm"
            variant="secondary"
            disabled={reveal.isPending}
            onClick={() =>
              reveal.mutate(
                { target: 'workspace', agentId: agent.id },
                {
                  onError: (error) =>
                    toast.error(errorMessage(error, "The workspace couldn't be opened.")),
                },
              )
            }
          >
            <FolderOpen />
            Open workspace
          </Button>
        }
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-folder`} className="sr-only">
            Project folder
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <ProjectFolderInput
                id={`${id}-folder`}
                value={form.folder}
                onChange={(folder) => setForm({ ...form, folder })}
                placeholder="Its own folder"
                invalid={Boolean(fieldError('folder'))}
                describedBy={`${id}-folder-hint`}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              className="h-10 shrink-0 self-start sm:self-auto"
              disabled={!form.folder.trim()}
              onClick={() => setForm({ ...form, folder: '' })}
            >
              Use its own folder
            </Button>
          </div>
          <p id={`${id}-folder-hint`} className="text-xs text-[var(--text-muted)]">
            Works in{' '}
            <code className="break-all font-mono text-[var(--text-secondary)]">
              {agent.workspace?.dir || '—'}
            </code>
            {next.workspace.folder !== savedFolder && ' until you save.'}
          </p>
          {fieldError('folder') && <ErrorNotice>{fieldError('folder')}</ErrorNotice>}
        </div>
      </Panel>

      <Panel
        title="Workspace tools"
        description={
          <>Read, write and edit can't reach outside its folder. With none, it has no file tools.</>
        }
      >
        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="sr-only">Workspace tools</legend>
          {WORKSPACE_TOOLS.map((tool) => {
            const inputId = `${id}-tool-${tool}`;
            return (
              <div key={tool} className="flex items-start gap-3">
                <input
                  id={inputId}
                  type="checkbox"
                  checked={form.tools.includes(tool)}
                  onChange={(event) => toggleTool(tool, event.target.checked)}
                  aria-describedby={`${inputId}-hint`}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                />
                <div className="min-w-0">
                  <label htmlFor={inputId} className="text-sm font-medium">
                    {TOOL_TEXT[tool].label}{' '}
                    <span className="font-mono text-xs font-normal text-[var(--text-muted)]">
                      {tool}
                    </span>
                  </label>
                  <p id={`${inputId}-hint`} className="mt-0.5 text-xs text-[var(--text-muted)]">
                    {TOOL_TEXT[tool].hint(agent.workspace?.sandbox === true)}
                  </p>
                </div>
              </div>
            );
          })}
        </fieldset>
        {fieldError('tools') && (
          <div className="mt-3">
            <ErrorNotice>{fieldError('tools')}</ErrorNotice>
          </div>
        )}
      </Panel>

      <SandboxPanel agent={agent} disabled={dirty} />

      <Panel
        title="Agent builder"
        description="Lets this agent propose new agents and update only agents it created. Every creation or update asks for your approval of the complete configuration, even under Trusting or an allow rule. It cannot change itself or unrelated agents."
      >
        <div className="flex items-center justify-between gap-3">
          <span id={`${id}-builder-label`} className="text-sm font-medium">
            Build agents
          </span>
          <Switch
            aria-labelledby={`${id}-builder-label`}
            checked={agent.builder === true}
            disabled={update.isPending}
            onCheckedChange={(builder) =>
              void saveAgentChange(agent, () => update.mutateAsync({ id: agent.id, builder }))
            }
          />
        </div>
      </Panel>

      <WebPanel agent={agent} />

      <SecretsPanel agent={agent} />

      <Panel
        title="Approvals"
        description="Tools that ask you first. The call waits, even while the agent sleeps, until you approve or deny it in the conversation."
      >
        <div className="flex flex-col gap-5">
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 text-sm font-medium">How careful it is</legend>
            {noTools && (
              <p className="mb-1 text-xs text-[var(--text-muted)]" data-approvals-none="">
                No file or command tools. Turn one on above to choose when it asks.
              </p>
            )}
            {PROFILE_OPTIONS.map((option) => {
              const inputId = `${id}-profile-${option.id}`;
              return (
                <label
                  key={option.id}
                  htmlFor={inputId}
                  className={cn(
                    'flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                    noTools
                      ? 'cursor-not-allowed border-[var(--border-subtle)] opacity-60'
                      : cn(
                          'cursor-pointer',
                          form.profile === option.id
                            ? 'border-[var(--border-strong)] bg-[var(--bg-control)]'
                            : 'border-[var(--border-subtle)] hover:bg-[var(--bg-control)]/60',
                        ),
                  )}
                >
                  <input
                    id={inputId}
                    type="radio"
                    name={`${id}-profile`}
                    // With no workspace tool there is nothing to ask about: no option is chosen yet.
                    checked={!noTools && form.profile === option.id}
                    disabled={noTools}
                    onChange={() => setForm({ ...form, profile: option.id as ApprovalProfile })}
                    aria-describedby={`${inputId}-hint`}
                    className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                  />
                  <span className="min-w-0">
                    <span className="text-sm font-medium">
                      {option.label}
                      {option.id === 'balanced' && (
                        <span className="font-normal text-[var(--text-muted)]"> (recommended)</span>
                      )}
                    </span>
                    <span
                      id={`${inputId}-hint`}
                      className="mt-0.5 block text-xs text-[var(--text-muted)]"
                    >
                      {option.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {custom && (
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-2 text-sm font-medium">
                Before it uses its workspace tools
              </legend>
              {APPROVAL_PRESETS.map((option) => {
                const inputId = `${id}-preset-${option.id}`;
                return (
                  <label
                    key={option.id}
                    htmlFor={inputId}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                      preset === option.id
                        ? 'border-[var(--border-strong)] bg-[var(--bg-control)]'
                        : 'border-[var(--border-subtle)] hover:bg-[var(--bg-control)]/60',
                    )}
                  >
                    <input
                      id={inputId}
                      type="radio"
                      name={`${id}-preset`}
                      checked={preset === option.id}
                      onChange={() => choosePreset(option.id)}
                      aria-describedby={`${inputId}-hint`}
                      className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                    />
                    <span className="min-w-0">
                      <span className="text-sm font-medium">
                        {option.label}
                        {option.id === DEFAULT_PRESET && (
                          <span className="font-normal text-[var(--text-muted)]">
                            {' '}
                            (recommended)
                          </span>
                        )}
                      </span>
                      <span
                        id={`${inputId}-hint`}
                        className="mt-0.5 block text-xs text-[var(--text-muted)]"
                      >
                        {option.description}
                      </span>
                    </span>
                  </label>
                );
              })}
              {preset === 'custom' && (
                <p className="rounded-lg border border-[var(--border-subtle)] px-3 py-2.5 text-xs text-[var(--text-muted)]">
                  <span className="font-medium text-[var(--text-secondary)]">Custom:</span> the list
                  below decides which workspace tools ask. Choose an option above to replace it.
                </p>
              )}
            </fieldset>
          )}

          {unguarded.length > 0 && (
            <div
              role="note"
              className="flex gap-2.5 rounded-lg border border-[var(--warning)]/45 bg-[var(--warning)]/[0.08] px-3 py-2.5 text-sm text-[var(--text-primary)]"
            >
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-[var(--warning)]"
                aria-hidden="true"
              />
              <p>
                {unguarded.includes('bash')
                  ? agent.workspace?.sandbox === true
                    ? 'It can run commands without asking you. They run in the sandbox, so they can only write in its workspace, its temp folder and /tmp.'
                    : 'It can run commands without asking you, and a command can reach anything you can: your files, your accounts, the network.'
                  : 'It can change files in its workspace without asking you.'}{' '}
                <span className="text-[var(--text-secondary)]">
                  Without asking: {unguarded.join(', ')}.
                </span>
              </p>
            </div>
          )}

          {custom && (
            <div>
              <button
                type="button"
                aria-expanded={advanced}
                aria-controls={`${id}-advanced`}
                onClick={() => onAdvancedOpen(!advanced)}
                className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <ChevronRight
                  className={cn('size-4 transition-transform', advanced && 'rotate-90')}
                  aria-hidden="true"
                />
                Advanced: every tool that asks first
              </button>
              {advanced && (
                <div id={`${id}-advanced`} className="mt-3 flex flex-col gap-1.5">
                  <label htmlFor={`${id}-patterns`} className="text-sm font-medium">
                    Tools that ask first
                  </label>
                  <textarea
                    id={`${id}-patterns`}
                    rows={5}
                    value={form.patterns}
                    onChange={(event) => setForm({ ...form, patterns: event.target.value })}
                    placeholder={'e.g. bash\nwrite\nedit\nmcp__github__create_*'}
                    spellCheck={false}
                    aria-invalid={Boolean(patternsError || fieldError('patterns')) || undefined}
                    aria-describedby={`${id}-patterns-hint`}
                    className={cn(
                      FIELD,
                      'h-auto min-h-28 resize-y py-2 font-mono text-xs placeholder:text-[var(--text-muted)] placeholder:opacity-70',
                    )}
                  />
                  <p id={`${id}-patterns-hint`} className="text-xs text-[var(--text-muted)]">
                    {patternsError ?? (
                      <>
                        One tool name per line; <span className="font-mono">*</span> matches any
                        characters (<span className="font-mono">mcp__github__create_*</span>). Up to
                        100.
                      </>
                    )}
                  </p>
                  {fieldError('patterns') && <ErrorNotice>{fieldError('patterns')}</ErrorNotice>}
                  <McpToolAdder
                    agent={agent}
                    present={patterns}
                    onAdd={(name) =>
                      setForm({ ...form, patterns: formatToolList([...patterns, name]) })
                    }
                  />
                </div>
              )}
            </div>
          )}

          <TimeoutField
            id={`${id}-timeout`}
            choice={form.timeoutChoice}
            minutes={form.minutes}
            seconds={timeoutSeconds}
            onChoice={(timeoutChoice) => setForm({ ...form, timeoutChoice })}
            onMinutes={(minutes) => setForm({ ...form, minutes })}
            serverError={fieldError('timeout')}
          />

          {otherError && <ErrorNotice>{otherError}</ErrorNotice>}
          <SaveBar
            dirty={dirty}
            busy={update.isPending}
            disabled={!valid}
            onSave={save}
            onReset={() => {
              setForm(initial);
              update.reset();
            }}
          />
        </div>
      </Panel>

      <ApprovalRulesPanel agent={agent} />
    </div>
  );
}

const LINK = 'text-[var(--accent-bright)] underline-offset-4 hover:underline';

/**
 * Its web tools, each saved as soon as it is switched: searching (through the
 * search service in Settings → Models) and reading pages. Both only read.
 */
function WebPanel({ agent }: { agent: Agent }) {
  const id = useId();
  const update = useUpdateAgent();
  const saved: WebTools = agent.web ?? { search: false, fetch: false };
  // While a change saves, the switches show it.
  const web = (update.isPending && update.variables?.web) || saved;
  // Asked only when it matters: search is on.
  const searchReady = useWebSearchReady(web.search);
  const set = (change: Partial<WebTools>) =>
    saveAgentChange(agent, () => update.mutateAsync({ id: agent.id, web: { ...web, ...change } }));

  const row = (key: keyof WebTools, label: string, hint: ReactNode, extra?: ReactNode) => (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <p id={`${id}-${key}-label`} className="text-sm font-medium">
          {label}
        </p>
        <p id={`${id}-${key}-hint`} className="mt-0.5 text-xs text-[var(--text-muted)]">
          {hint}
        </p>
        {extra}
      </div>
      <Switch
        checked={web[key]}
        disabled={update.isPending}
        aria-labelledby={`${id}-${key}-label`}
        aria-describedby={`${id}-${key}-hint`}
        onCheckedChange={(on) => set({ [key]: on })}
      />
    </div>
  );

  return (
    <Panel title="Web" description="Looking things up and reading pages. Neither changes anything.">
      <div className="flex flex-col gap-4">
        {row(
          'search',
          'Search the web',
          <>
            Uses the search service in{' '}
            <Link to="/settings/models" className={LINK}>
              Settings → Models
            </Link>
            .
          </>,
          web.search && searchReady === false && (
            <p
              role="note"
              className="mt-2 flex gap-2 rounded-lg border border-[var(--warning)]/45 bg-[var(--warning)]/[0.08] px-3 py-2 text-xs text-[var(--text-primary)]"
            >
              <TriangleAlert
                className="mt-px size-3.5 shrink-0 text-[var(--warning)]"
                aria-hidden="true"
              />
              No search service is set up yet, so its searches will fail. Choose one in Settings →
              Models.
            </p>
          ),
        )}
        {row(
          'fetch',
          'Read web pages',
          'Open a link and read the page as text: ones you send, or ones it finds.',
        )}
        {update.error && <ErrorNotice>{errorMessage(update.error)}</ErrorNotice>}
      </div>
    </Panel>
  );
}

/**
 * Hiding secrets from the model, saved as soon as it is switched. On by default;
 * off for an agent that has to handle tokens (docs/api.md, "Hiding secrets").
 */
function SecretsPanel({ agent }: { agent: Agent }) {
  const id = useId();
  const update = useUpdateAgent();
  const saved = agent.security?.scrubSecrets ?? true;
  // While a change saves, the switch shows it.
  const on = update.isPending ? (update.variables?.security?.scrubSecrets ?? saved) : saved;
  return (
    <Panel
      title="Secrets"
      description="Passwords, API keys and tokens that its tools return are replaced with [redacted secret] before the model sees them and before they are saved."
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p id={`${id}-label`} className="text-sm font-medium">
              Hide secrets from the model
            </p>
            <p id={`${id}-hint`} className="mt-0.5 text-xs text-[var(--text-muted)]">
              Covers command output, files it reads, web pages, MCP results and your answers to its
              questions. It also hides the keys Pi Local gave it: its model key and its MCP servers'
              keys. Logs are always cleaned.
            </p>
          </div>
          <Switch
            checked={on}
            disabled={update.isPending}
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-hint`}
            onCheckedChange={(next) =>
              saveAgentChange(agent, () =>
                update.mutateAsync({ id: agent.id, security: { scrubSecrets: next } }),
              )
            }
          />
        </div>
        {!on && (
          <p
            role="note"
            className="flex gap-2 rounded-lg border border-[var(--warning)]/45 bg-[var(--warning)]/[0.08] px-3 py-2 text-xs text-[var(--text-primary)]"
          >
            <TriangleAlert
              className="mt-px size-3.5 shrink-0 text-[var(--warning)]"
              aria-hidden="true"
            />
            Off: the model sees whatever its tools return, secrets included, and conversations keep
            it. Turn this off only for an agent that has to handle tokens.
          </p>
        )}
        {update.error && <ErrorNotice>{errorMessage(update.error)}</ErrorNotice>}
      </div>
    </Panel>
  );
}

/**
 * The agent's MCP tools (and a pattern per server) as suggestions for the
 * approvals list: type or pick one, and it is added as a line.
 */
function McpToolAdder({
  agent,
  present,
  onAdd,
}: {
  agent: Agent;
  present: readonly string[];
  onAdd: (name: string) => void;
}) {
  const id = useId();
  const selection = readAgentMcp(agent);
  const servers = useMcpServers(selection.length > 0);
  const [text, setText] = useState('');
  if (selection.length === 0) return null;
  const suggestions = approvalSuggestions(selection, servers.data ?? []).filter(
    (name) => !present.includes(name),
  );
  const add = () => {
    const name = text.trim();
    if (!name) return;
    if (!present.includes(name)) onAdd(name);
    setText('');
  };
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <label htmlFor={`${id}-mcp`} className="text-xs font-medium text-[var(--text-secondary)]">
        Add one of its MCP tools
      </label>
      <div className="flex items-center gap-2">
        <input
          id={`${id}-mcp`}
          list={`${id}-mcp-list`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add();
          }}
          placeholder="mcp__server__tool"
          spellCheck={false}
          autoComplete="off"
          aria-describedby={`${id}-mcp-hint`}
          className={cn(FIELD, 'font-mono text-xs')}
        />
        <Button type="button" variant="secondary" className="h-10 shrink-0" onClick={add}>
          Add
        </Button>
        <datalist id={`${id}-mcp-list`}>
          {suggestions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </div>
      <p id={`${id}-mcp-hint`} className="text-xs text-[var(--text-muted)]">
        {suggestions.length > 0
          ? `${suggestions.length} suggestions from its MCP servers (MCP tab).`
          : 'Its MCP tools are all in the list, or not known yet (test its servers in Settings → MCP).'}
      </p>
    </div>
  );
}

function TimeoutField({
  id,
  choice,
  minutes,
  seconds,
  onChoice,
  onMinutes,
  serverError,
}: {
  id: string;
  choice: TimeoutChoice;
  minutes: string;
  seconds: number | null;
  onChoice: (choice: TimeoutChoice) => void;
  onMinutes: (minutes: string) => void;
  serverError: string | null;
}) {
  const options: { id: TimeoutChoice; label: string }[] = [
    ...TIMEOUT_CHOICES,
    { id: 'custom', label: 'Custom' },
  ];
  const minMinutes = MIN_TIMEOUT_SECONDS / 60;
  const maxMinutes = MAX_TIMEOUT_SECONDS / 60;
  const invalid = choice === 'custom' && seconds === null;
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1 text-sm font-medium">If you don't answer</legend>
      <p id={`${id}-hint`} className="text-xs text-[var(--text-muted)]">
        A request is denied after{' '}
        {seconds !== null ? formatTimeout(seconds) : 'the time you choose'}.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map((option) => (
          <label
            key={option.id}
            className={cn(
              'relative cursor-pointer rounded-full px-3 py-1 text-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent-bright)]',
              choice === option.id
                ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                : 'bg-[var(--bg-control)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            <input
              type="radio"
              name={id}
              className="absolute inset-0 size-full cursor-pointer appearance-none rounded-full opacity-0"
              checked={choice === option.id}
              onChange={() => onChoice(option.id)}
              aria-describedby={`${id}-hint`}
            />
            {option.label}
          </label>
        ))}
      </div>
      {choice === 'custom' && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              id={`${id}-minutes`}
              type="number"
              inputMode="numeric"
              min={minMinutes}
              max={maxMinutes}
              step={1}
              value={minutes}
              onChange={(event) => onMinutes(event.target.value)}
              aria-invalid={invalid || undefined}
              aria-describedby={`${id}-minutes-hint`}
              className={cn(FIELD, 'w-32')}
            />
            <label htmlFor={`${id}-minutes`} className="text-sm text-[var(--text-secondary)]">
              minutes
            </label>
          </div>
          <p
            id={`${id}-minutes-hint`}
            className={cn('text-xs', invalid ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]')}
          >
            A whole number from {minMinutes} to {maxMinutes.toLocaleString('en-US')} (30 days).
          </p>
        </div>
      )}
      {serverError && <ErrorNotice>{serverError}</ErrorNotice>}
    </fieldset>
  );
}

/**
 * The agent's approval rules: the built-in ones (they ask under every profile
 * and can't be removed), then the ones added with "Approve and always allow
 * this", each removable. A removal is saved at once and reaches the running
 * agent without a restart.
 */
function ApprovalRulesPanel({ agent }: { agent: Agent }) {
  const remove = useRemoveApprovalRule();
  const { rules, builtinRules } = readToolSettings(agent).approvals;
  const ruleRow = (rule: ApprovalRule, locked: boolean) => (
    <li
      key={rule.id}
      data-approval-rule={rule.id}
      className="flex items-center gap-3 rounded-lg border border-[var(--border-subtle)] px-3 py-2"
    >
      <span
        className={cn(
          'w-12 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-medium',
          rule.action === 'allow' && 'bg-[var(--success)]/15 text-[var(--success)]',
          rule.action === 'ask' && 'bg-[var(--warning)]/15 text-[var(--warning)]',
          rule.action === 'deny' && 'bg-[var(--danger)]/15 text-[var(--danger-on-tint)]',
        )}
      >
        {actionLabel(rule.action)}
      </span>
      <code className="min-w-0 flex-1 break-all font-mono text-xs text-[var(--text-primary)]">
        {describeRule(rule)}
      </code>
      {locked ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--text-muted)]">
          <Lock className="size-3" aria-hidden="true" />
          Built in
        </span>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Remove the rule: ${actionLabel(rule.action)} ${describeRule(rule)}`}
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(
              { agentId: agent.id, ruleId: rule.id },
              {
                onSuccess: () => toast('Rule removed.'),
              },
            )
          }
        >
          <Trash2 />
          Remove
        </Button>
      )}
    </li>
  );
  return (
    <Panel
      title="Approval rules"
      description="The first rule that matches a call decides, before the profile above. Built-in rules always ask, whatever your rules say."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Your rules</h3>
          {rules.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">
              No rules yet. When it asks to run something, choose “Approve and always allow this” to
              add one.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {rules.map((rule) => ruleRow(rule, false))}
            </ul>
          )}
          {remove.error && <ErrorNotice>{errorMessage(remove.error)}</ErrorNotice>}
        </div>
        {builtinRules.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Built in</h3>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {builtinRules.map((rule) => ruleRow(rule, true))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}
