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
