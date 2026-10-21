import { Link } from '@tanstack/react-router';
import { Globe, LogIn, RefreshCw, Terminal, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, type McpServer, type McpTransport } from '~/api/client';
import { McpTestResult, TrustWarning } from '~/components/mcp/server-bits';
import {
  changedValues,
  isEdited,
  NO_EDIT,
  type StoredEdit,
  StoredSecretsField,
} from '~/components/mcp/stored-secrets';
import {
  ErrorNotice,
  FIELD,
  Field,
  HeadersEditor,
  Optional,
  RequestError,
} from '~/components/models/fields';
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
import { Switch } from '~/components/ui/switch';
import {
  type McpServerChange,
  type NewMcpServer,
  revealMcpSecret,
  useCreateMcpServer,
  useDeleteMcpServer,
  useTestMcpServer,
  useUpdateMcpServer,
} from '~/hooks/use-mcp';
import { useSecretsKept } from '~/hooks/use-session';
import {
  AGENT_DIR_VAR,
  envFromRows,
  formatArgs,
  hasLoginCommand,
  loginArgsProblem,
  MAX_SERVER_NAME,
  MAX_SLUG,
  mcpToolName,
  needsSignIn,
  parseArgs,
  type SecretRow,
  slugFromName,
  slugProblem,
  urlProblem,
  WORKSPACE_VAR,
} from '~/lib/mcp';
import { MCP_PRESETS, type McpPreset } from '~/lib/mcp-presets';
import { headersFromRows, inUseAgents, listNames } from '~/lib/models';
import { cn, plural } from '~/lib/utils';

const WORKSPACE = WORKSPACE_VAR;
const AGENT_DIR = AGENT_DIR_VAR;

interface FormState {
  transport: McpTransport;
  name: string;
  slug: string;
  /** The slug was typed (or set by a preset): it no longer follows the name. */
  slugEdited: boolean;
  description: string;
  command: string;
  /** One argument per line. */
  args: string;
  /** Its own sign-in command's arguments, one per line. */
  loginArgs: string;
  cwd: string;
  /** null: keep the stored values (editing). */
  envRows: SecretRow[] | null;
  url: string;
  headerRows: SecretRow[] | null;
  oauth: boolean;
  enabled: boolean;
  /** Editing: changes to the stored env values and headers, name by name. */
  envEdit: StoredEdit;
  headerEdit: StoredEdit;
}

const EMPTY_FORM: FormState = {
  transport: 'stdio',
  name: '',
  slug: '',
  slugEdited: false,
  description: '',
  command: '',
  args: '',
  loginArgs: '',
  cwd: '',
  envRows: [],
  url: '',
  headerRows: [],
  oauth: false,
  enabled: true,
  envEdit: NO_EDIT,
  headerEdit: NO_EDIT,
};

const formOf = (server: McpServer): FormState => ({
  transport: server.transport,
  name: server.name,
  slug: server.slug,
  slugEdited: true,
  description: server.description,
  command: server.command ?? '',
  args: formatArgs(server.args),
  loginArgs: formatArgs(server.loginArgs ?? []),
  cwd: server.cwd ?? '',
  envRows: null,
  url: server.url ?? '',
  headerRows: null,
  oauth: server.oauth,
  enabled: server.enabled,
  envEdit: NO_EDIT,
  headerEdit: NO_EDIT,
});

/** What's wrong with the form before it is sent, or null. */
function formProblem(form: FormState, server: McpServer | null): string | null {
  const adding = server === null;
  if (!form.name.trim()) return 'Give it a name.';
  if (adding) {
    const slug = slugProblem(form.slug);
    if (slug) return `ID: ${slug}`;
  }
  if (form.transport === 'stdio') {
    if (!form.command.trim()) return 'Enter the command that starts it, such as npx.';
    const login = loginArgsProblem(parseArgs(form.loginArgs));
    if (login) return login;
    if (form.envRows) {
      const env = envFromRows(form.envRows);
      if (env.error !== undefined) return env.error;
    }
    if (server) {
      const env = envFromRows(form.envEdit.added);
      if (env.error !== undefined) return env.error;
      const kept = server.envNames.filter((n) => !form.envEdit.removed.includes(n));
      const taken = Object.keys(env.env).find((n) => kept.includes(n));
      if (taken) return `${taken} is already set: change its value above.`;
    }
  } else {
    const url = urlProblem(form.url);
    if (url) return url;
    if (form.headerRows) {
      const headers = headersFromRows(form.headerRows);
      if (headers.error !== undefined) return headers.error;
    }
    if (server) {
      const headers = headersFromRows(form.headerEdit.added);
      if (headers.error !== undefined) return headers.error;
      const kept = server.headerNames
        .filter((n) => !form.headerEdit.removed.includes(n))
        .map((n) => n.toLowerCase());
      const taken = Object.keys(headers.headers).find((n) => kept.includes(n.toLowerCase()));
      if (taken) return `${taken} is already set: change its value above.`;
    }
  }
  return null;
}

/** Secret name/value rows, for a new server (an existing one uses StoredSecretsField). */
function SecretsField({
  legend,
  noun,
  namePlaceholder,
  rows,
  onChange,
  hint,
}: {
  legend: string;
  noun: string;
  namePlaceholder: string;
  rows: SecretRow[] | null;
  onChange: (rows: SecretRow[]) => void;
  hint?: ReactNode;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1.5 text-sm font-medium">
        {legend} <Optional />
      </legend>
      {hint && <p className="-mt-1 text-xs text-[var(--text-muted)]">{hint}</p>}
      <HeadersEditor
        rows={rows ?? []}
        onChange={onChange}
        noun={noun}
        namePlaceholder={namePlaceholder}
      />
    </fieldset>
  );
}

const PLACEHOLDERS_HINT = (
  <>
    <span className="font-mono">{WORKSPACE}</span> is the agent’s workspace folder and{' '}
    <span className="font-mono">{AGENT_DIR}</span> its own folder: each agent starts its own copy of
    the server with them filled in.
  </>
);

/** The fields of a server, for adding one and for changing one. */
function ServerFields({
  form,
  setForm,
  server,
}: {
  form: FormState;
  setForm: (change: Partial<FormState>) => void;
  /** The server being changed; none when adding. */
  server: McpServer | null;
}) {
  const id = useId();
  const kept = useSecretsKept();
  const adding = server === null;
  const slugIssue = adding && form.slug ? slugProblem(form.slug) : null;
  return (
    <>
      <Field id={`${id}-name`} label="Name">
        <input
          id={`${id}-name`}
          maxLength={MAX_SERVER_NAME}
          value={form.name}
          onChange={(event) => {
            const name = event.target.value;
            setForm(form.slugEdited ? { name } : { name, slug: slugFromName(name) });
          }}
          placeholder="GitHub"
          className={FIELD}
        />
      </Field>
      {adding ? (
        <Field
          id={`${id}-slug`}
          label="ID"
          hint={
            slugIssue ?? (
              <>
                Its tools are named{' '}
                <span className="font-mono">{mcpToolName(form.slug || 'id', 'tool')}</span>. It
                can’t be changed later.
              </>
            )
          }
        >
          <input
            id={`${id}-slug`}
            maxLength={MAX_SLUG}
            value={form.slug}
            onChange={(event) =>
              setForm({ slug: event.target.value.toLowerCase(), slugEdited: true })
            }
            placeholder="github"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={slugIssue ? true : undefined}
            aria-describedby={`${id}-slug-hint`}
            className={cn(FIELD, 'font-mono')}
          />
        </Field>
      ) : null}
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
          onChange={(event) => setForm({ description: event.target.value })}
          className={FIELD}
        />
      </Field>

      {form.transport === 'stdio' ? (
        <>
          <TrustWarning />
          <Field id={`${id}-command`} label="Command">
            <input
              id={`${id}-command`}
              value={form.command}
              onChange={(event) => setForm({ command: event.target.value })}
              placeholder="npx"
              spellCheck={false}
              autoComplete="off"
              className={cn(FIELD, 'font-mono')}
            />
          </Field>
          <Field
            id={`${id}-args`}
            label={
              <>
                Arguments <Optional />
              </>
            }
            hint={<>One per line, each as it is (spaces included). {PLACEHOLDERS_HINT}</>}
          >
            <textarea
              id={`${id}-args`}
              rows={4}
              value={form.args}
              onChange={(event) => setForm({ args: event.target.value })}
              placeholder={`-y\n@modelcontextprotocol/server-filesystem\n${WORKSPACE}`}
              spellCheck={false}
              aria-describedby={`${id}-args-hint`}
              className={cn(FIELD, 'h-auto min-h-24 resize-y py-2 font-mono text-xs')}
            />
          </Field>
          <Field
            id={`${id}-login-args`}
            label={
              <>
                Sign-in arguments <Optional />
              </>
            }
            hint={
              <>
                The full arguments for its sign-in, one per line: usually the same script, then{' '}
                <span className="font-mono">login</span>. It runs with the same command; it adds a
                Sign in button.
              </>
            }
          >
            <textarea
              id={`${id}-login-args`}
              rows={2}
              value={form.loginArgs}
              onChange={(event) => setForm({ loginArgs: event.target.value })}
              placeholder="login"
              spellCheck={false}
              aria-describedby={`${id}-login-args-hint`}
              className={cn(FIELD, 'h-auto min-h-16 resize-y py-2 font-mono text-xs')}
            />
          </Field>
          <Field
            id={`${id}-cwd`}
            label={
              <>
                Working directory <Optional />
              </>
            }
            hint={
              <>
                Where it starts. Leave empty for the agent’s workspace (
                <span className="font-mono">{WORKSPACE}</span>).
              </>
            }
          >
            <input
              id={`${id}-cwd`}
              value={form.cwd}
              onChange={(event) => setForm({ cwd: event.target.value })}
              placeholder={WORKSPACE}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={`${id}-cwd-hint`}
              className={cn(FIELD, 'font-mono')}
            />
          </Field>
          {server ? (
            <StoredSecretsField
              legend="Environment variables"
              noun="variable"
              namePlaceholder="API_TOKEN"
              names={server.envNames}
              edit={form.envEdit}
              onChange={(envEdit) => setForm({ envEdit })}
              reveal={(name) => revealMcpSecret(server.slug, 'env', name)}
              hint={`Values are ${kept}. Type a new value to change one; the others stay as they are.`}
            />
          ) : (
            <SecretsField
              legend="Environment variables"
              noun="variable"
              namePlaceholder="API_TOKEN"
              rows={form.envRows}
              onChange={(envRows) => setForm({ envRows })}
              hint={`Such as an API token the server needs, or a setting. Values are ${kept}.`}
            />
          )}
        </>
      ) : (
        <>
          <Field
            id={`${id}-url`}
            label="URL"
            hint="Its Streamable HTTP endpoint: https://, or http:// for a server on this computer or network."
          >
            <input
              id={`${id}-url`}
              type="url"
              inputMode="url"
              value={form.url}
              onChange={(event) => setForm({ url: event.target.value })}
              placeholder="https://example.com/mcp"
              spellCheck={false}
              aria-describedby={`${id}-url-hint`}
              className={FIELD}
            />
          </Field>
          {server ? (
            <StoredSecretsField
              legend="Headers"
              noun="header"
              namePlaceholder="Authorization"
              names={server.headerNames}
              edit={form.headerEdit}
              onChange={(headerEdit) => setForm({ headerEdit })}
              reveal={(name) => revealMcpSecret(server.slug, 'header', name)}
              hint={`Sent with every request. Values are ${kept}. Type a new value to change one.`}
            />
          ) : (
            <SecretsField
              legend="Headers"
              noun="header"
              namePlaceholder="Authorization"
              rows={form.headerRows}
              onChange={(headerRows) => setForm({ headerRows })}
              hint={`Sent with every request, such as an API key. Values are ${kept}.`}
            />
          )}
          <div className="flex items-center justify-between gap-4">
            <span>
              <span id={`${id}-oauth-label`} className="block text-sm font-medium">
                Sign in with OAuth
              </span>
              <span id={`${id}-oauth-hint`} className="block text-xs text-[var(--text-muted)]">
                For a server that asks you to sign in to your account in the browser. The sign-in is
                {kept}.
              </span>
            </span>
            <Switch
              checked={form.oauth}
              onCheckedChange={(oauth) => setForm({ oauth })}
              aria-labelledby={`${id}-oauth-label`}
              aria-describedby={`${id}-oauth-hint`}
            />
          </div>
        </>
      )}
      {!adding && (
        <div className="flex items-center justify-between gap-4">
          <span>
            <span id={`${id}-enabled-label`} className="block text-sm font-medium">
              Use this server
            </span>
            <span id={`${id}-enabled-hint`} className="block text-xs text-[var(--text-muted)]">
              Turned off, agents that use it start without it.
            </span>
          </span>
          <Switch
            checked={form.enabled}
            onCheckedChange={(enabled) => setForm({ enabled })}
            aria-labelledby={`${id}-enabled-label`}
            aria-describedby={`${id}-enabled-hint`}
          />
        </div>
      )}
    </>
  );
}

/** stdio or http, as two choices. */
function TransportChoice({
  value,
  onChange,
}: {
  value: McpTransport;
  onChange: (transport: McpTransport) => void;
}) {
  const id = useId();
  const options: { id: McpTransport; label: string; hint: string; icon: ReactNode }[] = [
    {
      id: 'stdio',
      label: 'A program on this computer',
      hint: 'stdio: a command each agent starts, such as npx or uvx.',
      icon: <Terminal className="size-4" aria-hidden="true" />,
    },
    {
      id: 'http',
      label: 'A remote server',
      hint: 'Streamable HTTP: a URL, with headers or an OAuth sign-in.',
      icon: <Globe className="size-4" aria-hidden="true" />,
    },
  ];
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-1.5 text-sm font-medium">Kind</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.id}
            htmlFor={`${id}-${option.id}`}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent-bright)]',
              value === option.id
                ? // In light the control grey is the dialog's own white: the accent marks the choice.
                  'border-[var(--accent-button-border)] bg-[var(--accent-soft)] dark:border-[var(--border-strong)] dark:bg-[var(--bg-control)]'
                : 'border-[var(--border-subtle)] hover:bg-[var(--bg-control-hover)]/60 dark:hover:bg-[var(--bg-control)]/60',
            )}
          >
            <input
              id={`${id}-${option.id}`}
              type="radio"
              name={id}
              checked={value === option.id}
              onChange={() => onChange(option.id)}
              className="sr-only"
            />
            <span className="mt-0.5 text-[var(--text-secondary)]">{option.icon}</span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="block text-xs text-[var(--text-muted)]">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function PresetChips({
  current,
  onPick,
}: {
  current: string | null;
  onPick: (preset: McpPreset) => void;
}) {
  const picked = MCP_PRESETS.find((preset) => preset.id === current);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium" id="mcp-presets-label">
        Quick start
      </span>
      <ul className="flex flex-wrap gap-1.5" aria-labelledby="mcp-presets-label">
        {MCP_PRESETS.map((preset) => (
          <li key={preset.id}>
            <button
              type="button"
              aria-pressed={preset.id === current}
              title={preset.description}
              onClick={() => onPick(preset)}
              className={cn(
                'rounded-full px-3 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-bright)]',
                preset.id === current
                  ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                  : 'bg-[var(--bg-control)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              {preset.name}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-[var(--text-muted)]" aria-live="polite">
        {picked
          ? `${picked.description}${picked.note ? ` ${picked.note}` : ''}`
          : 'Fill in the form for a common server; you can still change everything.'}
      </p>
    </div>
  );
}

/**
 * Adding a server: what kind, its command or URL, and its secrets. The backend
 * tests it at once; the dialog then shows what it found (its tools, or the
 * error with stderr).
 */
export function AddServerDialog({
  onClose,
  onSignIn,
  onLogin,
}: {
  onClose: () => void;
  /** Start an OAuth sign-in for the new server (the page follows it). */
  onSignIn: (server: McpServer) => void;
  /** Run the new server's own sign-in command (the page's sign-in dialog replaces this one). */
  onLogin?: (server: McpServer) => void;
}) {
  const create = useCreateMcpServer();
  const test = useTestMcpServer();
  const [form, setFormState] = useState<FormState>(EMPTY_FORM);
  const [preset, setPreset] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<McpServer | null>(null);
  const setForm = (change: Partial<FormState>) =>
    setFormState((before) => ({ ...before, ...change }));
  const dirty =
    !created &&
    (form.name !== '' ||
      form.command !== '' ||
      form.url !== '' ||
      form.args !== '' ||
      form.loginArgs !== '' ||
      preset !== null);

  const pick = (next: McpPreset) => {
    setPreset(next.id);
    setProblem(null);
    setFormState({
      ...EMPTY_FORM,
      transport: 'stdio',
      name: next.name,
      slug: next.slug,
      slugEdited: true,
      description: next.description,
      command: next.command,
      args: formatArgs(next.args),
      envRows: next.env.map((name) => ({ name, value: '' })),
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const issue = formProblem(form, null);
    if (issue) return setProblem(issue);
    setProblem(null);
    const base = {
      name: form.name.trim(),
      slug: form.slug,
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
    };
    let body: NewMcpServer;
    if (form.transport === 'stdio') {
      const env = envFromRows(form.envRows ?? []);
      const args = parseArgs(form.args);
      const loginArgs = parseArgs(form.loginArgs);
      body = {
        ...base,
        transport: 'stdio',
        command: form.command.trim(),
        ...(args.length > 0 ? { args } : {}),
        ...(loginArgs.length > 0 ? { loginArgs } : {}),
        ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
        ...(env.error === undefined && Object.keys(env.env).length > 0 ? { env: env.env } : {}),
      };
    } else {
      const headers = headersFromRows(form.headerRows ?? []);
      body = {
        ...base,
        transport: 'http',
        url: form.url.trim(),
        ...(headers.error === undefined && Object.keys(headers.headers).length > 0
          ? { headers: headers.headers }
          : {}),
        oauth: form.oauth,
      };
    }
    create.mutate(body, { onSuccess: setCreated });
  };

  if (created) {
    const ownSignIn = onLogin !== undefined && hasLoginCommand(created);
    // Its test likely failed for want of a sign-in: Sign in comes first.
    const signInFirst = needsSignIn(created) || (ownSignIn && Boolean(created.lastError));
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{created.name} added</DialogTitle>
            <DialogDescription>
              Choose which agents use it on each agent’s MCP tab (Settings → Agents).
            </DialogDescription>
          </DialogHeader>
          <div aria-live="polite">
            {test.isPending ? (
              <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <Spinner className="size-4" /> Testing… this can take up to a minute.
              </p>
            ) : (
              <McpTestResult server={created} />
            )}
          </div>
          {test.error ? <ErrorNotice>{errorMessage(test.error)}</ErrorNotice> : null}
          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="secondary"
              disabled={test.isPending}
              onClick={() => test.mutate(created.slug, { onSuccess: setCreated })}
            >
              <RefreshCw />
              Test again
            </Button>
            {needsSignIn(created) && (
              <Button
                type="button"
                variant="primary"
                onClick={() => {
                  onSignIn(created);
                  onClose();
                }}
              >
                Sign in
              </Button>
            )}
            {ownSignIn && (
              <Button
                type="button"
                variant={signInFirst ? 'primary' : 'secondary'}
                onClick={() => onLogin(created)}
              >
                <LogIn />
                Sign in
              </Button>
            )}
            <Button type="button" variant={signInFirst ? 'secondary' : 'primary'} onClick={onClose}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent className={cn(SCROLLING_DIALOG, 'max-w-xl')} confirmDiscard={dirty}>
        <DialogHeader>
          <DialogTitle>Add an MCP server</DialogTitle>
          <DialogDescription>
            Tools for your agents from a program on this computer or a server on the web. It is
            tested as soon as you add it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="flex flex-col gap-4">
            <TransportChoice
              value={form.transport}
              onChange={(transport) => {
                setForm({ transport });
                if (transport === 'http') setPreset(null);
              }}
            />
            {form.transport === 'stdio' && <PresetChips current={preset} onPick={pick} />}
            <ServerFields form={form} setForm={setForm} server={null} />
            {problem && <ErrorNotice>{problem}</ErrorNotice>}
            <RequestError error={create.error} what="This server" />
            {create.isPending && (
              <p
                className="flex items-center gap-2 text-sm text-[var(--text-muted)]"
                aria-live="polite"
              >
                <Spinner className="size-4" />
                {form.transport === 'stdio'
                  ? 'Starting it and listing its tools. This can take up to a minute (npx may download it first).'
                  : 'Connecting and listing its tools. This can take up to a minute.'}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={create.isPending}>
              {create.isPending && <Spinner className="size-4 text-current" />}
              {create.isPending ? 'Testing…' : 'Add and test'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The fields that changed, for `PATCH /api/mcp/servers/{slug}`. */
function changesOf(server: McpServer, form: FormState): McpServerChange {
  const body: McpServerChange = { slug: server.slug };
  if (form.name.trim() !== server.name) body.name = form.name.trim();
  if (form.description.trim() !== server.description) body.description = form.description.trim();
  if (server.transport === 'stdio') {
    if (form.command.trim() !== (server.command ?? '')) body.command = form.command.trim();
    const args = parseArgs(form.args);
    if (JSON.stringify(args) !== JSON.stringify(server.args)) body.args = args;
    const loginArgs = parseArgs(form.loginArgs);
    if (JSON.stringify(loginArgs) !== JSON.stringify(server.loginArgs ?? []))
      body.loginArgs = loginArgs;
    if (form.cwd.trim() !== (server.cwd ?? '')) body.cwd = form.cwd.trim();
    const added = envFromRows(form.envEdit.added);
    const envSet = {
      ...changedValues(form.envEdit),
      ...(added.error === undefined ? added.env : {}),
    };
    if (Object.keys(envSet).length > 0) body.envSet = envSet;
    if (form.envEdit.removed.length > 0) body.envRemove = form.envEdit.removed;
  } else {
    if (form.url.trim() !== (server.url ?? '')) body.url = form.url.trim();
    const added = headersFromRows(form.headerEdit.added);
    const headersSet = {
      ...changedValues(form.headerEdit),
      ...(added.error === undefined ? added.headers : {}),
    };
    if (Object.keys(headersSet).length > 0) body.headersSet = headersSet;
    if (form.headerEdit.removed.length > 0) body.headersRemove = form.headerEdit.removed;
    if (form.oauth !== server.oauth) body.oauth = form.oauth;
  }
  if (form.enabled !== server.enabled) body.enabled = form.enabled;
  return body;
}

/** Changing a server: everything but its ID and kind; stored values change one at a time, shown on request. */
export function EditServerDialog({ server, onClose }: { server: McpServer; onClose: () => void }) {
  const update = useUpdateMcpServer();
  const [form, setFormState] = useState<FormState>(() => formOf(server));
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const setForm = (change: Partial<FormState>) =>
    setFormState((before) => ({ ...before, ...change }));
  const changes = changesOf(server, form);
  const dirty =
    Object.keys(changes).length > 1 || isEdited(form.envEdit) || isEdited(form.headerEdit);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const issue = formProblem(form, server);
    if (issue) return setProblem(issue);
    setProblem(null);
    update.mutate(changes, {
      onSuccess: (saved) => {
        toast(
          saved.usedBy.length > 0
            ? `${saved.name} saved. ${plural(saved.usedBy.length, 'agent')} using it ${saved.usedBy.length === 1 ? 'restarts' : 'restart'}.`
            : `${saved.name} saved.`,
        );
        onClose();
      },
    });
  };

  if (deleting)
    return (
      <DeleteServerDialog server={server} onClose={() => setDeleting(false)} onDeleted={onClose} />
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto"
        confirmDiscard={dirty}
      >
        <DialogHeader>
          <DialogTitle>Edit {server.name}</DialogTitle>
          <DialogDescription>
            {server.transport === 'stdio' ? 'A program on this computer' : 'A remote server'} ·{' '}
            <span className="font-mono text-xs">{server.slug}</span>. Agents using it restart when
            you save; test it again to list its tools.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <ServerFields form={form} setForm={setForm} server={server} />
          {problem && <ErrorNotice>{problem}</ErrorNotice>}
          <RequestError error={update.error} what={server.name} />
          <DialogFooter className="mt-2 justify-between">
            <Button type="button" variant="ghost" onClick={() => setDeleting(true)}>
              <Trash2 />
              Delete
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!dirty || update.isPending}>
                {update.isPending && <Spinner className="size-4 text-current" />}
                Save
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Agents, each a link to its MCP tab. */
function AgentLinks({ agents }: { agents: { id: string; name: string }[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {agents.map((agent) => (
        <li key={agent.id}>
          <Link
            to="/settings/agents/$agentId"
            params={{ agentId: agent.id }}
            search={{ tab: 'mcp' }}
            className="rounded-md bg-[var(--bg-control)] px-2 py-0.5 text-xs text-[var(--text-primary)] underline-offset-4 hover:underline"
          >
            {agent.name}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Delete this server?" A server agents still use can't be: the backend says
 * which (`409 in_use`), and they are linked to their MCP tab.
 */
export function DeleteServerDialog({
  server,
  onClose,
  onDeleted,
}: {
  server: McpServer;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const remove = useDeleteMcpServer();
  // `409 in_use` names the agents; without them, its message is said instead.
  const named = remove.error ? inUseAgents(remove.error) : null;
  const inUse = named && named.length > 0 ? named : null;
  const users = inUse ?? server.usedBy;
  // Agents use it: it can't be deleted until it is removed from them (the note says how).
  const blocked = server.usedBy.length > 0;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {server.name}?</DialogTitle>
          <DialogDescription>
            It is removed from Pi Local with its stored{' '}
            {server.transport === 'stdio' ? 'variable values' : 'header values and sign-in'}.
          </DialogDescription>
        </DialogHeader>
        {users.length > 0 && (
          <div
            role={inUse ? 'alert' : 'note'}
            className={cn(
              'rounded-lg px-3 py-2 text-sm',
              inUse
                ? 'bg-[var(--danger)]/15 text-[var(--danger-on-tint)]'
                : 'bg-[var(--bg-control)] text-[var(--text-secondary)]',
            )}
          >
            <p>
              {listNames(
                users.map((agent) => agent.name),
                users.length,
              )}{' '}
              {users.length === 1 ? 'uses' : 'use'} it. Remove it on{' '}
              {users.length === 1 ? 'that agent’s' : 'their'} MCP tab first.
            </p>
            <AgentLinks agents={users} />
          </div>
        )}
        {remove.error && !inUse ? <ErrorNotice>{errorMessage(remove.error)}</ErrorNotice> : null}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={blocked || remove.isPending}
            onClick={() =>
              remove.mutate(server.slug, {
                onSuccess: () => {
                  toast(`${server.name} deleted.`);
                  onClose();
                  onDeleted?.();
                },
              })
            }
          >
            {remove.isPending && <Spinner className="size-4 text-current" />}
            Delete server
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
