import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A Streamable HTTP MCP server behind OAuth 2.1, for tests: protected-resource and authorization-server metadata,
 * dynamic client registration, an authorization endpoint that approves at once (redirecting with a code, as a person
 * clicking "Allow" would), a token endpoint checking PKCE, and rotating refresh tokens (a used one is refused).
 */
export type OAuthMcpServer = {
	url: string;
	/** Access tokens issued so far, refreshes done, and refresh tokens presented after they were used. */
	stats: { issued: number; refreshes: number; reusedRefresh: number; calls: number };
	/** Issue access tokens that expire after this many seconds (default 3600). */
	setExpiresIn(seconds: number): void;
	/** Treat every access token issued so far as expired (the client must refresh). */
	expireAccessTokens(): void;
	close(): Promise<void>;
};

const body = (req: IncomingMessage) =>
	new Promise<string>((resolve) => {
		let data = "";
		req.on("data", (c: Buffer) => (data += c.toString()));
		req.on("end", () => resolve(data));
	});

export async function startOAuthMcpServer(): Promise<OAuthMcpServer> {
	const clients = new Map<string, { redirect_uris: string[] }>();
	const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string }>();
	const access = new Set<string>();
	const refresh = new Set<string>();
	const usedRefresh = new Set<string>();
	const stats = { issued: 0, refreshes: 0, reusedRefresh: 0, calls: 0 };
	let expiresIn = 3600;
	let base = "";

	const issue = () => {
		const a = randomBytes(16).toString("hex");
		const r = randomBytes(16).toString("hex");
		access.add(a);
		refresh.add(r);
		stats.issued++;
		return { access_token: a, token_type: "Bearer", expires_in: expiresIn, refresh_token: r };
	};

	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url!, base);
		const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
			res.writeHead(status, { "content-type": "application/json", ...headers });
			res.end(JSON.stringify(value));
		};
		if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
			return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
		}
		if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
			return json(200, {
				issuer: base,
				authorization_endpoint: `${base}/authorize`,
				token_endpoint: `${base}/token`,
				registration_endpoint: `${base}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
			});
		}
		if (url.pathname === "/register" && req.method === "POST") {
			const meta = JSON.parse(await body(req)) as { redirect_uris: string[] };
			const clientId = `client-${randomBytes(4).toString("hex")}`;
			clients.set(clientId, { redirect_uris: meta.redirect_uris });
			return json(201, { ...meta, client_id: clientId, token_endpoint_auth_method: "none" });
		}
		if (url.pathname === "/authorize") {
			const clientId = url.searchParams.get("client_id") ?? "";
			const redirectUri = url.searchParams.get("redirect_uri") ?? "";
			const client = clients.get(clientId);
			if (!client || !client.redirect_uris.includes(redirectUri)) return json(400, { error: "invalid_request" });
			const code = randomBytes(8).toString("hex");
			codes.set(code, { clientId, challenge: url.searchParams.get("code_challenge") ?? "", redirectUri });
			const back = new URL(redirectUri);
			back.searchParams.set("code", code);
			back.searchParams.set("state", url.searchParams.get("state") ?? "");
			res.writeHead(302, { location: back.toString() });
			return res.end();
		}
		if (url.pathname === "/token" && req.method === "POST") {
			const form = new URLSearchParams(await body(req));
			if (form.get("grant_type") === "authorization_code") {
				const entry = codes.get(form.get("code") ?? "");
				codes.delete(form.get("code") ?? "");
				const verifier = form.get("code_verifier") ?? "";
				const challenge = createHash("sha256").update(verifier).digest("base64url");
				if (!entry || entry.challenge !== challenge || entry.redirectUri !== form.get("redirect_uri")) return json(400, { error: "invalid_grant" });
				return json(200, issue());
			}
			if (form.get("grant_type") === "refresh_token") {
				const token = form.get("refresh_token") ?? "";
				if (usedRefresh.has(token)) stats.reusedRefresh++;
				if (!refresh.has(token)) return json(400, { error: "invalid_grant" });
				refresh.delete(token);
				usedRefresh.add(token);
				stats.refreshes++;
				return json(200, issue());
			}
			return json(400, { error: "unsupported_grant_type" });
		}
		if (url.pathname === "/mcp") {
			const auth = req.headers.authorization ?? "";
			if (!auth.startsWith("Bearer ") || !access.has(auth.slice(7))) {
				return json(401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
			}
			if (req.method !== "POST") return json(405, {});
			const msg = JSON.parse(await body(req)) as { id?: number; method: string; params?: { name?: string; arguments?: { text?: string }; protocolVersion?: string } };
			if (msg.id === undefined) {
				res.writeHead(202);
				return res.end();
			}
			const reply = (result: unknown) => json(200, { jsonrpc: "2.0", id: msg.id, result });
			if (msg.method === "initialize") return reply({ protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "oauth-fixture", version: "1" } });
			if (msg.method === "tools/list") return reply({ tools: [{ name: "whoami", description: "Who am I", inputSchema: { type: "object" } }] });
			if (msg.method === "tools/call") {
				stats.calls++;
				return reply({ content: [{ type: "text", text: "you are the signed-in person" }] });
			}
			return json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } });
		}
		json(404, {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		url: `${base}/mcp`,
		stats,
		setExpiresIn: (seconds) => void (expiresIn = seconds),
		expireAccessTokens: () => access.clear(),
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

/** The app's OAuth state store as the gateway serves it (`GET`/`PUT /mcp/oauth/{slug}`), in memory. */
export async function startStateStore(key: string): Promise<{ url: string; states: Map<string, unknown>; close(): Promise<void> }> {
	const states = new Map<string, unknown>();
	const server = createServer(async (req, res) => {
		if (req.headers.authorization !== `Bearer ${key}`) {
			res.writeHead(401).end();
			return;
		}
		const slug = decodeURIComponent(new URL(req.url!, "http://x").pathname.split("/").pop() ?? "");
		if (req.method === "PUT") {
			states.set(slug, JSON.parse(await body(req)));
			res.writeHead(204).end();
			return;
		}
		if (!states.has(slug)) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: states.get(slug) }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/oauth`,
		states,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
