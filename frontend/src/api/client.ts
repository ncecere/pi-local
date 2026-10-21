import { ApiError } from './errors';
import { type Method, type RequestOptions, transport } from './transport';

export { ApiError, apiErrorFrom } from './errors';
/**
 * Pi Local's UI API (docs/api.md), served by the Go backend on the same
 * origin. There is one local user: no sign-in, no session, no CSRF token.
 */
export type {
  About,
  ActivityEntry,
  ActivityFilters,
  ActivityKind,
  ActivityPage,
  Agent,
  AgentApprovals,
  AgentBudget,
  AgentEvent,
  AgentLogs,
  AgentMcpServer,
  AgentMemory,
  AgentRef,
  AgentSecurity,
  AgentStatus,
  AgentTemplate,
  AgentThread,
  AgentThreadEvent,
  AgentWorkspace,
  AgentWorkspaceInput,
  Approval,
  ApprovalEvent,
  ApprovalProfile,
  ApprovalRule,
  ApprovalStatus,
  Attachment,
  Author,
  Backup,
  BackupKeyNeed,
  BackupList,
  BackupReason,
  Basics,
  BudgetEvent,
  BudgetOverview,
  BudgetStatus,
  CallableAgent,
  CalledBy,
  CatalogModel,
  ChatApproval,
  ChatAssistantMessage,
  ChatMessage,
  ChatMessage as ChatViewMessage,
  ChatSettings,
  ChatTool,
  ChatToolCall,
  ChatToolMessage,
  ChatUserMessage,
  ChatView,
  ChosenFolder,
  DesktopSettings,
  DetectedServer,
  DiscoveredModel,
  ElicitationAction,
  ElicitationAnswer,
  ElicitationContent,
  ElicitationField,
  ElicitationSchema,
  ElicitationState,
  Fact,
  FactStatus,
  FactTrust,
  JudgmentSettings,
  JudgmentsInfo,
  JudgmentTest,
  LastRestore,
  McpElicitation,
  McpEvent,
  McpImportList,
  McpImportResult,
  McpImportServer,
  McpImportSource,
  McpImportSourceId,
  McpLoginStatus,
  McpServer,
  McpTool,
  McpTransport,
  MemoryEvent,
  MemoryNote,
  Model,
  NotificationEvent,
  PendingRestore,
  Provider,
  ProviderKind,
  ProviderKindId,
  ProviderPreset,
  ProviderSetupResult,
  ProvidersResponse,
  RevealTarget,
  RouteResult,
  Schedule,
  ScheduleEvent,
  ScheduleInput,
  ScheduleRun,
  ScheduleRunEvent,
  ScheduleRunStatus,
  SearchResult,
  Team,
  TeamEvent,
  TemplateCategory,
  ThinkingLevel,
  ThreadDocument,
  UpdateRelease,
  UpdateStage,
  UpdateStatus,
  UsageReport,
  UsageTotals,
  WebSearchProvider,
  WebSearchResult,
  WebSettings,
  WebTools,
  WorkspaceTool,
  YouInfo,
} from './types';

export type Role = 'admin' | 'user';

/**
 * Optional features and whether each is on. Locally: `messageSearch` (Phase 7),
 * `folderDialog` (the native folder dialog, desktop app only) and `updates`
 * (this copy can install updates itself), `agentRouting` (fast judgments pick the agent for a new chat),
 * `modelPerConversation` (the composer's model and thinking picker), and
 * `secretsInKeychain` (keys and secret values go to the system keychain; false: kept in memory, a development server).
 */
export type FeatureId =
  | 'agentRouting'
  | 'usage'
  | 'connectedUsage'
  | 'messageSearch'
  | 'myUsage'
  | 'folderDialog'
  | 'updates'
  | 'modelPerConversation'
  | 'secretsInKeychain';

/** `GET /api/me`: the one local user. */
export interface Me {
  user: { id: string; name: string; email: string; role: Role };
  /** Always "" (compatibility). */
  csrfToken?: string;
  features?: Partial<Record<FeatureId, boolean>>;
  platform?: { mode: string; account: null | Record<string, unknown> };
}

export interface AuthConfig {
  oidcEnabled: boolean;
  devAuthEnabled: boolean;
  devAccounts: { id: string; name: string; email: string }[];
  instance: {
    name: string;
    logoUrl: string | null;
    colorTheme: 'neutral' | 'blue' | 'violet' | 'emerald';
    defaultTheme: 'light' | 'dark' | 'system';
    orgName: string;
    supportUrl: string | null;
  };
}

/** A request to the backend; the `data` of the answer, or throws an ApiError. */
export function request<T>(
  method: Method,
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  return options
    ? transport.request<T>(method, path, body, options)
    : transport.request<T>(method, path, body);
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, body, options),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
  /** POSTs raw bytes (an ArrayBuffer, never a Blob: Wails drops those). */
  upload: <T>(path: string, bytes: ArrayBuffer, contentType: string) =>
    transport.upload<T>(path, bytes, contentType),
  download: (path: string) => transport.download(path),
};

/** `/api/agents/{agentId}…`, with each part encoded. */
export const agentPath = (agentId: string, rest = '') =>
  `/api/agents/${encodeURIComponent(agentId)}${rest}`;
export const threadPath = (agentId: string, threadId: string, rest = '') =>
  agentPath(agentId, `/threads/${encodeURIComponent(threadId)}${rest}`);

/** A message suitable to show for a failed request. */
export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'The connection to Pi Local was lost.';
  return fallback;
}
