import type {
  Agent,
  AgentApprovals,
  Approval,
  ApprovalProfile,
  ApprovalRule,
  ApprovalStatus,
  WorkspaceTool,
} from '~/api/types';

/**
 * Workspace tools and approvals (docs/api.md, "Workspace tools, approvals and
 * attachments (Phase 4)"): the presets the Tools tab offers, the patterns the
 * backend accepts, how long a request waits, and how a request reads in the
 * conversation. Pure, so the rules can be tested.
 */

export const WORKSPACE_TOOLS: readonly WorkspaceTool[] = ['read', 'write', 'edit', 'bash'];

export type PresetId = 'ask-first' | 'commands' | 'none';

export interface ApprovalPreset {
  id: PresetId;
  label: string;
  description: string;
  /** The workspace tools that ask first. */
  tools: readonly WorkspaceTool[];
}

export const APPROVAL_PRESETS: readonly ApprovalPreset[] = [
  {
    id: 'ask-first',
    label: 'Ask first',
    description: 'It asks before it runs a command or creates or changes a file.',
    tools: ['bash', 'write', 'edit'],
  },
  {
    id: 'commands',
    label: 'Ask for commands',
    description: 'It changes files in its workspace on its own, and asks before it runs a command.',
    tools: ['bash'],
  },
  {
    id: 'none',
    label: "Don't ask",
    description: 'It reads, changes files and runs commands without asking.',
    tools: [],
  },
];

/** The preset an agent gets when its tools are first turned on. */
export const DEFAULT_PRESET: PresetId = 'ask-first';

/** Whether a tool name matches a pattern: `*` is any characters (none included), the rest literal. */
export function matchesPattern(name: string, pattern: string): boolean {
  if (!pattern.includes('*')) return name === pattern;
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\-]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(name);
}

/** Whether a call of `tool` waits for the person under these approvals. */
export function needsApproval(tool: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPattern(tool, pattern));
}

const isWorkspaceTool = (entry: string): entry is WorkspaceTool =>
  (WORKSPACE_TOOLS as readonly string[]).includes(entry);

/** An entry that is about a workspace tool: one's name, or a pattern that matches one. */
const touchesWorkspace = (entry: string) =>
  isWorkspaceTool(entry) || WORKSPACE_TOOLS.some((tool) => matchesPattern(tool, entry));

/**
 * Which preset an approvals list is, judged on the workspace tools only:
 * other entries (MCP tools, `mcp__github__create_*`) are the advanced list and
 * leave the preset as it is. `custom`: the workspace tools ask in a way no
 * preset does (`read` asks, or a pattern such as `*` covers them).
 */
export function presetOf(tools: readonly string[]): PresetId | 'custom' {
  const workspace = tools.filter(touchesWorkspace);
  if (workspace.some((entry) => !isWorkspaceTool(entry))) return 'custom';
  const asked = new Set(workspace);
  const preset = APPROVAL_PRESETS.find(
    (candidate) =>
      candidate.tools.length === asked.size && candidate.tools.every((tool) => asked.has(tool)),
  );
  return preset?.id ?? 'custom';
}

/** The entries of an approvals list that are not about workspace tools (the advanced list). */
export function extraPatterns(tools: readonly string[]): string[] {
  return tools.filter((entry) => !touchesWorkspace(entry));
}

/** The list with a preset applied: its workspace tools, and every other entry kept. */
export function applyPreset(tools: readonly string[], preset: PresetId): string[] {
  const chosen = APPROVAL_PRESETS.find((candidate) => candidate.id === preset)?.tools ?? [];
  return dedupe([...chosen, ...extraPatterns(tools)]);
}

export function dedupe(list: readonly string[]): string[] {
  return [...new Set(list)];
}

/** Workspace tools in the order the API lists them, each once. */
export function normaliseTools(tools: readonly string[]): WorkspaceTool[] {
  return WORKSPACE_TOOLS.filter((tool) => tools.includes(tool));
}

export const MAX_APPROVAL_PATTERNS = 100;
const PATTERN = /^[A-Za-z0-9_.*-]{1,200}$/;

/** Why an approvals list would be refused (`invalid_approval_tools`), or null. */
export function approvalPatternsError(tools: readonly string[]): string | null {
  if (tools.length > MAX_APPROVAL_PATTERNS)
    return `At most ${MAX_APPROVAL_PATTERNS} tool names or patterns.`;
  const bad = tools.find((entry) => !PATTERN.test(entry));
  if (bad !== undefined)
    return `"${bad.length > 40 ? `${bad.slice(0, 39)}…` : bad}" isn't a tool name: use letters, digits, _ . - and * (up to 200 characters).`;
  return null;
}

// ── How long a request waits ────────────────────────────────────────────────────────────────

export const MIN_TIMEOUT_SECONDS = 60;
export const MAX_TIMEOUT_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_TIMEOUT_SECONDS = 24 * 60 * 60;

export type TimeoutChoice = '1h' | '1d' | '1w' | 'custom';

export const TIMEOUT_CHOICES: readonly {
  id: Exclude<TimeoutChoice, 'custom'>;
  label: string;
  seconds: number;
}[] = [
  { id: '1h', label: '1 hour', seconds: 60 * 60 },
  { id: '1d', label: '1 day', seconds: 24 * 60 * 60 },
  { id: '1w', label: '1 week', seconds: 7 * 24 * 60 * 60 },
];

export function timeoutChoiceOf(seconds: number): TimeoutChoice {
  return TIMEOUT_CHOICES.find((choice) => choice.seconds === seconds)?.id ?? 'custom';
}

/** Custom minutes as seconds, or null when outside 1 minute – 30 days or not a whole number. */
export function minutesToTimeout(text: string): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const seconds = Number(text) * 60;
  return seconds >= MIN_TIMEOUT_SECONDS && seconds <= MAX_TIMEOUT_SECONDS ? seconds : null;
}

/** "1 hour", "3 days", "90 minutes": a timeout as people say it. */
export function formatTimeout(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes % (60 * 24 * 7) === 0) return plural(minutes / (60 * 24 * 7), 'week');
  if (minutes % (60 * 24) === 0) return plural(minutes / (60 * 24), 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

/** The agent's settings as the Tools tab reads them, with the contract's defaults for an older backend. */
export function readToolSettings(agent: Pick<Agent, 'workspace' | 'approvals'>): {
  tools: WorkspaceTool[];
  approvals: AgentApprovals & {
    profile: ApprovalProfile;
    rules: ApprovalRule[];
    builtinRules: ApprovalRule[];
  };
} {
  return {
    tools: normaliseTools(agent.workspace?.tools ?? []),
    approvals: {
      // An agent without a profile (an older backend, or one made before profiles) keeps its tools list: custom.
      profile: agent.approvals?.profile ?? 'custom',
      tools: agent.approvals?.tools ?? [],
      rules: agent.approvals?.rules ?? [],
      builtinRules: agent.approvals?.builtinRules ?? [],
      timeoutSeconds: agent.approvals?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    },
  };
}

// ── Profiles and rules ──────────────────────────────────────────────────────────────────────

export interface ProfileOption {
  id: ApprovalProfile;
  label: string;
  description: string;
}

export const PROFILE_OPTIONS: readonly ProfileOption[] = [
  {
    id: 'careful',
    label: 'Careful',
    description:
      "Asks before anything that changes something: writing and editing files, running commands, scheduling, and MCP tools that aren't read-only.",
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description:
      'Asks before running commands (not when they run in the sandbox), and before MCP tools that delete, send or change things. Changes files in its workspace on its own.',
  },
  {
    id: 'trusting',
    label: 'Trusting',
    description: 'Asks for nothing, except the built-in rules below.',
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'You choose which tools ask, by name.',
  },
];

/** The profile new agents get. */
export const DEFAULT_PROFILE: ApprovalProfile = 'balanced';

/**
 * The workspace tools that run without asking under a profile, for the warning
 * on the Tools tab. Balanced asks for commands and leaves files to the agent
 * (as the recommended setting, it says nothing); trusting asks for nothing.
 */
export function unguardedTools(
  profile: ApprovalProfile,
  tools: readonly WorkspaceTool[],
  patterns: readonly string[],
): WorkspaceTool[] {
  if (profile === 'careful' || profile === 'balanced') return [];
  const changing = tools.filter((tool) => tool !== 'read');
  return profile === 'trusting'
    ? changing
    : changing.filter((tool) => !needsApproval(tool, patterns));
}

const ACTION_LABEL: Record<ApprovalRule['action'], string> = {
  allow: 'Allow',
  ask: 'Ask',
  deny: 'Deny',
};

export const actionLabel = (action: ApprovalRule['action']) => ACTION_LABEL[action];

/** What a rule matches: "bash", "bash · command: git status*". */
export function describeRule(rule: Pick<ApprovalRule, 'tool' | 'args'>): string {
  const args = Object.entries(rule.args ?? {}).map(([name, glob]) => `${name}: ${glob}`);
  return args.length === 0 ? rule.tool : `${rule.tool} · ${args.join(', ')}`;
}

/** Whether a shell command chains or nests commands (an allow rule would never match it). */
export function isCompoundCommand(command: string): boolean {
  const plain = command.trim().replace(/\d*>&\d+|\d*>>?\s*\/dev\/null/g, '');
  return /[;&|`\n\r<>]|\$\(/.test(plain);
}

/**
 * The rule "Approve and always allow this" adds for a call: for a shell
 * command its first word and subcommand (`git status --short` → `git status*`,
 * `git --version` → `git --version*`), for any other tool the tool alone. Null when no allow
 * rule could cover the call (a compound command, or an empty one).
 */
export function suggestRule(
  tool: string,
  args: unknown,
): { tool: string; args?: Record<string, string> } | null {
  if (tool !== 'bash') return { tool };
  const given = asRecord(args)?.command;
  const command = typeof given === 'string' ? given : null;
  if (command === null || isCompoundCommand(command)) return null;
  const [first, second] = command.trim().split(/\s+/);
  if (!first) return null;
  // A subcommand is a plain word (`status`, `run`). When the next word is an option (`git --version`, `ls -la`) it is
  // kept too, so one harmless call doesn't allow every `git` command.
  const sub =
    second && /^(?:[A-Za-z][A-Za-z0-9:_-]*|-[A-Za-z0-9-]+)$/.test(second) ? ` ${second}` : '';
  return { tool, args: { command: `${first}${sub} *` } };
}

/** A shell command remembered exactly; a literal star would be a glob, not exact. */
export function exactCommandRule(
  tool: string,
  args: unknown,
): { tool: string; args: Record<string, string> } | null {
  const command = commandOf(args)?.trim();
  return tool === 'bash' && command && !command.includes('*') && !isCompoundCommand(command)
    ? { tool, args: { command } }
    : null;
}

/** Whether the card offers "Approve and always allow this": not for what a built-in or an ask rule, or the agent's own code, asked. */
export function canAlwaysAllow(approval: { source?: string }): boolean {
  return (
    approval.source !== 'builtin' && approval.source !== 'rule' && approval.source !== 'author'
  );
}

// ── A request as the conversation shows it ──────────────────────────────────────────────────

/** A call's arguments, read for the person deciding: the command, the file, or the fields. */
export type ArgumentsView =
  | { kind: 'command'; command: string; cwd: string | null; timeout: number | null }
  | {
      kind: 'file';
      path: string;
      /** What changes, briefly: the start of the new content, or of the edit. */
      preview: string | null;
      /** "Content" for a write, "Change" for an edit. */
      previewLabel: string;
      /** The preview was cut short. */
      clipped: boolean;
    }
  | { kind: 'fields'; entries: [string, string][] }
  | { kind: 'json'; text: string }
  | { kind: 'none' };

const PREVIEW_LINES = 12;
const PREVIEW_CHARS = 1_200;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const firstString = (record: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
};

/** The start of a text: at most PREVIEW_LINES lines and PREVIEW_CHARS characters. */
export function clipPreview(text: string): { text: string; clipped: boolean } {
  let out = text;
  let clipped = false;
  const lines = out.split('\n');
  if (lines.length > PREVIEW_LINES) {
    out = lines.slice(0, PREVIEW_LINES).join('\n');
    clipped = true;
  }
  if (out.length > PREVIEW_CHARS) {
    out = out.slice(0, PREVIEW_CHARS);
    clipped = true;
  }
  return { text: out, clipped };
}

/** The command a call runs, when it is a shell call. */
export function commandOf(args: unknown): string | null {
  const record = asRecord(args);
  return record ? firstString(record, ['command', 'cmd', 'script']) : null;
}

/** The file a call acts on, when it names one. */
export function pathOf(args: unknown): string | null {
  const record = asRecord(args);
  return record ? firstString(record, ['path', 'file_path', 'filePath', 'file', 'filename']) : null;
}

/** An edit's change as lines: removed ones with "- ", added ones with "+ ". */
function editPreview(record: Record<string, unknown>): string | null {
  const edits = Array.isArray(record.edits)
    ? record.edits.map(asRecord).filter((edit): edit is Record<string, unknown> => edit !== null)
    : [record];
  const parts: string[] = [];
  for (const edit of edits) {
    const before = firstString(edit, ['oldText', 'old_text', 'old_string', 'oldString', 'search']);
    const after = firstString(edit, ['newText', 'new_text', 'new_string', 'newString', 'replace']);
    if (before === null && after === null) continue;
    if (before !== null) parts.push(...before.split('\n').map((line) => `- ${line}`));
    if (after !== null) parts.push(...after.split('\n').map((line) => `+ ${line}`));
  }
  if (parts.length === 0) return null;
  const more = edits.length > 1 ? `\n(${edits.length} changes)` : '';
  return parts.join('\n') + more;
}

/**
 * A call's (redacted) arguments as the approval card shows them: a shell
 * command as a command; a write or edit as its file and a short preview;
 * a few plain values as names and values; anything else as JSON.
 */
export function argumentsView(tool: string, args: unknown): ArgumentsView {
  const record = asRecord(args);
  if (args === undefined || args === null || (record && Object.keys(record).length === 0))
    return { kind: 'none' };
  const name = tool.toLowerCase();
  const command = commandOf(args);
  if (
    command !== null &&
    (name === 'bash' || /bash|shell|exec|command/.test(name) || !pathOf(args))
  ) {
    const cwd = record ? firstString(record, ['cwd', 'workdir', 'directory']) : null;
    const timeout = typeof record?.timeout === 'number' ? record.timeout : null;
    return { kind: 'command', command, cwd, timeout };
  }
  const path = pathOf(args);
  if (path !== null && record) {
    const isEdit = name === 'edit' || /edit|patch|replace/.test(name);
    const raw = isEdit
      ? editPreview(record)
      : firstString(record, ['content', 'text', 'contents', 'data']);
    const clipped = raw === null ? null : clipPreview(raw);
    return {
      kind: 'file',
      path,
      preview: clipped?.text ?? null,
      previewLabel: isEdit ? 'Change' : 'Content',
      clipped: clipped?.clipped ?? false,
    };
  }
  if (record) {
    const entries = Object.entries(record);
    const plain = entries.every(
      ([, value]) =>
        ['string', 'number', 'boolean'].includes(typeof value) && String(value).length <= 300,
    );
    if (plain && entries.length <= 8)
      return { kind: 'fields', entries: entries.map(([key, value]) => [key, String(value)]) };
  }
  let text: string;
  try {
    text = JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    text = String(args);
  }
  return { kind: 'json', text: clipPreview(text).text };
}

/** One line for a request: "bash · ls -la", "write · notes/todo.md". */
export function approvalHeadline(tool: string, args: unknown): string {
  const view = argumentsView(tool, args);
  const target =
    view.kind === 'command'
      ? view.command.replace(/\s+/g, ' ').trim()
      : view.kind === 'file'
        ? view.path
        : null;
  if (!target) return tool;
  return `${tool} · ${target.length > 80 ? `${target.slice(0, 79)}…` : target}`;
}

/** How a request ended (or that it waits), for its step. */
export function approvalOutcome(approval: {
  status: ApprovalStatus;
  reason?: string | null;
}): string {
  switch (approval.status) {
    case 'pending':
      return 'Waiting for approval';
    case 'approved':
      return 'Approved';
    case 'denied':
      return approval.reason?.trim() ? `Denied: ${approval.reason.trim()}` : 'Denied';
    case 'timed_out':
      return 'Timed out';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** "in 59 minutes", "in 2 days", "now": when a request stops waiting. */
export function expiresIn(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 30_000) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `in ${days} days`;
}

// ── The pending list (`['approvals']`) ───────────────────────────────────────────────────────

/**
 * The pending list with one request's change applied: a pending one added or
 * updated, a decided one removed. Newest first, as the API lists them.
 */
export function applyApprovalEvent(
  list: Approval[] | undefined,
  approval: Approval,
): Approval[] | undefined {
  if (!list) return list;
  const others = list.filter(
    (candidate) => !(candidate.id === approval.id && candidate.agentId === approval.agentId),
  );
  if (approval.status !== 'pending') return others.length === list.length ? list : others;
  return [approval, ...others].sort((a, b) => b.requestedAt - a.requestedAt);
}

/** Pending requests by conversation key (`agentId/threadId`); those without a thread are left out. */
export function approvalsByThread(list: readonly Approval[] | undefined): Map<string, Approval[]> {
  const out = new Map<string, Approval[]>();
  for (const approval of list ?? []) {
    if (approval.status !== 'pending' || !approval.threadId) continue;
    const key = `${approval.agentId}/${approval.threadId}`;
    out.set(key, [...(out.get(key) ?? []), approval]);
  }
  return out;
}
