import { McpClient } from "@earendil-works/pi-mcp";
import { authorizeMcp, McpOAuthAuthorizationRequiredError, OAuthCallbackServer } from "@earendil-works/pi-mcp/oauth";
import type { McpOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import { appOAuthStore, createTransport, type McpServerConfig, modelVisible, refreshOnlyStore } from "./mcp.ts";

/**
 * What the app asks of `runtime.mjs mcp-probe` (one JSON object on stdin):
 * - `server`: the server, resolved as for an agent (secrets and paths filled in).
 * - `signIn`: for an OAuth server, run the sign-in when one is needed: listen for the redirect on loopback, print the
 *   authorization URL for the app to open in the browser, and wait for the person.
 * - `oauthUrl`, `key`: the app's OAuth state store (as an agent's MCP_OAUTH_URL and PLATFORM_KEY).
 */
export type ProbeRequest = {
	server: McpServerConfig;
	signIn?: boolean;
	oauthUrl?: string;
	key?: string;
	/** Default 30 s; a sign-in gets 5 minutes. */
	timeoutMs?: number;
	/** The loopback port the sign-in listens on (so the redirect URI the server registered stays the same). */
	callbackPort?: number;
};

/** What it prints, one JSON object per line. The last line is `result` or `error`. */
export type ProbeEvent =
	| { type: "authorize"; url: string; redirectUrl: string }
	| { type: "signed-in" }
	| {
			type: "result";
			serverInfo?: unknown;
			instructions?: string;
			tools: { name: string; title?: string; description?: string; inputSchema?: unknown; modelVisible: boolean }[];
	  }
	| { type: "error"; code: "needs_sign_in" | "connect_failed" | "timeout" | "invalid_request"; message: string; stderr?: string };

/** Connect to one MCP server, sign in if asked and needed, and list its tools. Never throws: the outcome is an event. */
export async function probeMcpServer(request: ProbeRequest, emit: (event: ProbeEvent) => void): Promise<boolean> {
	const { server } = request;
	let stderr = "";
	const onStderr = (chunk: string) => {
		if (stderr.length < 16 * 1024) stderr += chunk;
	};
	const base = request.oauthUrl && request.key ? appOAuthStore(request.oauthUrl, request.key, server.slug) : undefined;
	// A test must leave the stored state alone: without tokens the OAuth flow would register a client (for a redirect
	// nobody listens on) and save it, which a later sign-in would then reuse and be refused for. Only a sign-in writes.
	let store: McpOAuthStateStore | undefined = base && !request.signIn ? refreshOnlyStore(base) : base;
	const timeoutMs = request.timeoutMs ?? (request.signIn ? 5 * 60_000 : 30_000);
	let callback: OAuthCallbackServer | undefined;
	let timer: NodeJS.Timeout | undefined;

	const attempt = async (): Promise<ProbeEvent> => {
		// For a sign-in, the redirect lands on our own loopback listener, and the server is told that address.
		if (request.signIn && server.oauth) {
			callback = await OAuthCallbackServer.listen({ port: request.callbackPort ?? 0, timeoutMs });
		}
		const config: McpServerConfig = callback && server.oauth ? { ...server, oauth: { ...server.oauth, redirectUrl: callback.redirectUrl } } : server;
		// A client registered for another redirect URI (an earlier sign-in on another port) can't sign in here:
		// forget that registration, so the server registers this one.
		if (callback && base) {
			const redirect = callback.redirectUrl;
			store = {
				load: async () => {
					const state = await base.load();
					const uris = (state?.clientInformation as { redirect_uris?: string[] } | undefined)?.redirect_uris;
					if (state && Array.isArray(uris) && !uris.includes(redirect)) return { ...state, clientInformation: undefined };
					return state;
				},
				save: (state) => base.save(state),
			};
		}
		let authorizeUrl: URL | undefined;
		const connect = async () => {
			const { transport, oauth } = createTransport(config, { oauthStore: store, onStderr, onAuthorize: (url) => void (authorizeUrl = url) });
			const client = new McpClient({ name: "pi-local-probe", version: "1", requestTimeoutMs: 20_000 });
			try {
				await client.connect(transport);
				return { client, oauth };
			} catch (error) {
				await client.close().catch(() => {});
				throw Object.assign(error as Error, { oauth });
			}
		};
		let connected: Awaited<ReturnType<typeof connect>>;
		try {
			connected = await connect();
		} catch (error) {
			if (!(error instanceof McpOAuthAuthorizationRequiredError)) throw error;
			const oauth = (error as { oauth?: Awaited<ReturnType<typeof connect>>["oauth"] }).oauth;
			if (!callback || !oauth || !authorizeUrl) {
				return { type: "error", code: "needs_sign_in", message: `${server.name} needs you to sign in.` };
			}
			const state = await oauth.state();
			const waiting = callback.waitForCallback(state);
			emit({ type: "authorize", url: authorizeUrl.toString(), redirectUrl: callback.redirectUrl });
			const { code } = await waiting;
			await authorizeMcp(oauth, { serverUrl: config.url!, authorizationCode: code });
			emit({ type: "signed-in" });
			connected = await connect();
		}
		try {
			const tools = await connected.client.listTools();
			return {
				type: "result",
				serverInfo: connected.client.serverInfo,
				instructions: connected.client.instructions,
				tools: tools.map((t) => ({
					name: t.name,
					title: t.title,
					description: t.description,
					inputSchema: t.inputSchema,
					modelVisible: modelVisible((t as { _meta?: unknown })._meta),
				})),
			};
		} finally {
			await connected.client.close().catch(() => {});
		}
	};

	let outcome: ProbeEvent;
	try {
		outcome = await Promise.race([
			attempt(),
			new Promise<ProbeEvent>((resolve) => {
				timer = setTimeout(() => resolve({ type: "error", code: "timeout", message: `No answer from ${server.name} within ${Math.round(timeoutMs / 1000)} s.` }), timeoutMs);
			}),
		]);
	} catch (error) {
		outcome = { type: "error", code: "connect_failed", message: (error as Error).message };
	} finally {
		clearTimeout(timer);
		await callback?.close().catch(() => {});
	}
	if (outcome.type === "error" && stderr) outcome.stderr = stderr.slice(-8 * 1024);
	emit(outcome);
	return outcome.type === "result";
}

/** `runtime.mjs mcp-probe`: read a ProbeRequest from stdin, print events as JSON lines, exit 0 on success, 1 otherwise. */
export async function runMcpProbe(): Promise<never> {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let request: ProbeRequest;
	try {
		request = JSON.parse(input) as ProbeRequest;
		if (!request?.server?.slug || !request.server.name) throw new Error("server.slug and server.name are required");
	} catch (error) {
		console.log(JSON.stringify({ type: "error", code: "invalid_request", message: (error as Error).message } satisfies ProbeEvent));
		process.exit(2);
	}
	// Each line written, and flushed before exiting: process.exit doesn't wait for a pipe, so a long result (a server
	// with many tools) was cut at the pipe's 64 KiB.
	let written = Promise.resolve();
	const ok = await probeMcpServer(request, (event) => {
		const line = `${JSON.stringify(event)}\n`;
		written = written.then(() => new Promise<void>((resolve) => process.stdout.write(line, () => resolve())));
	});
	await written;
	process.exit(ok ? 0 : 1);
}
