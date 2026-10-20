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
  /** What it is (the runtime kind, also its catalog template ID). */
  agentKind: 'assistant' | 'triage' | 'researcher';
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
   * researcher: backgroundSubagents, maxPlanSteps); {} for none. Phase 3.
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
}

/** `409 in_use`'s `details.agents`. */
export interface AgentRef {
  id: string;
  name: string;
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

/** `GET /api/me/usage?days=`. Dates are YYYY-MM-DD, local time. */
export interface UsageReport {
  from: string;
  to: string;
  days: number;
  total: UsageTotals;
  /** Deleted agents keep their last name. */
  agents: (UsageTotals & { agentId: string; name: string })[];
  models: (UsageTotals & { modelId: string; name: string })[];
  /** Every day of the range, zeros included. */
  byDay: (UsageTotals & { day: string })[];
}

// ── The runtime's chat view (runtime/src/lib/view.ts) ─────────────────────────────────────────

/** Who sent a user message: a person, a service account, or a trigger (an unattended run). */
export type Author = {
  kind: 'user' | 'service_account' | 'trigger';
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
  status: 'pending' | 'approved' | 'denied' | 'timed_out' | 'cancelled';
  requestedAt: number;
  expiresAt?: number;
  summary?: string;
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
