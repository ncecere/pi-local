import { describe, expect, it } from "vitest";
import { createAgentModels } from "../src/lib/models.ts";

const catalog = {
	MODEL_PROVIDER: "catalog",
	MODEL_BASE_URL: "http://platform:8099/model-proxy/p1/",
	MODEL_API_KEY: "pdpm.agent.token",
	MODEL_ID: "claude-x",
	MODEL_NAME: "Claude X",
	MODEL_PROVIDER_NAME: "Anthropic",
	MODEL_CONTEXT_WINDOW: "200000",
	MODEL_MAX_TOKENS: "8192",
	MODEL_REASONING: "true",
	MODEL_IMAGES: "true",
};

describe("agent models", () => {
	it("defaults to the scripted demo model", () => {
		const { model, source } = createAgentModels({});
		expect(model).toEqual({ provider: "demo", modelId: "demo-1" });
		expect(source).toBe("scripted demo");
	});

	it.each(["anthropic-messages", "openai-responses", "openai-completions"])("configures a catalog model speaking %s", (api) => {
		const { models, model, source } = createAgentModels({ ...catalog, MODEL_API: api });
		const m = models.getModel(model.provider, model.modelId);
		expect(m).toMatchObject({
			id: "claude-x",
			name: "Claude X",
			api,
			baseUrl: "http://platform:8099/model-proxy/p1",
			contextWindow: 200000,
			maxTokens: 8192,
			reasoning: true,
			input: ["text", "image"],
		});
		expect(source).toBe(`${api} (Anthropic)`);
	});

	it("passes extra headers (direct mode) and falls back on bad limits", () => {
		const { models, model } = createAgentModels({
			...catalog,
			MODEL_API: "openai-completions",
			MODEL_HEADERS: '{"OpenAI-Organization":"org-1"}',
			MODEL_CONTEXT_WINDOW: "lots",
			MODEL_IMAGES: "false",
		});
		const m = models.getModel(model.provider, model.modelId);
		expect(m?.headers).toEqual({ "OpenAI-Organization": "org-1" });
		expect(m?.contextWindow).toBe(128_000);
		expect(m?.input).toEqual(["text"]);
	});

	it("keeps the platform-wide openai-compatible default", () => {
		const { models, model } = createAgentModels({
			MODEL_PROVIDER: "openai-compatible",
			MODEL_BASE_URL: "https://litellm.example.com/v1",
			MODEL_API_KEY: "k",
			MODEL_ID: "qwen",
		});
		const m = models.getModel(model.provider, model.modelId);
		expect(m?.api).toBe("openai-completions");
		expect(m?.compat).toMatchObject({ supportsStore: false, supportsDeveloperRole: false });
	});

	it("refuses an unknown API or provider", () => {
		expect(() => createAgentModels({ ...catalog, MODEL_API: "bedrock-converse-stream" })).toThrow(/Unsupported MODEL_API/);
		expect(() => createAgentModels({ MODEL_PROVIDER: "magic" })).toThrow(/Unknown MODEL_PROVIDER/);
		expect(() => createAgentModels({ ...catalog, MODEL_API: "openai-responses", MODEL_HEADERS: "[1]" })).toThrow(/JSON object/);
	});
});

describe("tool schemas sent to a Responses API server", () => {
	it("say strict: false, so optional fields stay optional (no strict default that makes the model fill them all)", async () => {
		const { createServer } = await import("node:http");
		const bodies: Record<string, unknown>[] = [];
		const server = createServer(async (req, res) => {
			let raw = "";
			for await (const chunk of req) raw += chunk;
			bodies.push(JSON.parse(raw));
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "test stops here" } }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		try {
			const port = (server.address() as { port: number }).port;
			const { models, model } = createAgentModels({ ...catalog, MODEL_API: "openai-responses", MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`, MODEL_API_KEY: "k" });
			const m = models.getModel(model.provider, model.modelId)!;
			const tool = {
				name: "search_tickets",
				description: "Search",
				parameters: { type: "object", properties: { search_text: { type: "string" }, ticket_id: { type: "integer" } }, required: [] },
			};
			const events = models.stream(m, { messages: [{ role: "user", content: "find VPN tickets", timestamp: 0 }], tools: [tool] } as never, { maxRetries: 0 } as never);
			for await (const _ of events) {
				// drain: the server answers 500 after recording the request
			}
			const sent = (bodies.at(-1)?.tools as { name: string; strict?: boolean; parameters: { required?: string[] } }[]) ?? [];
			expect(sent).toHaveLength(1);
			expect(sent[0]!.strict).toBe(false);
			expect(sent[0]!.parameters.required).toEqual([]);
		} finally {
			server.close();
		}
	});
});
