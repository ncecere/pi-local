import type {
  Agent,
  AgentMcpServer,
  McpImportSourceId,
  McpLoginStatus,
  McpServer,
  McpTool,
} from '~/api/types';

/**
 * MCP servers (docs/api.md, Phase 5): the pure parts of the catalog page, the
 * add/edit form, and an agent's choice of servers and tools.
 */

/** `/api/mcp/servers/{slug}…`, the slug encoded. */
export const mcpServerPath = (slug: string, rest = '') =>
  `/api/mcp/servers/${encodeURIComponent(slug)}${rest}`;

/** `${workspace}`: the agent's workspace folder, filled in by the runtime. */
export const WORKSPACE_VAR = '$' + '{workspace}';
/** `${agentDir}`: the agent's own folder. */
export const AGENT_DIR_VAR = '$' + '{agentDir}';

// ── Slugs ───────────────────────────────────────────────────────────────────────────────────

export const MAX_SLUG = 32;
export const MAX_SERVER_NAME = 60;

const SLUG = /^[a-z0-9](?:[a-z0-9_]{0,30}[a-z0-9])?$/;

/**
 * A slug from a server's name, as the backend makes one (internal/mcp Slug):
 * lower case, every run of other characters one `_`, no `_` at either end, at
 * most 32 characters ("GitHub (work)" → "github_work").
 */
export function slugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug.slice(0, MAX_SLUG).replace(/_+$/, '');
}

/** Why a slug can't be used, or null when it can. */
export function slugProblem(slug: string): string | null {
  if (!slug) return 'Enter a short ID, such as "github".';
  if (slug.length > MAX_SLUG) return `At most ${MAX_SLUG} characters.`;
  if (!SLUG.test(slug))
    return 'Use lower-case letters, digits and _ only, not starting or ending with _.';
  return null;
}

// ── Arguments and environment ─────────────────────────────────────────────────────────────

/**
 * Command arguments typed one per line: each line is one argument as it is
 * (spaces inside it included; the ends trimmed); blank lines are skipped.
 */
export function parseArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Arguments as the field shows them: one per line. */
export const formatArgs = (args: readonly string[]) => args.join('\n');

/** A command line to read (not to run): arguments with spaces or quotes are quoted. */
export function commandLine(
  command: string | null | undefined,
  args?: readonly string[] | null,
): string {
  const quote = (part: string) =>
    part === '' || /[\s"'\\]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part;
  return [command ?? '', ...(args ?? [])]
    .filter((part, index) => index > 0 || part)
    .map(quote)
    .join(' ');
}

export interface SecretRow {
  name: string;
  value: string;
}

/** An environment variable's name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Environment variables from the form's rows: fully empty rows are skipped;
 * every other row needs a valid name and a value, once each.
 */
export function envFromRows(
  rows: readonly SecretRow[],
): { env: Record<string, string>; error?: undefined } | { error: string } {
  const env: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name && !row.value) continue;
    if (!name) return { error: 'Each variable needs a name.' };
    if (!ENV_NAME.test(name))
      return {
        error: `“${name}” is not a valid name: letters, digits and _, not starting with a digit.`,
      };
    if (!row.value) return { error: `Enter a value for ${name}.` };
    if (name in env) return { error: `${name} is listed twice.` };
    env[name] = row.value;
  }
  return { env };
}

/** The rows to replace secrets with: their names, values to be typed again. */
export const rowsFor = (names: readonly string[]): SecretRow[] =>
  names.length > 0 ? names.map((name) => ({ name, value: '' })) : [{ name: '', value: '' }];

/** Whether an MCP URL is acceptable: https, or http to this computer or the local network. */
export function urlProblem(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return 'Enter the server’s full URL, such as https://example.com/mcp.';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol !== 'http:') return 'Use an https:// URL.';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^fe80:/i.test(host);
  return local ? null : 'Use https://, or http:// only for a server on this computer or network.';
}

// ── Tool names ──────────────────────────────────────────────────────────────────────────────

export const MAX_TOOL_NAME = 64;

/**
 * The name an agent's model sees for a server's tool, by the runtime's rule
 * (runtime/src/lib/mcp.ts toolName): `mcp__<slug>__<tool>`, every character
 * outside [A-Za-z0-9_-] made `_`, cut to 64.
 */
export function mcpToolName(slug: string, tool: string): string {
  return `mcp__${slug}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, MAX_TOOL_NAME);
}

/** A pattern matching every tool of a server (for approvals). */
export const mcpServerPattern = (slug: string) => `mcp__${slug}__*`;

/** The tools an agent may get from a server: the model-visible ones. */
export const visibleTools = (server: Pick<McpServer, 'tools'>): McpTool[] =>
  server.tools.filter((tool) => tool.modelVisible);

// ── Status ──────────────────────────────────────────────────────────────────────────────────

export type McpStatusId = 'off' | 'needs-sign-in' | 'error' | 'untested' | 'ok';

export interface McpStatus {
  id: McpStatusId;
  /** Short: for a badge. */
  label: string;
  /** For an agent using it: what that means. */
  forAgent: string;
}

/** The server needs an OAuth sign-in before it can be used. */
export const needsSignIn = (
  server: Pick<McpServer, 'transport' | 'oauth' | 'signedIn' | 'lastError'>,
) =>
  (server.transport === 'http' && server.oauth && !server.signedIn) ||
  Boolean(server.lastError?.includes('needs_sign_in'));

/** What state a server is in, from the catalog's point of view. */
export function serverStatus(
  server: Pick<
    McpServer,
    'enabled' | 'transport' | 'oauth' | 'signedIn' | 'lastError' | 'testedAt' | 'tools'
  >,
): McpStatus {
  if (!server.enabled)
    return { id: 'off', label: 'Off', forAgent: 'It is turned off: agents start without it.' };
  if (needsSignIn(server))
    return {
      id: 'needs-sign-in',
      label: 'Needs sign-in',
      forAgent: 'It needs you to sign in (Settings → MCP) before agents can use it.',
    };
  if (server.lastError)
    return {
      id: 'error',
      label: 'Error',
      forAgent: 'Its last test failed: agents may start without it. Test it in Settings → MCP.',
    };
  if (server.testedAt === null)
    return {
      id: 'untested',
      label: 'Not tested',
      forAgent: 'It hasn’t been tested yet: agents start without it until it is.',
    };
  const count = visibleTools(server).length;
  return {
    id: 'ok',
    label: count === 1 ? '1 tool' : `${count} tools`,
    forAgent: '',
  };
}

// ── Live events ─────────────────────────────────────────────────────────────────────────────

/** The catalog with one server changed (or added at the end), or removed (`server` null). */
export function applyMcpEvent(
  list: McpServer[] | undefined,
  slug: string,
  server: McpServer | null | undefined,
): McpServer[] | undefined {
  if (!list) return list;
  if (!server) return list.filter((candidate) => candidate.slug !== slug);
  const index = list.findIndex((candidate) => candidate.slug === slug);
  if (index < 0) return [...list, server];
  const next = list.slice();
  next[index] = server;
  return next;
}

/**
 * What an OAuth sign-in in progress has come to, comparing the server now with
 * when it began: signed in (newly, or again), or failed (not signed in, with a
 * new error or a new test). Anything else, such as the same "needs_sign_in"
 * again, is still waiting.
 */
export function signInOutcome(
  before: Pick<McpServer, 'signedIn' | 'updatedAt' | 'lastError' | 'testedAt'>,
  now: Pick<McpServer, 'signedIn' | 'updatedAt' | 'lastError' | 'testedAt'> | undefined,
): 'waiting' | 'signed-in' | 'failed' | 'gone' {
  if (!now) return 'gone';
  if (now.signedIn && (!before.signedIn || now.updatedAt !== before.updatedAt)) return 'signed-in';
  if (
    !now.signedIn &&
    now.lastError &&
    (now.lastError !== before.lastError || now.testedAt !== before.testedAt)
  )
    return 'failed';
  return 'waiting';
}

// ── A local server's own sign-in command ───────────────────────────────────────────────────

/** A stdio server that signs in with its own command (`loginArgs`): it gets a Sign in button. */
export const hasLoginCommand = (server: Pick<McpServer, 'transport' | 'loginArgs'>) =>
  server.transport === 'stdio' && (server.loginArgs?.length ?? 0) > 0;

/** Why sign-in arguments can't be used, or null (the backend refuses the placeholders too). */
export function loginArgsProblem(args: readonly string[]): string | null {
  if (args.some((arg) => arg.includes(WORKSPACE_VAR) || arg.includes(AGENT_DIR_VAR)))
    return `Sign-in arguments can’t use ${WORKSPACE_VAR} or ${AGENT_DIR_VAR}: the sign-in runs once, not for each agent.`;
  return null;
}

/**
 * A sign-in run's status, kept when an answer or event arrives out of order: an
 * older run never replaces a newer one, and the same run never goes back to
 * running nor loses output it had (its output only grows, until it is cut to
 * the last 16 KiB).
 */
export function applyLoginStatus(
  before: McpLoginStatus | undefined,
  next: McpLoginStatus,
): McpLoginStatus {
  if (!before || before.slug !== next.slug || next.startedAt === null) return next;
  if (before.startedAt === null || next.startedAt > before.startedAt) return next;
  if (next.startedAt < before.startedAt) return before;
  if (before.state !== 'running' && next.state === 'running') return before;
  if (
    before.state === 'running' &&
    next.state === 'running' &&
    next.output.length < before.output.length
  )
    return before;
  return next;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/g;

/**
 * Text cut into plain parts and web addresses (http and https), for a
 * command's output with its links clickable. Punctuation ending a sentence
 * after an address, or a bracket that closes around it, is not part of it.
 */
export function linkParts(text: string): { text: string; url?: string }[] {
  const parts: { text: string; url?: string }[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    let url = match[0];
    for (;;) {
      const end = url.at(-1) ?? '';
      if (/[.,;:!?]/.test(end)) url = url.slice(0, -1);
      else if (
        (end === ')' && !url.includes('(')) ||
        (end === ']' && !url.includes('[')) ||
        end === '}'
      )
        url = url.slice(0, -1);
      else break;
    }
    if (!/^https?:\/\/[^/?#]/.test(url)) continue;
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ text: url, url });
    last = match.index + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

// ── An agent's servers ──────────────────────────────────────────────────────────────────────

/** An agent's choice, as saved (a copy; an older backend's agent has none). */
export function readAgentMcp(agent: Pick<Agent, 'mcp'>): AgentMcpServer[] {
  return (agent.mcp ?? []).map((choice) => ({
    server: choice.server,
    tools: choice.tools === null || choice.tools === undefined ? null : [...choice.tools],
  }));
}

export const isChosen = (selection: readonly AgentMcpServer[], slug: string) =>
  selection.some((choice) => choice.server === slug);

/** Use a server (with all its tools) or stop using it. */
export function chooseServer(
  selection: readonly AgentMcpServer[],
  slug: string,
  on: boolean,
): AgentMcpServer[] {
  if (!on) return selection.filter((choice) => choice.server !== slug);
  if (isChosen(selection, slug)) return [...selection];
  return [...selection, { server: slug, tools: null }];
}

/**
 * All of a server's tools (`null`), or pick them. Picking starts from every
 * tool it has now, so nothing changes until one is unticked.
 */
export function setToolMode(
  selection: readonly AgentMcpServer[],
  server: Pick<McpServer, 'slug' | 'tools'>,
  mode: 'all' | 'pick',
): AgentMcpServer[] {
  return selection.map((choice) => {
    if (choice.server !== server.slug) return choice;
    if (mode === 'all') return { server: choice.server, tools: null };
    if (choice.tools !== null) return choice;
    return { server: choice.server, tools: visibleTools(server).map((tool) => tool.name) };
  });
}

/** Tick or untick one tool of a server whose tools are picked; kept in the server's order. */
export function pickTool(
  selection: readonly AgentMcpServer[],
  server: Pick<McpServer, 'slug' | 'tools'>,
  tool: string,
  on: boolean,
): AgentMcpServer[] {
  const order = visibleTools(server).map((candidate) => candidate.name);
  return selection.map((choice) => {
    if (choice.server !== server.slug) return choice;
    const picked = new Set(choice.tools ?? order);
    if (on) picked.add(tool);
    else picked.delete(tool);
    // Known tools in the server's order, then any it no longer lists.
    const tools = [
      ...order.filter((name) => picked.has(name)),
      ...[...picked].filter((name) => !order.includes(name)),
    ];
    return { server: choice.server, tools };
  });
}

/** Why a choice can't be saved (a server with no tools picked), or null. */
export function selectionProblem(
  selection: readonly AgentMcpServer[],
  servers: readonly Pick<McpServer, 'slug' | 'name'>[],
): string | null {
  for (const choice of selection)
    if (choice.tools !== null && choice.tools.length === 0) {
      const name = servers.find((server) => server.slug === choice.server)?.name ?? choice.server;
      return `Pick at least one tool of ${name}, or choose All tools.`;
    }
  return null;
}

/** Two choices are the same (order of servers aside). */
export function sameSelection(a: readonly AgentMcpServer[], b: readonly AgentMcpServer[]): boolean {
  const key = (list: readonly AgentMcpServer[]) =>
    JSON.stringify(
      [...list]
        .map((choice) => [choice.server, choice.tools === null ? null : [...choice.tools].sort()])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
  return key(a) === key(b);
}

export interface AgentMcpTool {
  /** What the model sees: `mcp__<slug>__<tool>`. */
  name: string;
  server: string;
  tool: string;
  /** Picked, but the server's last test didn't list it (or it is hidden from the model). */
  missing: boolean;
}

/**
 * The MCP tools an agent gets from its choice, by the catalog's last tests: a
 * server's model-visible tools (all, or the picked ones). Unknown servers give none.
 */
export function agentMcpTools(
  selection: readonly AgentMcpServer[],
  servers: readonly McpServer[],
): AgentMcpTool[] {
  const out: AgentMcpTool[] = [];
  for (const choice of selection) {
    const server = servers.find((candidate) => candidate.slug === choice.server);
    if (!server) continue;
    const visible = visibleTools(server).map((tool) => tool.name);
    const names = choice.tools ?? visible;
    for (const tool of names)
      out.push({
        name: mcpToolName(server.slug, tool),
        server: server.slug,
        tool,
        missing: !visible.includes(tool),
      });
  }
  return out;
}

/**
 * Names to suggest for an agent's approvals: each of its MCP tools, and a
 * pattern for each of its servers.
 */
export function approvalSuggestions(
  selection: readonly AgentMcpServer[],
  servers: readonly McpServer[],
): string[] {
  const out = new Set<string>();
  for (const choice of selection) out.add(mcpServerPattern(choice.server));
  for (const tool of agentMcpTools(selection, servers)) if (!tool.missing) out.add(tool.name);
  return [...out];
}

// ── Import ──────────────────────────────────────────────────────────────────────────────────

export const IMPORT_SOURCE_NAMES: Record<McpImportSourceId, string> = {
  claude: 'Claude Desktop',
  cursor: 'Cursor',
  vscode: 'VS Code',
};

export const importSourceName = (id: string | null | undefined) =>
  (id && IMPORT_SOURCE_NAMES[id as McpImportSourceId]) || id || '';

/**
 * Where the backend looks (internal/mcp SourcePaths on macOS), shown when it
 * finds nothing: `GET /api/mcp/import` leaves out sources without servers.
 */
export const IMPORT_PLACES: { id: McpImportSourceId; path: string }[] = [
  { id: 'claude', path: '~/Library/Application Support/Claude/claude_desktop_config.json' },
  { id: 'cursor', path: '~/.cursor/mcp.json' },
  { id: 'vscode', path: '~/Library/Application Support/Code/User/mcp.json' },
  { id: 'vscode', path: '~/Library/Application Support/Code/User/settings.json' },
];

/** `{source: [names]}` from a set of "source\u0000name" keys, sources in order. */
export function importRequests(
  picked: ReadonlySet<string>,
): { source: McpImportSourceId; names: string[] }[] {
  const bySource = new Map<McpImportSourceId, string[]>();
  for (const key of picked) {
    const at = key.indexOf('\u0000');
    if (at < 0) continue;
    const source = key.slice(0, at) as McpImportSourceId;
    const names = bySource.get(source) ?? [];
    names.push(key.slice(at + 1));
    bySource.set(source, names);
  }
  return [...bySource].map(([source, names]) => ({ source, names }));
}

export const importKey = (source: string, name: string) => `${source}\u0000${name}`;
