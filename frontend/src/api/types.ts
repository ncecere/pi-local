/**
 * The shapes of Pi Local's UI API (docs/api.md). Hand-written: Agent and
 * AgentThread are the Go backend's; ChatView and ChatMessage are the runtime's
 * (runtime/src/lib/view.ts), passed through unchanged.
 */

/** A local agent: one folder, one runtime process while it is awake. */
export interface Agent {
  /** `ag_` + 16 lowercase base32 characters. */
  id: string;
  /** 1–60 characters. */
  name: string;
  description: string;
  /** The agent's own instructions; empty: the kind's default prompt. */
  instructions: string;
  /** The chat UI's grouping: every local agent is the person's own. */
  kind: 'personal';
  /**
   * What it is (the runtime kind, also its catalog template ID). Triage is retired: no
   * longer offered for new agents, but agents made with it still run.
   */
  agentKind: 'assistant' | 'triage' | 'researcher' | 'coding';
  /** Its runtime process. */
  status: AgentStatus;
  /** `status` is "awake". */
  running: boolean;
  /** Why it last failed to start (status "error"). */
  lastError?: string | null;
  model: { id: string; name: string; provider: string } | null;
  enabled: boolean;
  /** ISO 8601. */
  lastUsedAt: string | null;
  /** Bumped on every config change. */
  revision: number;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
  /**
   * The kind's settings (triage: listTools, readTools, writeTools, approveWrites;
   * researcher: backgroundSubagents, maxPlanSteps); {} for none (assistant, coding). Phase 3.
   */
  kindSettings: Record<string, unknown>;
  /** Agent IDs this agent may ask (ask_agent), besides what its teams allow. */
  canCall: string[];
  /** Everyone it may ask, all rules applied. */
  callable: CallableAgent[];
  /** Its folder on disk. */
  dir: string;
  /** The newest runtime that wrote its storage. */
  piDurableVersion: string | null;
  /**
   * Its file tools, confined to its workspace folder (bash is confined only when
   * its sandbox is on), and that folder. Phase 4; absent from an older backend
   * (read as no tools).
   */
  workspace?: AgentWorkspace;
  /** Which tools ask first, and how long a request waits. Phase 4. */
  approvals?: AgentApprovals;
  /** Tool calls waiting for the person now. Phase 4. */
  pendingApprovals?: number;
  /**
   * The MCP servers it uses, each with all its model-visible tools (`tools: null`)
   * or the ones picked. Phase 5; absent from an older backend (read as none).
   */
  mcp?: AgentMcpServer[];
  /**
   * Whether it may set its own schedules (its `schedule`, `list_schedules`, `cancel_schedule` tools).
   * Phase 7; absent from an older backend (read as off).
   */
  schedules?: { agentMade: boolean };
  /** Explicit opt-in: create agents and update only agents it made; always human-approved. */
  builder?: boolean;
  /**
   * Its web tools: search (through the search service in Settings → Models) and
   * reading pages. Absent from an older backend (read as both off).
   */
  web?: WebTools;
  /**
   * Secret handling: with `scrubSecrets` (the default) credentials in what its tools return become
   * `[redacted secret]` before the model sees them and before they are saved. Absent from an older
   * backend (read as on).
   */
  security?: AgentSecurity;
  /**
   * Its memory: on unless `off`; it sees the person's basics and preferences, plus the categories in `share`.
   * Absent from an older backend (read as on, sharing nothing more).
   */
  memory?: AgentMemory;
  /** Its monthly budget; null (or absent from an older backend): none. */
  budget?: AgentBudget | null;
}

/** A monthly spending limit (an agent's `budget`, or the app's in Settings → Usage), in US dollars. */
export interface AgentBudget {
  monthlyUsd: number;
  /** "stop": new messages, schedule runs and asks are refused at the limit; "warn": only said. */
  onExceed: 'stop' | 'warn';
}

/** An agent's memory settings (its agent.yaml `memory`). */
export interface AgentMemory {
  off: boolean;
  /** Shareable categories it sees besides the basics and preferences. */
  share: string[];
}

// ── Memory (docs/api.md, Memory) ────────────────────────────────────────────────────────────

/** The About me card: what every agent knows about the person. All strings, "" when unset. */
export interface Basics {
  name: string;
  role: string;
  organization: string;
  timezone: string;
  language: string;
  addressAs: string;
  answerStyle: string;
  signOff: string;
}

/** `GET /api/you`. */
export interface YouInfo {
  basics: Basics;
  /** False: `basics` are defaults from this computer, not saved yet. */
  saved: boolean;
  /** Every category, preferences first. */
  categories: string[];
  /** The categories an agent sees only when shared with it (all but preferences). */
  shareable: string[];
}

export type FactTrust = 'said' | 'inferred' | 'external';
export type FactStatus = 'active' | 'suggested';

/** Something about the person: known (`active`) or a suggestion waiting for them. */
export interface Fact {
  /** "um_…". */
  id: string;
  category: string;
  text: string;
  trust: FactTrust;
  status: FactStatus;
  pinned: boolean;
  /** The agent that saved it; null: the person added it. */
  sourceAgent: string | null;
  /** The conversation it was saved in. */
  sourceThread: string | null;
  /** Unix ms. */
  createdAt: number;
  updatedAt: number;
}

/** Something an agent learned about its own job. */
export interface MemoryNote {
  /** "an_…". */
  id: string;
  text: string;
  /** The conversation it was saved in. */
  thread?: string | null;
  /** Unix ms. */
  createdAt: number;
  updatedAt: number;
}

/** `GET /api/events` `memory` event: `agentId` "" is the person's memory, otherwise that agent's notes. */
export interface MemoryEvent {
  agentId: string;
}

// ── Fast judgments (docs/api.md, Fast judgments) ────────────────────────────────────────────

export interface JudgmentSettings {
  enabled: boolean;
  url: string;
  model: string;
  hasKey: boolean;
  uses: Record<string, boolean>;
  /** 0.5–0.99. */
  threshold: number;
}

/** `GET /api/settings/judgments`. */
export interface JudgmentsInfo {
  settings: JudgmentSettings;
  /** Every use, in order. */
  uses: string[];
  defaultUrl: string;
  defaultModel: string;
}

/** `POST /api/settings/judgments/test`. */
export interface JudgmentTest {
  model: string;
  answer: { type: string; noul?: number; choice?: string; confidence?: number } | null;
}

/** `POST /api/route`: the agent for a message sent without one. */
export interface RouteResult {
  agentId: string;
  /** Confident enough to send it there; otherwise ask, offering `alternatives`. */
  decided: boolean;
  confidence: number;
  alternatives: { agentId: string; probability: number }[];
  model: string;
}

/** An agent's secret handling (`PATCH /api/agents/{id}` takes `security: {scrubSecrets}`). */
export interface AgentSecurity {
  scrubSecrets: boolean;
}

/** An agent's web tools (read-only: they change nothing). */
export interface WebTools {
  search: boolean;
  fetch: boolean;
}

/** A template's group in the New agent gallery. */
export type TemplateCategory = 'everyday' | 'work' | 'life' | 'meta' | 'yours';

/**
 * A starting point for a new agent (`GET /api/templates`, the catalog's
 * `templates`): its kind, instructions, tools and maybe a first schedule.
 */
export interface AgentTemplate {
  builder?: boolean;
  /** 1–48 of [a-z0-9-]. */
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  /** A lucide icon name ("sunrise", "pen-line"); "" or unknown: a default icon. */
  icon: string;
  /** The runtime kind its agents get. */
  kind: string;
  instructions: string;
  workspace?: { tools: string[] };
  approvals?: { profile?: ApprovalProfile; tools: string[]; timeoutSeconds: number };
  web?: WebTools;
  /** Whether its agents may set their own schedules. */
  schedules?: { agentMade: boolean };
  /** A first schedule made with the agent. */
  schedule?: { name: string; cron: string; message: string; threadMode?: string };
  /** MCP server IDs it works with, used when this computer has them. */
  mcp?: string[];
  /** What makes it work well ("web-search"). */
  needs?: string[];
  /** Shipped with the app: can't be deleted. */
  builtin: boolean;
}

/** A web search service people can choose (Settings → Models → Web search). */
export interface WebSearchProvider {
  id: 'brave' | 'tavily' | 'serpapi' | 'searxng';
  name: string;
  needsKey: boolean;
  needsUrl: boolean;
  signupUrl: string;
  note: string;
}

/** `GET /api/settings/web`: the search service agents use; the key is never returned. */
export interface WebSettings {
  /** "": web search is off. */
  provider: '' | WebSearchProvider['id'];
  url: string;
  hasKey: boolean;
  providers: WebSearchProvider[];
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** One MCP server an agent uses: `tools` null is all its model-visible tools. */
export interface AgentMcpServer {
  /** The server's slug. */
  server: string;
  tools: string[] | null;
}

/** An agent's workspace tools (`read`, `write`, `edit`, `bash`); none: no file tools. */
export type WorkspaceTool = 'read' | 'write' | 'edit' | 'bash';

export interface AgentWorkspace {
  tools: WorkspaceTool[];
  /** A project folder (absolute) the tools work in; "": the agent's own private workspace. */
  folder?: string;
  /** The folder it works in now: the project folder, or `…/agents/<id>/workspace`. Read-only. */
  dir?: string;
  /** Its `bash` runs in the OS sandbox (agents made before the sandbox: false). Absent from an older backend. */
  sandbox?: boolean;
  /** Whether sandboxed commands may use the network (default true). Absent from an older backend. */
  network?: boolean;
  /** Whether this computer has a sandbox (macOS for now). Read-only. */
  sandboxAvailable?: boolean;
}

/** What a create or update sends as `workspace`: `tools` is required (left out, it becomes none). */
export interface AgentWorkspaceInput {
  tools: WorkspaceTool[];
  folder?: string;
  /** Left out: the agent keeps what it has (a new agent: on where there is a sandbox and it has bash). */
  sandbox?: boolean;
  /** Left out: the agent keeps what it has. */
  network?: boolean;
}

/** How much an agent asks: see docs/api.md, "Approval rules and profiles". An agent with none is `custom`. */
export type ApprovalProfile = 'careful' | 'balanced' | 'trusting' | 'custom';

/** A rule: the first that matches a call decides. `args` are globs (`*`: any characters) that must all match. */
export interface ApprovalRule {
  /** "r_…" (built in: "builtin-…"). */
  id: string;
  /** A tool name, or a pattern with `*`. */
  tool: string;
  args?: Record<string, string>;
  action: 'allow' | 'ask' | 'deny';
}

export interface AgentApprovals {
  /** Tool names or patterns with `*` (at most 100 of 1–200 of [A-Za-z0-9_.*-]); read under `custom` only. */
  tools: string[];
  /** How long a request waits before it is denied: 60 s – 30 days. */
  timeoutSeconds: number;
  /** v0.3. Left out of a save: the agent keeps its own. */
  profile?: ApprovalProfile;
  /** v0.3, read-only here: added and removed through the approval-rules routes. */
  rules?: ApprovalRule[];
  /** v0.3, read-only: they ask under every profile and can't be removed. */
  builtinRules?: ApprovalRule[];
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'timed_out' | 'cancelled';

/** A tool call waiting for (or decided by) the person: `GET /api/approvals`. */
export interface Approval {
  /** "ap_…", unique within its agent. */
  id: string;
  agentId: string;
  agentName: string;
  threadId: string | null;
  tool: string;
  /** A redacted, bounded view of the call's arguments. */
  arguments: unknown;
  /** Why it asks, when the agent's code says. */
  summary: string | null;
  status: ApprovalStatus;
  /** Unix ms. */
  requestedAt: number;
  /** Unix ms. */
  expiresAt: number;
  decidedAt: number | null;
  /** Given with a decision; the model reads it on denial. */
  reason: string | null;
}

/** `GET /api/events` `approval` event. */
export interface ApprovalEvent {
  agentId: string;
  approval: Approval;
}

export type ElicitationState = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';

/** One field of an elicitation's form: a primitive, as MCP's `requestedSchema` allows. */
export interface ElicitationField {
  type: 'string' | 'number' | 'integer' | 'boolean';
  title?: string;
  description?: string;
  default?: string | number | boolean;
  /** A string chosen from these. */
  enum?: string[];
  /** What each `enum` value is called, in the same order. */
  enumNames?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: 'email' | 'uri' | 'date' | 'date-time';
}

export interface ElicitationSchema {
  type: 'object';
  properties: Record<string, ElicitationField>;
  required?: string[];
}

/**
 * An MCP server asking the person something during a tool call
 * (`elicitation/create`, form mode): `GET /api/elicitations`, and the
 * `elicitation` live event. The call waits until it is answered or expires.
 */
export interface McpElicitation {
  /** "el_…". */
  id: string;
  agentId: string;
  agentName: string;
  /** The conversation whose tool call asks; null when not known. */
  threadId: string | null;
  /** The MCP server's slug, e.g. "m365". */
  server: string;
  serverName: string;
  /** The MCP tool being called (not prefixed), when known. */
  tool: string | null;
  /** The server's own words, plain text: shown as text, never as HTML or markdown. */
  message: string;
  requestedSchema: ElicitationSchema;
  state: ElicitationState;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms. */
  expiresAt: number;
}

export type ElicitationAction = 'accept' | 'decline' | 'cancel';
export type ElicitationContent = Record<string, string | number | boolean>;

/** `POST /api/elicitations/{id}`'s body: `content` with `accept` only. */
export interface ElicitationAnswer {
  action: ElicitationAction;
  content?: ElicitationContent;
}

/** `POST /api/agents/{a}/attachments`: the file as saved in the workspace. */
export interface Attachment {
  /** Relative to the workspace: `attachments/<YYYY-MM-DD>/<name>`. */
  path: string;
  name: string;
  size: number;
  mediaType: string;
}

/** One agent another may ask, and why: in its `canCall`, or through a team. */
export interface CallableAgent {
  id: string;
  name: string;
  via: 'direct' | 'team';
}

export type AgentStatus = 'asleep' | 'starting' | 'awake' | 'error';

/** A conversation as the app's own index lists it (never wakes the agent). */
export interface AgentThread {
  threadId: string;
  /** The first line of the first message (≤ 60 chars) unless renamed. */
  title: string;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms. */
  updatedAt: number;
  busy: boolean;
  lastReplyAt?: number | null;
  lastError?: string | null;
  /** Compatibility with the platform's shape. */
  visibility: 'private' | 'shared';
  createdBy?: null;
  participants: unknown[];
  /** The agent (and its conversation) that asked in this thread; null when a person started it. */
  calledBy?: CalledBy | null;
  /** The model the person chose for this conversation; "" or left out: the agent's own. */
  modelId?: string;
  /** The thinking level the person chose; "" or left out: the model's default (off). */
  thinking?: string;
}

/** Who asked in a conversation: another agent, from one of its own conversations. */
export interface CalledBy {
  agentId: string;
  name: string;
  threadId: string;
}

/** `GET /api/events` `thread` event. */
export interface AgentThreadEvent {
  agentId: string;
  threadId: string;
  deleted: boolean;
  thread?: AgentThread | null;
}

/** `GET /api/events` `notification` event: an agent's `notify_person`. */
export interface NotificationEvent {
  agentId: string;
  agentName: string;
  /** The conversation the agent was in; "" when none. */
  threadId?: string | null;
  title: string;
  message: string;
}

/** `GET /api/events` `agent` event. */
export interface AgentEvent {
  agentId: string;
  deleted: boolean;
  agent?: Agent | null;
}

// ── Agent manager and teams (docs/api.md, Phase 3) ───────────────────────────────────────────

/** A group of agents people chat with through its lead. */
export interface Team {
  /** "tm_…". */
  id: string;
  /** 1–60 characters. */
  name: string;
  /** ≤ 500 characters. */
  description: string;
  /** The agent people chat with for the team. */
  leadId: string;
  /** Other agents (not the lead), 1–20. */
  memberIds: string[];
  /** Members may ask each other and the lead. */
  membersTalk: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/events` `team` event. */
export interface TeamEvent {
  teamId: string;
  deleted: boolean;
  team?: Team | null;
}

/** `GET /api/about`. */
export interface About {
  version: string;
  dataDir: string;
  runtime: {
    node: string;
    nodeVersion: string;
    piDurableVersion: string;
    contractVersion: string | number;
  };
  agents: number;
}

/** `GET /api/agents/{id}/logs`. */
export interface AgentLogs {
  path: string;
  lines: string[];
}

/** `POST /api/reveal`: which folder to open in Finder. */
export type RevealTarget =
  | { target: 'data' }
  | { target: 'agent'; agentId: string }
  | { target: 'workspace'; agentId: string };

// ── Models and providers (docs/api.md, Phase 2) ─────────────────────────────────────────────

export type ProviderKindId =
  | 'openai'
  | 'anthropic'
  | 'openai-compatible'
  | 'openai-responses'
  | 'anthropic-compatible';

/** An API a provider can speak. */
export interface ProviderKind {
  id: ProviderKindId;
  name: string;
  api: string;
  defaultBaseUrl: string | null;
}

/** A starting point for a new provider: OpenAI, Ollama, LM Studio, … */
export interface ProviderPreset {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  needsKey: boolean;
  note: string;
  /** Where to get a key, or the software for a local server. */
  signupUrl?: string;
  /** Runs on this computer (Ollama, LM Studio): `GET /api/providers/detect` looks for it. */
  local?: boolean;
}

/** A model server running on this computer (`GET /api/providers/detect`). */
export interface DetectedServer {
  /** The local preset it matches: "ollama", "lm-studio". */
  preset: string;
  name: string;
  baseUrl: string;
  /** Its chat models. */
  models: { modelId: string; name: string }[];
  /** The provider already using it, or null when it isn't set up. */
  provider: string | null;
}

/** `POST /api/providers/setup`. */
export interface ProviderSetupResult {
  provider: Provider;
  /** Everything it offers, `added` marked. */
  available: DiscoveredModel[];
  defaultModelId: string;
}

/** An account at a model service. Its key and header values are never returned. */
export interface Provider {
  /** A slug: 1–32 of [a-z0-9-]. */
  id: string;
  /** 1–60 characters. */
  name: string;
  kind: ProviderKindId;
  baseUrl: string;
  /** A key is stored (in the OS keychain). */
  hasKey: boolean;
  /** Extra request headers; their values are secret. */
  headerNames: string[];
  enabled: boolean;
  models: Model[];
  createdAt: string;
  updatedAt: string;
}

/** One of a provider's models that agents may use. */
export interface Model {
  /** "<provider>/<modelId>". */
  id: string;
  provider: string;
  /** May itself contain slashes ("anthropic/claude-sonnet-4"). */
  modelId: string;
  name: string;
  /** Tokens. */
  contextWindow: number;
  /** Output tokens. */
  maxTokens: number;
  reasoning: boolean;
  images: boolean;
  /** USD per million tokens; null: unpriced. */
  inputPrice: number | null;
  outputPrice: number | null;
  /** USD per million cached tokens; null: counted at the input price. Absent from an older backend. */
  cacheReadPrice?: number | null;
  cacheWritePrice?: number | null;
  /** Where the prices came from: the app's list prices, or typed by the person; null: unpriced. */
  priceSource?: 'list' | 'you' | null;
  /** The app's price list has a price for this model. */
  hasListPrice?: boolean;
  enabled: boolean;
  /** Agents on this model. */
  usedBy: number;
}

/** `GET /api/providers`. */
export interface ProvidersResponse {
  kinds: ProviderKind[];
  presets: ProviderPreset[];
  providers: Provider[];
  defaultModelId: string | null;
}

/** A model a provider's API lists (`POST /api/providers/{p}/discover`). */
export interface DiscoveredModel {
  modelId: string;
  name: string;
  contextWindow: number | null;
  /** Already one of the provider's models. */
  added: boolean;
}

/** A model as the agent catalog lists it: every enabled one, and the demo model. */
export interface CatalogModel {
  id: string;
  name: string;
  provider?: string;
  providerName?: string;
  /** The model can think before it answers: a thinking level applies. */
  reasoning?: boolean;
  enabled?: boolean;
}

/** `GET /api/settings/chat` (and `PUT`). */
export interface ChatSettings {
  modelPerConversation: boolean;
  thinkingLevels: string[];
}

/** What a conversation's model choice says: `modelId` "" is the agent's own; `thinking` "" the model's default (off). */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** `409 in_use`'s `details.agents`. */
export interface AgentRef {
  id: string;
  name: string;
}

// ── MCP servers (docs/api.md, Phase 5) ──────────────────────────────────────────────────────

export type McpTransport = 'stdio' | 'http';

/** A tool an MCP server offers, as its last successful test listed it. */
export interface McpTool {
  name: string;
  title: string | null;
  description: string | null;
  /** False: the server hides it from the model (an app-only tool); agents don't get it. */
  modelVisible: boolean;
}

/**
 * An MCP server in the app's catalog. Env and header values and OAuth tokens
 * are kept in the OS keychain and never returned.
 */
export interface McpServer {
  /** 1–32 of [a-z0-9_], no leading or trailing _: the tool prefix (`mcp__<slug>__<tool>`). */
  slug: string;
  /** 1–60 characters. */
  name: string;
  description: string;
  transport: McpTransport;
  /** stdio: the program to start. */
  command: string | null;
  /** stdio; may use ${workspace} and ${agentDir}. */
  args: string[];
  /** stdio; null: ${workspace}. */
  cwd: string | null;
  /**
   * stdio: the arguments of its own sign-in command (`command` with these, its env and cwd),
   * such as `["login"]`; empty: none. No ${workspace} or ${agentDir}: it runs once, not per agent.
   */
  loginArgs: string[];
  /** stdio: environment variables; their values are secret. */
  envNames: string[];
  /** http: the Streamable HTTP endpoint. */
  url: string | null;
  /** http: request headers; their values are secret. */
  headerNames: string[];
  /** http: sign in with OAuth. */
  oauth: boolean;
  /** oauth: tokens are stored. */
  signedIn: boolean;
  enabled: boolean;
  /** From the last successful test. */
  tools: McpTool[];
  /** Unix ms. */
  testedAt: number | null;
  /** The last test's error (with stderr's tail for stdio). */
  lastError: string | null;
  usedBy: AgentRef[];
  /** "claude", "cursor", "vscode". */
  importedFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A stdio server's own sign-in command, running or the last one
 * (`GET /api/mcp/servers/{slug}/login`, and the `mcp-login` live event).
 */
export interface McpLoginStatus {
  slug: string;
  /** idle: it never ran (since the app started). */
  state: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  /** stdout and stderr together, ANSI codes stripped: the last 16 KiB. */
  output: string;
  exitCode: number | null;
  /** Unix ms. */
  startedAt: number | null;
  /** Unix ms. */
  finishedAt: number | null;
}

/** `GET /api/events` `mcp` event. */
export interface McpEvent {
  slug: string;
  deleted: boolean;
  server?: McpServer | null;
}

export type McpImportSourceId = 'claude' | 'cursor' | 'vscode';

/** A server found in another app's config (`GET /api/mcp/import`). */
export interface McpImportServer {
  name: string;
  transport: McpTransport;
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  /** stdio: its environment variables' names; http: its headers' names. */
  envNames: string[];
  /** A server with that slug is already here. */
  exists: boolean;
  /** Why it can't be imported (the old HTTP+SSE transport, say); absent when it can. */
  unsupported?: string;
}

export interface McpImportSource {
  id: McpImportSourceId;
  /** The config file read. */
  path: string;
  servers: McpImportServer[];
}

/** `GET /api/mcp/import`. */
export interface McpImportList {
  sources: McpImportSource[];
  /** Every config file the backend looked at. */
  searched?: string[];
}

/** `POST /api/mcp/import`. */
export interface McpImportResult {
  servers: McpServer[];
  skipped: { name: string; reason: string }[];
}

// ── Usage (docs/api.md, Usage) ───────────────────────────────────────────────────────────────

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Requests to unpriced models are not in it. */
  costUsd: number;
  unpricedRequests: number;
}

/** `GET /api/me/usage?days=` or `?month=`, optionally `&agent=` and `&model=`. Dates are YYYY-MM-DD, local time. */
export interface UsageReport {
  from: string;
  to: string;
  days: number;
  /** "YYYY-MM" for a month report. */
  month?: string;
  total: UsageTotals;
  /** Deleted agents keep their last name. */
  agents: (UsageTotals & { agentId: string; name: string })[];
  models: (UsageTotals & { modelId: string; name: string })[];
  /** Every day of the range (a month: the whole month), zeros included. */
  byDay: (UsageTotals & { day: string })[];
  /** What the filters offer: everything with usage in the period, whatever is filtered. Absent from an older backend. */
  options?: {
    agents: { agentId: string; name: string }[];
    models: { modelId: string; name: string }[];
  };
  /** The app's budget, and the filtered agent's, for the month shown. Null when none applies. */
  budget?: { app: BudgetStatus | null; agent: BudgetStatus | null } | null;
}

/** One budget and how much of it is used this month (`GET /api/budgets`). */
export interface BudgetStatus {
  scope: 'app' | 'agent';
  agentId?: string;
  /** The agent's name, or "Pi Local". */
  name: string;
  /** "YYYY-MM". */
  month: string;
  /** "October". */
  monthName: string;
  monthlyUsd: number;
  onExceed: 'stop' | 'warn';
  spentUsd: number;
  /** Requests to unpriced models this month: not in `spentUsd`. */
  unpricedRequests: number;
  percent: number;
  state: 'ok' | 'near' | 'over';
  /** The budget says stop and is used up: new work is refused. */
  blocked: boolean;
}

/** `GET /api/budgets`. */
export interface BudgetOverview {
  app: BudgetStatus | null;
  agents: BudgetStatus[];
}

/** `GET /api/events` `budget` event: level 80 or 100, or 0 when a budget was changed (read again). */
export interface BudgetEvent {
  level: 0 | 80 | 100;
  message: string;
  status: Partial<BudgetStatus>;
}

// ── Always on: schedules, search, the desktop (docs/api.md, Phase 7) ────────────────────────

export type ScheduleRunStatus = 'running' | 'done' | 'failed';

/** One time a schedule fired: the conversation it ran in and how it went. */
export interface ScheduleRun {
  id: string;
  scheduleId: string;
  threadId: string;
  /** Unix ms. */
  firedAt: number;
  status: ScheduleRunStatus;
  error: string | null;
  /** Unix ms. */
  finishedAt: number | null;
}

/** A message sent to an agent at set times: once (`at`) or recurring (`cron` in `timezone`). */
export interface Schedule {
  id: string;
  agentId: string;
  agentName: string;
  name: string;
  once: boolean;
  /** Unix ms (once). */
  at: number | null;
  /** Five fields, or @daily/@weekly… (recurring). */
  cron: string | null;
  /** IANA. */
  timezone: string;
  message: string;
  /** `new`: a conversation of its own each run; `this`: always `threadId`. */
  threadMode: 'new' | 'this';
  threadId: string | null;
  /** Where an agent made it. */
  originThreadId: string | null;
  madeBy: 'user' | 'agent';
  /** A fire missed while the app was quit: run once at the next start, or skipped. */
  missedPolicy: 'skip' | 'run_once';
  paused: boolean;
  /** Why it paused itself (5 failed runs in a row); null when paused by hand or running. */
  pausedReason: string | null;
  /** Unix ms; null: a reminder that fired. */
  nextFireAt: number | null;
  lastFireAt: number | null;
  lastRun: ScheduleRun | null;
  createdAt: number;
}

/** `POST /api/agents/{a}/schedules` and `PATCH /api/schedules/{id}`. */
export interface ScheduleInput {
  name?: string;
  /** ISO 8601; without an offset it is in `timezone`. */
  at?: string;
  cron?: string;
  timezone?: string;
  message?: string;
  threadMode?: 'new' | 'this';
  threadId?: string;
  missedPolicy?: 'skip' | 'run_once';
  paused?: boolean;
  /** `PATCH` only: moves the schedule to another agent. Its runs then start new conversations there. */
  agentId?: string;
}

/** `GET /api/events` `schedule` event. */
export interface ScheduleEvent {
  scheduleId: string;
  deleted: boolean;
  schedule?: Schedule | null;
}

/** `GET /api/events` `schedule_run` event: a run ended. */
export interface ScheduleRunEvent {
  scheduleId: string;
  agentId: string;
  name: string;
  run: ScheduleRun;
}

/** One conversation whose messages match (`GET /api/search?q=`). */
export interface SearchResult {
  agentId: string;
  threadId: string;
  /** A line around the match; the matched words sit between U+0001 and U+0002. */
  snippet: string;
  indexedAt: string;
}

/** A release on GitHub. */
export interface UpdateRelease {
  version: string;
  /** Markdown release notes. */
  notes: string;
  /** The release page. */
  url: string;
  /** ISO 8601. */
  published: string;
}

export type UpdateStage =
  | 'downloading'
  | 'verifying'
  | 'backing-up'
  | 'installing'
  | 'restarting'
  | 'failed';

/** `GET /api/update` (and the `update` event): the app's version, the latest release, an install in progress. */
export interface UpdateStatus {
  /** "0.1.0", or a development build like "6dc49f2-dirty". */
  current: string;
  latest: UpdateRelease | null;
  /** `latest` is newer than `current`. */
  available: boolean;
  /** Unix ms of the last check. */
  checkedAt: number | null;
  /** The last check's or install's error ("no releases yet"). */
  error: string | null;
  /** False in a development build, the headless server, or when `installBlocked`: link to the release instead. */
  canInstall: boolean;
  /** Why this copy can't update itself where it is (run from the disk image, or a quarantined copy); null when it can. */
  installBlocked?: string | null;
  autoCheck: boolean;
  stage: UpdateStage | null;
}

/** `POST /api/choose-folder`: the folder picked, or the dialog was cancelled. */
export type ChosenFolder =
  | { path: string; cancelled?: undefined }
  | { cancelled: true; path?: undefined };

/** `GET /api/settings/desktop`. */
export interface DesktopSettings {
  /** False in a browser (the headless server): there is nothing to set. */
  available: boolean;
  launchAtLogin: boolean;
}

// ── The runtime's chat view (runtime/src/lib/view.ts) ─────────────────────────────────────────

/**
 * Who sent a user message: a person, a service account, a trigger (an unattended
 * run: a schedule or webhook) or another agent asking for help.
 */
export type Author = {
  kind: 'user' | 'service_account' | 'trigger' | 'agent';
  id: string;
  name: string;
  via?: string;
};

/** The chat view: transcript plus the reply in progress. */
export type ChatView = {
  busy: boolean;
  messages: ChatMessage[];
  /** The assistant reply being generated, if any. */
  partial?: ChatPartial;
  /** Tool calls of the current round. */
  tools: ChatTool[];
  /** Paged reads only: pass it as `before` for the earlier messages. */
  earlierCursor?: string;
  /** Exposed documents that exist in this thread, by kind, with each one's revision. */
  documents?: Record<string, ChatDocumentRef>;
  /** Tool calls waiting for approval. Absent when there are none. */
  approvals?: ChatApproval[];
};

export type ChatDocumentRef = { revision: string };

/** `GET /api/agents/{a}/threads/{t}/documents/{kind}`: an exposed document's current value. */
export type ThreadDocument = { kind: string; version: number; revision: string; value: unknown };

export type ChatPartial = { text: string; thinking: string };

/** A tool's `details` (pi-durable's channel for UIs), bounded. */
export type ChatDetails = { details?: unknown; detailsOmitted?: true };

/** A tool call of the current round. */
export type ChatTool = {
  callId: string;
  name: string;
  status: string;
  output?: string;
} & ChatDetails;

export type ChatToolCall = {
  id: string;
  name: string;
  arguments: unknown;
  startedAt?: number;
  endedAt?: number;
  approval?: ChatApproval;
};

/** A request to approve a tool call: pending, or how it was decided. */
export type ChatApproval = {
  id: string;
  callId: string;
  tool: string;
  status: ApprovalStatus;
  requestedAt: number;
  expiresAt?: number;
  summary?: string;
  /** What made it ask: `builtin` or `rule` (approval rules), `profile`, `tools`, `judge` (fast judgments), `author`. */
  source?: string;
  requestedFor?: Author;
  decidedAt?: number;
  decidedBy?: { kind: 'user' | 'service_account' | 'system'; id?: string; name: string };
  reason?: string;
  arguments?: unknown;
};

export type ChatUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type ChatUserMessage = {
  id: string;
  role: 'user';
  text: string;
  author?: Author;
  at?: number;
  /** The request ID it was sent with: a client matches what it sent by it (never by text). */
  requestId?: string;
  /** The files sent with it (v0.2); `text` is then the person's words alone. Absent before v0.2: see lib/attachments.ts. */
  attachments?: Attachment[];
};

export type ChatAssistantMessage = {
  id: string;
  role: 'assistant';
  text: string;
  thinking?: string;
  toolCalls?: ChatToolCall[];
  /** "Interrupted" when `stopReason` is "aborted"; the model's error when it is "error". */
  error?: string;
  at?: number;
  model?: { provider: string; id: string };
  usage?: ChatUsage;
  stopReason?: string;
};

export type ChatToolMessage = {
  id: string;
  role: 'tool';
  toolCallId: string;
  name: string;
  text: string;
  isError: boolean;
  at?: number;
} & ChatDetails;

/** `at`: Unix milliseconds (a user message's sending, an assistant reply's start). */
export type ChatMessage = ChatUserMessage | ChatAssistantMessage | ChatToolMessage;

// ── Backups and diagnostics (docs/api.md, "Backups and diagnostics (v0.3)") ──────────────────

export type BackupReason = 'manual' | 'automatic' | 'before-update';

/** A provider, MCP server or service whose secrets are in the keychain, not in a backup (names only). */
export interface BackupKeyNeed {
  kind: 'provider' | 'mcp' | 'web-search' | 'judgments';
  id: string;
  name: string;
  /** "API key", "Header X-Org", "Variable GITHUB_TOKEN", "Sign-in". */
  items: string[];
}

export interface Backup {
  /** The file's name without .zip. */
  id: string;
  file: string;
  path: string;
  /** Unix ms. */
  createdAt: number;
  /** The zip's size on disk, in bytes. */
  size: number;
  /** Size before compression. */
  bytes: number;
  reason: BackupReason;
  version: string;
  agents: number;
  /** What the agents' own workspace folders add, before compression. */
  workspaceBytes: number;
  needsKeys: BackupKeyNeed[];
  warnings: string[];
  /** False for a file that isn't a backup this version can open: it can't be restored. */
  readable: boolean;
}

/** A restore waiting for the app to restart. */
export interface PendingRestore {
  id: string;
  requestedAt: number;
  phase: 'pending' | 'applying';
}

export interface LastRestore {
  ok: boolean;
  /** Unix ms. */
  at: number;
  /** The backup restored. */
  id: string;
  /** The folder the replaced data was moved to. */
  movedTo: string;
  error: string;
}

/** `GET /api/backups`. */
export interface BackupList {
  backups: Backup[];
  /** Where backups are kept. */
  folder: string;
  /** The daily automatic backup is on. */
  auto: boolean;
  /** How many automatic backups are kept. */
  keep: number;
  /** A backup is being made. */
  running: boolean;
  /** Why the last automatic backup failed; "" if it didn't. */
  autoError: string;
  pending: PendingRestore | null;
  /** The app can restart itself to restore; otherwise the person quits and opens it. */
  canRestart: boolean;
  lastRestore: LastRestore | null;
}

// ── Activity (docs/api.md, "Activity (v0.3)") ──────────────────────────────────────────────

export type ActivityKind =
  | 'tool'
  | 'message'
  | 'schedule'
  | 'ask'
  | 'approval'
  | 'sign_in'
  | 'budget'
  | 'error';

/** One thing that happened: a tool call, a message sent, a schedule run, an approval decided, an error. */
export interface ActivityEntry {
  id: number;
  /** Unix ms: when it happened (a tool call: when it ended). */
  at: number;
  kind: ActivityKind;
  /** Null for what belongs to no agent (an MCP sign-in). */
  agentId: string | null;
  /** The agent's name as it was then. */
  agentName: string;
  threadId: string | null;
  /** Who: the agent, the person, a schedule, another agent, or Pi Local. */
  actor: string;
  title: string;
  /** `ok`, `error`, `denied`, `declined`, `refused` or `cancelled`. */
  outcome: string;
  durationMs: number | null;
  /** What more is known; its fields depend on the kind. */
  detail: Record<string, unknown>;
}

/** `GET /api/activity`: a page, newest first. */
export interface ActivityPage {
  items: ActivityEntry[];
  /** Pass as `before` for the next page; null at the end. */
  nextBefore: string | null;
}

/** What `GET /api/activity` and its export filter by. */
export interface ActivityFilters {
  agent?: string;
  thread?: string;
  kind?: ActivityKind[];
  outcome?: string[];
  /** Matches the title, the actor, the agent's name and the detail. */
  q?: string;
  /** Only entries at or after this time (Unix ms). */
  since?: number;
}
