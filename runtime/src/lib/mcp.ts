import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { ToolAnnotations, ToolInfo } from "./approval-rules.ts";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { McpClient, type McpFetch, type McpTransport, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import {
	adaptOAuthProvider,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	type McpOAuthState,
	type McpOAuthStateStore,
} from "@earendil-works/pi-mcp/oauth";

/**
 * How the runtime reaches one MCP server. The app resolves everything before it starts the runtime: secrets in
 * headers and env, and `${workspace}`-style paths, so the runtime never reads a secret store or a config file.
 */
/** A tool the platform lists for a server; `annotations` are the server's hints (readOnlyHint, destructiveHint), when it gave them. */
export type McpToolConfig = { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: unknown };

export type McpServerConfig = {
	slug: string;
	name: string;
	description?: string;
	/** `http` (Streamable HTTP, the default) or `stdio` (a local process the runtime starts and owns). */
	transport?: "http" | "stdio";
	/** http: the server's URL and request headers. */
	url?: string;
	headers?: Record<string, string>;
	/** http: sign in with OAuth. Credentials are kept by the app (MCP_OAUTH_URL); the runtime never starts a sign-in. */
	oauth?: { redirectUrl: string; clientName?: string };
	/** stdio: the command, its arguments, working directory and extra environment (over the runtime's own, minimal). */
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	/** A catalog server's tools; absent for an app's (client) server, whose tools are listed on connect. */
	tools?: McpToolConfig[];
	thread?: string;
	client?: boolean;
	/** The platform's MCP proxy: name each tool call's thread (PDP-Thread), so the platform can say who the call is for. */
	sendThread?: boolean;
};

/** The thread of the tool call in progress, for PDP-Thread. */
const callThread = new AsyncLocalStorage<string>();

/** fetch that adds PDP-Thread to a tool call's requests (only to the platform's proxy: servers marked sendThread). */
export function threadFetch(base: McpFetch): McpFetch {
	return (input, init) => {
		const thread = callThread.getStore();
		if (thread === undefined) return base(input, init);
		const headers = new Headers(init?.headers);
		headers.set("PDP-Thread", thread);
		return base(input, { ...init, headers });
	};
}

/** How long a tool call may take, not counting the time a person spends answering the server's question. */
const CALL_TIMEOUT_MS = 120_000;

/** What an MCP server asks the person mid-call (`elicitation/create`, form mode), as the app is told. */
export type ElicitRequest = {
	server: string;
	serverName: string;
	tool?: string;
	threadId?: string;
	message: string;
	requestedSchema: unknown;
};

/** MCP's ElicitResult. */
export type ElicitResult = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

/** Asks the person (through the app) and waits for the answer; `signal` aborts when the server or the call gives up. */
export type Elicitor = (request: ElicitRequest, signal: AbortSignal) => Promise<ElicitResult>;

/**
 * The app's elicitation relay (MCP_ELICIT_URL): POST the question, then wait for the answer in long polls; DELETE it
 * when the server or the call gives up first. Anything unexpected is "cancel": the server then does nothing.
 */
export function appElicitor(base: string, key: string, fetchImpl: typeof fetch = fetch): Elicitor {
	const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
	return async (request, signal) => {
		let id: string;
		try {
			const res = await fetchImpl(base, { method: "POST", headers, body: JSON.stringify(request), signal });
			if (!res.ok) {
				console.error(`[runtime] MCP ${request.server}: the app refused its question (status ${res.status})`);
				return { action: "cancel" };
			}
			id = ((await res.json()) as { data: { id: string } }).data.id;
		} catch (error) {
			if (signal.aborted) throw error;
			console.error(`[runtime] MCP ${request.server}: couldn't relay its question:`, (error as Error).message);
			return { action: "cancel" };
		}
		const withdraw = () => void fetchImpl(`${base}/${encodeURIComponent(id)}`, { method: "DELETE", headers }).catch(() => {});
		signal.addEventListener("abort", withdraw, { once: true });
		try {
			for (;;) {
				const res = await fetchImpl(`${base}/${encodeURIComponent(id)}?wait=25`, { headers, signal });
				if (res.status === 404) return { action: "cancel" };
				if (!res.ok) throw new Error(`status ${res.status}`);
				const data = ((await res.json()) as { data: { done: boolean; action?: ElicitResult["action"]; content?: Record<string, unknown> } }).data;
				if (!data.done) continue;
				const action = data.action === "accept" || data.action === "decline" ? data.action : "cancel";
				return action === "accept" && data.content ? { action, content: data.content } : { action };
			}
		} catch (error) {
			if (signal.aborted) throw error;
			console.error(`[runtime] MCP ${request.server}: waiting for the answer failed:`, (error as Error).message);
			withdraw();
			return { action: "cancel" };
		} finally {
			signal.removeEventListener("abort", withdraw);
		}
	};
}

/** The boolean hints of a tool's annotations, nothing else (a server's other fields are none of the policy's business). */
export function cleanAnnotations(value: unknown): ToolAnnotations | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const out: ToolAnnotations = {};
	for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
		const hint = (value as Record<string, unknown>)[key];
		if (typeof hint === "boolean") out[key] = hint;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** A tool call in progress on a connection: whose it is, and its clock (paused while a person answers). */
type CallInFlight = { tool: string; thread: () => Promise<string | undefined>; pause(): void; resume(): void };

/** Above this many MCP tools, they are deferred: the model finds them with tool_search. */
const DEFER_ABOVE = 20;

/**
 * Whether a tool may be offered to the model. The MCP Apps extension (io.modelcontextprotocol/ui) lets a server keep a
 * tool for its app's interface (`_meta.ui.visibility` without "model"), and a host must not offer that tool to the model.
 * Without the field, or when it isn't what the extension describes, the tool is visible (its default). The platform
 * applies the same rule to the servers it lists (internal/mcp, modelVisible).
 */
export function modelVisible(meta: unknown): boolean {
	if (meta === null || typeof meta !== "object") return true;
	const ui = (meta as { ui?: unknown }).ui;
	if (ui === null || typeof ui !== "object") return true;
	const visibility = (ui as { visibility?: unknown }).visibility;
	if (!Array.isArray(visibility)) return true;
	return visibility.includes("model");
}

/** Tool names providers accept: at most 64 of [A-Za-z0-9_-]. */
export function toolName(prefix: string, slug: string, tool: string): string {
	return `${prefix}__${slug}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/** An MCP server that needs a person to sign in (OAuth) before the agent can use it. */
export class McpSignInRequiredError extends Error {
	constructor(readonly server: McpServerConfig) {
		super(`The MCP server "${server.name}" needs you to sign in. Open Pi Local, MCP servers, and choose Sign in for ${server.name}.`);
		this.name = "McpSignInRequiredError";
	}
}

/**
 * An OAuth state store kept by the app: `GET`/`PUT {base}/{slug}` with the agent's key. The app keeps the state in the
 * OS keychain and serializes saves per server, so two agents refreshing one rotating refresh token can't clobber it.
 */
export function appOAuthStore(base: string, key: string, slug: string, fetchImpl: typeof fetch = fetch): McpOAuthStateStore {
	const url = `${base.replace(/\/$/, "")}/${encodeURIComponent(slug)}`;
	const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
	return {
		load: async () => {
			const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
			if (res.status === 404) return undefined;
			if (!res.ok) throw new Error(`MCP sign-in state for ${slug}: status ${res.status}`);
			return ((await res.json()) as { data: McpOAuthState | null }).data ?? undefined;
		},
		save: async (state) => {
			const res = await fetchImpl(url, { method: "PUT", headers, body: JSON.stringify(state), signal: AbortSignal.timeout(10_000) });
			if (!res.ok) throw new Error(`saving MCP sign-in state for ${slug}: status ${res.status}`);
		},
	};
}

/**
 * The store as an agent uses it: it may refresh tokens, never begin a sign-in. The OAuth flow, finding no usable
 * tokens, would register a client and save a verifier for an authorization nobody will complete (with the agent's
 * redirect URI, which a later real sign-in would then inherit). So a state without tokens is never saved; the
 * connection fails with McpSignInRequiredError instead, and the person signs in from the app.
 */
export function refreshOnlyStore(store: McpOAuthStateStore): McpOAuthStateStore & { hasTokens(): Promise<boolean> } {
	return {
		load: () => store.load(),
		save: async (state) => {
			if (state.tokens?.access_token || state.tokens?.refresh_token) await store.save(state);
		},
		hasTokens: async () => {
			const state = await store.load();
			return Boolean(state?.tokens?.access_token || state?.tokens?.refresh_token);
		},
	};
}

export type TransportOptions = {
	fetch?: McpFetch;
	/** Where OAuth state lives (required for a server with `oauth`). */
	oauthStore?: McpOAuthStateStore;
	/** Called with the authorization URL when the server needs a sign-in. The runtime leaves it unset: it never signs in. */
	onAuthorize?: (url: URL) => void | Promise<void>;
	onStderr?: (chunk: string) => void;
};

/** The transport for a server: a local process (stdio) or Streamable HTTP, with OAuth when the server uses it. */
export function createTransport(server: McpServerConfig, options: TransportOptions = {}): { transport: McpTransport; oauth?: McpOAuthProvider } {
	if (server.transport === "stdio") {
		if (!server.command) throw new Error(`MCP server ${server.slug}: a stdio server needs a command`);
		return {
			transport: new StdioTransport({
				command: server.command,
				args: server.args ?? [],
				cwd: server.cwd,
				env: server.env ?? {},
				stderr: "pipe",
				onStderr: options.onStderr,
				maxStderrBytes: 64 * 1024,
			}),
		};
	}
	if (!server.url) throw new Error(`MCP server ${server.slug}: an http server needs a url`);
	let oauth: McpOAuthProvider | undefined;
	if (server.oauth) {
		if (!options.oauthStore) throw new Error(`MCP server ${server.slug} signs in with OAuth, but the runtime has no MCP_OAUTH_URL`);
		oauth = new McpOAuthProvider({
			serverUrl: server.url,
			redirectUrl: server.oauth.redirectUrl,
			clientMetadata: { client_name: server.oauth.clientName ?? "Pi Local" },
			store: options.oauthStore,
			onRedirect: options.onAuthorize ?? (() => {}),
		});
	}
	return {
		transport: new StreamableHttpTransport({
			url: server.url,
			headers: server.headers,
			openGetStream: false,
			...(options.fetch ? { fetch: options.fetch } : {}),
			...(oauth ? { authProvider: adaptOAuthProvider(oauth) } : {}),
		}),
		oauth,
	};
}

/** stderr of a stdio server, into the agent's log a line at a time (bounded, so a chatty server can't flood it). */
function stderrLogger(slug: string): (chunk: string) => void {
	let budget = 256 * 1024;
	return (chunk) => {
		if (budget <= 0) return;
		budget -= chunk.length;
		for (const line of chunk.split("\n")) if (line.trim()) console.error(`[mcp ${slug}] ${line.slice(0, 2000)}`);
		if (budget <= 0) console.error(`[mcp ${slug}] (further stderr not logged)`);
	};
}

/** One lazily connected MCP session per server; reconnects after a failure. */
class Connection {
	private client: Promise<McpClient> | undefined;
	private readonly onStderr: (chunk: string) => void;
	/** Calls in progress, newest last: a server's question belongs to one of them (stdio says no more than that). */
	readonly calls: CallInFlight[] = [];
	constructor(
		private readonly server: McpServerConfig,
		private readonly fetchImpl?: McpFetch,
		private readonly oauthStore?: (slug: string) => McpOAuthStateStore | undefined,
		private readonly elicit?: Elicitor,
	) {
		this.onStderr = stderrLogger(server.slug);
	}

	/** Relays a server's question to the person; every call's clock stops meanwhile. */
	private async answer(params: unknown, signal: AbortSignal): Promise<ElicitResult> {
		const p = (params ?? {}) as { mode?: string; message?: unknown; requestedSchema?: unknown };
		// Only form mode is declared; a URL-mode request (or no relay) is cancelled, so the server does nothing.
		if (!this.elicit || (p.mode !== undefined && p.mode !== "form") || typeof p.message !== "string") return { action: "cancel" };
		const calls = [...this.calls];
		const call = calls.at(-1);
		for (const c of calls) c.pause();
		try {
			const threadId = await call?.thread().catch(() => undefined);
			return await this.elicit(
				{ server: this.server.slug, serverName: this.server.name, ...(call ? { tool: call.tool } : {}), ...(threadId ? { threadId } : {}), message: p.message, requestedSchema: p.requestedSchema ?? { type: "object", properties: {} } },
				signal,
			);
		} finally {
			for (const c of calls) c.resume();
		}
	}

	get(): Promise<McpClient> {
		this.client ??= (async () => {
			const client = new McpClient({
				name: "pi-local-agent",
				version: "1",
				requestTimeoutMs: CALL_TIMEOUT_MS,
				// The person can be asked (form mode): the app shows the server's question and sends the answer back.
				...(this.elicit ? { capabilities: { elicitation: { form: {} } } } : {}),
			});
			if (this.elicit) client.setRequestHandler("elicitation/create", (params, { signal }) => this.answer(params, signal));
			const fetch = this.fetchImpl ? (this.server.sendThread ? threadFetch(this.fetchImpl) : this.fetchImpl) : undefined;
			const base = this.server.oauth ? this.oauthStore?.(this.server.slug) : undefined;
			const store = base ? refreshOnlyStore(base) : undefined;
			// Nobody has signed in: say so without contacting the authorization server.
			if (store && !(await store.hasTokens())) throw new McpSignInRequiredError(this.server);
			const { transport } = createTransport(this.server, { fetch, oauthStore: store, onStderr: this.onStderr });
			try {
				await client.connect(transport);
			} catch (error) {
				await client.close().catch(() => {});
				if (error instanceof McpOAuthAuthorizationRequiredError) throw new McpSignInRequiredError(this.server);
				throw error;
			}
			return client;
		})().catch((error: unknown) => {
			this.client = undefined;
			throw error;
		});
		return this.client;
	}

	async close(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		await client?.then((c) => c.close()).catch(() => {});
	}
}

type ThreadOf = (conversationId: number) => Promise<string | undefined>;

function toolsFor(
	prefix: string,
	server: McpServerConfig,
	tools: readonly McpToolConfig[],
	conn: Connection,
	deferred: boolean,
	threadOf?: ThreadOf,
	callTimeoutMs: number = CALL_TIMEOUT_MS,
): ToolRegistration[] {
	return tools.map((tool) =>
		defineTool({
			name: toolName(prefix, server.slug, tool.name),
			description: `${tool.description ?? tool.title ?? tool.name} (MCP server ${server.name})`.slice(0, 4000),
			parameters: Type.Unsafe<Record<string, unknown>>({ ...(tool.inputSchema ?? {}), type: "object", properties: (tool.inputSchema?.properties as object) ?? {} }),
			...(deferred ? { deferred: true as const } : {}),
			execute: async (args, api, context: Context) => {
				const client = await conn.get();
				// The handshake above names no thread; the call does (the platform looks it up among this agent's threads).
				const thread = server.sendThread ? await threadOf?.(api.conversationId as unknown as number) : undefined;
				// Its own clock (CALL_TIMEOUT_MS), stopped while the server waits for the person's answer.
				const controller = new AbortController();
				const onAbort = () => controller.abort(context.abortSignal?.reason);
				context.abortSignal?.addEventListener("abort", onAbort, { once: true });
				let timer: ReturnType<typeof setTimeout> | undefined;
				let timedOut = false;
				const arm = () => {
					clearTimeout(timer);
					timer = setTimeout(() => {
						timedOut = true;
						controller.abort(new Error("timed out"));
					}, callTimeoutMs);
				};
				const inFlight: CallInFlight = {
					tool: tool.name,
					thread: async () => thread ?? threadOf?.(api.conversationId as unknown as number),
					pause: () => clearTimeout(timer),
					resume: arm,
				};
				conn.calls.push(inFlight);
				arm();
				// pi-mcp's own limit is set far off: the clock above decides.
				const call = () => client.callTool(tool.name, args as Record<string, unknown>, { signal: controller.signal, timeoutMs: 24 * 60 * 60_000 });
				try {
					const result = await (thread === undefined ? call() : callThread.run(thread, call));
					return { output: toLlmContent(result), isError: result.isError === true };
				} catch (error) {
					await conn.close(); // a fresh session next time
					// Signed out (or the tokens were revoked) while connected: say what to do, as a connect would.
					if (error instanceof McpOAuthAuthorizationRequiredError) throw new McpSignInRequiredError(server);
					if (timedOut) throw new Error(`${server.name} didn't answer ${tool.name} within ${Math.round(callTimeoutMs / 1000)} seconds.`);
					throw error;
				} finally {
					clearTimeout(timer);
					context.abortSignal?.removeEventListener("abort", onAbort);
					conn.calls.splice(conn.calls.indexOf(inFlight), 1);
				}
			},
		}),
	);
}

/**
 * MCP servers for an agent: its template's (MCP_SERVERS: tools known up front, connected on first use) and the
 * servers an app gives each thread (fetched from the platform's MCP_THREADS_URL with MCP_KEY, listed on connect).
 * Each thread's servers are an extension only that thread selects.
 */
export class AgentMcp {
	readonly extensions: Extension[] = [];
	private readonly connections: Connection[] = [];
	private readonly threadExts = new Map<string, { key: string; extension: Extension; connections: Connection[] }>();
	private toolSearch: Extension | undefined;
	/** What the approval rules know of each tool (by its registered name): that it is MCP's, its own name and annotations. */
	private readonly info = new Map<string, ToolInfo>();
	/** The thread a conversation belongs to (set once the threads are known); the template's proxied tool calls name it. */
	threadOf: ThreadOf = async () => undefined;
	/** Relays the servers' questions to the person (MCP_ELICIT_URL), when the app offers it. */
	private readonly elicit: Elicitor | undefined;
	/** A tool call's own time limit (MCP_CALL_TIMEOUT_MS, for tests; CALL_TIMEOUT_MS otherwise). */
	private readonly callTimeoutMs: number;

	constructor(
		private readonly env: Record<string, string | undefined>,
		private readonly install: (extension: Extension) => void,
		private readonly fetchImpl: typeof fetch = fetch,
	) {
		const servers = parseServers(env.MCP_SERVERS);
		const count = servers.reduce((n, s) => n + (s.tools?.length ?? 0), 0);
		const deferred = count > DEFER_ABOVE;
		const tools: ToolRegistration[] = [];
		const oauthBase = env.MCP_OAUTH_URL;
		const oauthKey = env.PLATFORM_KEY;
		const oauthStore = oauthBase && oauthKey ? (slug: string) => appOAuthStore(oauthBase, oauthKey, slug, this.fetchImpl) : undefined;
		const timeout = Number(env.MCP_CALL_TIMEOUT_MS);
		this.callTimeoutMs = Number.isFinite(timeout) && timeout >= 100 ? timeout : CALL_TIMEOUT_MS;
		this.elicit = env.MCP_ELICIT_URL && oauthKey ? appElicitor(env.MCP_ELICIT_URL, oauthKey, (input, init) => this.fetchImpl(input, init)) : undefined;
		for (const server of servers) {
			const conn = new Connection(server, (input, init) => this.fetchImpl(input, init), oauthStore, this.elicit);
			this.connections.push(conn);
			tools.push(...toolsFor("mcp", server, server.tools ?? [], conn, deferred, (id) => this.threadOf(id), this.callTimeoutMs));
			this.note("mcp", server, server.tools ?? []);
		}
		if (tools.length > 0) this.extensions.push(defineExtension({ name: "mcp", tools }));
		if (deferred) this.extensions.push(this.searchExtension());
	}

	private note(prefix: string, server: McpServerConfig, tools: readonly McpToolConfig[]): void {
		for (const tool of tools) {
			const annotations = cleanAnnotations(tool.annotations);
			this.info.set(toolName(prefix, server.slug, tool.name), { mcp: true, toolName: tool.name, ...(annotations === undefined ? {} : { annotations }) });
		}
	}

	/** What is known of a tool for the approval rules: undefined for a tool that isn't an MCP server's. */
	toolInfo(name: string): ToolInfo | undefined {
		return this.info.get(name);
	}

	/** tool_search, installed the first time a set of tools needs it (a thread's servers may be the first). */
	private searchExtension(): Extension {
		if (this.toolSearch === undefined) {
			this.toolSearch = createToolSearchExtension();
			this.install(this.toolSearch);
		}
		return this.toolSearch;
	}

	/** Whether apps may give this agent's threads MCP servers. */
	get clientServers(): boolean {
		return Boolean(this.env.MCP_THREADS_URL && this.env.MCP_KEY);
	}

	private async fetchServers(threadId?: string): Promise<McpServerConfig[]> {
		const url = new URL(this.env.MCP_THREADS_URL!);
		if (threadId) url.searchParams.set("thread", threadId);
		const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.env.MCP_KEY}` }, signal: AbortSignal.timeout(10_000) });
		if (!res.ok) throw new Error(`thread MCP servers: status ${res.status}`);
		return ((await res.json()) as { data: McpServerConfig[] }).data ?? [];
	}

	/** Installs every thread's servers (at start, so resumed runs find their tools). */
	async restore(): Promise<void> {
		if (!this.clientServers) return;
		const byThread = new Map<string, McpServerConfig[]>();
		for (const s of await this.fetchServers()) {
			if (!s.thread) continue;
			byThread.set(s.thread, [...(byThread.get(s.thread) ?? []), s]);
		}
		for (const [thread, servers] of byThread) await this.installThread(thread, servers).catch((e) => console.error(`[runtime] MCP servers of thread ${thread}:`, (e as Error).message));
	}

	/** The MCP extensions a thread selects: the template's, plus the servers the app gave it now (fetched). */
	async forThread(threadId: string): Promise<Extension[]> {
		if (!this.clientServers) return [...this.extensions];
		return this.withThread(await this.installThread(threadId, await this.fetchServers(threadId)));
	}

	/** The MCP extensions a thread selects as far as this process knows, without asking the platform. */
	installed(threadId: string): Extension[] {
		return this.withThread(this.threadExts.get(threadId)?.extension);
	}

	private withThread(ext: Extension | undefined): Extension[] {
		const out = [...this.extensions];
		if (ext) {
			out.push(ext);
			if ((ext.tools?.length ?? 0) > DEFER_ABOVE && !out.includes(this.searchExtension())) out.push(this.searchExtension());
		}
		return out;
	}

	private async installThread(threadId: string, servers: McpServerConfig[]): Promise<Extension | undefined> {
		const key = JSON.stringify(servers.map((s) => [s.slug, s.url, s.headers ?? {}]));
		const current = this.threadExts.get(threadId);
		if (current?.key === key) return current.extension;
		for (const c of current?.connections ?? []) await c.close();
		if (servers.length === 0) {
			this.threadExts.delete(threadId);
			return undefined;
		}
		const connections: Connection[] = [];
		const listed: { server: McpServerConfig; conn: Connection; tools: McpToolConfig[] }[] = [];
		for (const server of servers) {
			const conn = new Connection(server, undefined, undefined, this.elicit);
			connections.push(conn);
			try {
				const client = await conn.get();
				const tools = (await client.listTools())
					.filter((t) => modelVisible((t as { _meta?: unknown })._meta))
					.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, annotations: (t as { annotations?: unknown }).annotations }));
				listed.push({ server, conn, tools });
			} catch (error) {
				console.error(`[runtime] MCP server ${server.name} of thread ${threadId}:`, (error as Error).message);
			}
		}
		for (const l of listed) this.note("mcpc", l.server, l.tools);
		const total = listed.reduce((n, l) => n + l.tools.length, 0);
		const tools = listed.flatMap((l) => toolsFor("mcpc", l.server, l.tools, l.conn, total > DEFER_ABOVE, async () => threadId, this.callTimeoutMs));
		const extension = defineExtension({ name: `mcp-thread:${threadId}`, tools });
		this.install(extension);
		this.threadExts.set(threadId, { key, extension, connections });
		return extension;
	}

	async close(): Promise<void> {
		for (const c of this.connections) await c.close();
		for (const t of this.threadExts.values()) for (const c of t.connections) await c.close();
	}
}

function parseServers(raw: string | undefined): McpServerConfig[] {
	if (!raw?.trim()) return [];
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) throw new Error("MCP_SERVERS must be a JSON array");
	return parsed as McpServerConfig[];
}
