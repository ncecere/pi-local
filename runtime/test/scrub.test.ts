import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ARGUMENT_MARKS, isSecretValue, redactArguments, redactText } from "../src/lib/redact.ts";
import { environmentSecrets, installLogScrubbing, REDACTED, Scrubber, scrubEnabled, secretsFrom } from "../src/lib/scrub.ts";

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const none = (text: string) => new Scrubber({}).text(text);

describe("what looks like a credential", () => {
	it("hides tokens in free text, and leaves the rest of the line", () => {
		for (const [text, kept] of [
			[`token ${TOKEN} end`, "token [redacted secret] end"],
			[`the token is ${TOKEN}.`, "the token is [redacted secret]."],
			[`OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz stuff`, "OPENAI_API_KEY=[redacted secret] stuff"],
			[`Authorization: Bearer abcdefghij12345`, "Authorization: [redacted secret]"],
			[`{"apiKey":"hunter2","name":"x"}`, `{"apiKey":"[redacted secret]","name":"x"}`],
			[`GET https://user:pa55w0rd@host.example/p?api_key=abc123&x=1`, "GET https://user:[redacted secret]@host.example/p?api_key=[redacted secret]&x=1"],
			[`https://example.com/cb?state=1&code=${TOKEN}`, "https://example.com/cb?state=1&code=[redacted secret]"],
			["id eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk done", "id [redacted secret] done"],
			["random aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3hJ5kL7 here", "random [redacted secret] here"],
		] as const) {
			expect(none(text)).toBe(kept);
		}
	});

	it("hides a private key block whole", () => {
		const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabcdef\n-----END RSA PRIVATE KEY-----";
		expect(none(`key:\n${pem}\nafter`)).toBe(`key:\n${REDACTED}\nafter`);
	});

	it("leaves hashes, UUIDs, long paths, identifiers and prose alone", () => {
		for (const text of [
			"sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 ok",
			"commit 676b1d2e4a5c8f9d0b3a7e6c1f2d4b5a6c7e8f90 on main",
			"request 123e4567-e89b-12d3-a456-426614174000 ok",
			"/Users/Ann1/Library/Application Support/Pi Local/agents/ag_abcdefghijklmnop/workspace/Notes2024",
			"/Users/ann/Documents/ProjectAlphaBetaGammaDelta2024QuarterlyReport/final.pdf",
			"https://example.com/docs/ReleaseNotesForVersionTwoPointFiveBuild1234/index.html",
			"call getUserAccountSettingsByOrganizationId now",
			"A basic understanding of bearer authentication helps.",
			"token: true and password: false, secret=null",
			`"token": 5, "password": ""`,
			"pageToken=abc123 nextPageToken=abc123def456",
			"the agent woke up and answered in 2.4s",
		]) {
			expect(none(text), text).toBe(text);
		}
	});

	it("does not touch what is already hidden, and does the same twice", () => {
		const once = none(`key ${TOKEN} and password=hunter2hunter2`);
		expect(once).toBe(`key ${REDACTED} and password=${REDACTED}`);
		expect(none(once)).toBe(once);
	});

	it("is quick on a long line", () => {
		const line = "a1B2".repeat(50_000);
		const started = performance.now();
		none(`${line} ${"word ".repeat(20_000)}`);
		expect(performance.now() - started).toBeLessThan(2_000);
	});
});

describe("agreement with the approvals view", () => {
	const cases = JSON.parse(readFileSync(fileURLToPath(new URL("../../internal/agents/testdata/redact-text.json", import.meta.url)), "utf8")) as { name: string; text: string; want: string }[];
	const mask = (s: string) => s.replace(/\[redacted[^\]]*\]/g, "<R>");

	it("hides and keeps what the Go side does (the cases both read), under either mark", () => {
		expect(cases.length).toBeGreaterThan(20);
		for (const c of cases) {
			expect(mask(redactText(c.text, ARGUMENT_MARKS)), c.name).toBe(c.want);
			expect(mask(none(c.text)), c.name).toBe(c.want);
		}
	});

	it("scrubs every value the approvals view calls a secret", () => {
		for (const value of [
			"sk-proj-abcdefghijklmnopqrstuvwx",
			TOKEN,
			"Bearer abcdefgh12345678",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
			"AKIAABCDEFGHIJKLMNOP",
			"aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3hJ5kL7",
		]) {
			expect(isSecretValue(value), value).toBe(true);
			expect(none(`before ${value} after`), value).not.toContain(value.replace(/^Bearer /, ""));
		}
	});

	it("shows a credential inside a command as hidden in the approval's arguments", () => {
		const view = redactArguments({ command: `curl -H 'Authorization: Bearer abcdefghij12345' https://x.example/a`, cwd: "/tmp/work" }) as { command: string; cwd: string };
		expect(view.command).not.toContain("abcdefghij12345");
		expect(view.command).toContain("https://x.example/a");
		expect(view.cwd).toBe("/tmp/work");
	});
});

describe("the runtime's own secrets", () => {
	const mcp = JSON.stringify([
		{ slug: "gh", name: "GitHub", url: "https://mcp.example/gh", headers: { Authorization: "Bearer tok_live_zzzz1111", "X-Team": "alpha-team-42", "X-Api-Key": "plainish-key" } },
		{ slug: "fs", name: "Files", transport: "stdio", command: "node", env: { PLAIN: "production", WORKSPACE: "/Users/ann/work", PORT: "8080", NOTE: "hello world there", DB: "postgres://app:pa55-w0rd@db.local/x", TENANT: "7c1e0f3a9b2d4e6f8a0b1c2d" } },
	]);
	const env = { MODEL_API_KEY: "pdpm.agent.ABCDEFGH1234", PLATFORM_KEY: "pl.ag_x.0123456789abcdef", MODEL_USAGE_KEY: "pl.ag_x.usage-key-xyz", MCP_SERVERS: mcp, TOOL_APPROVALS: "{}", AGENT_NAME: "Hardac" };

	it("finds them by value: the keys and every env and header value of its MCP servers", () => {
		const found = environmentSecrets(env);
		// Named like a credential, looking like one, long and random, or a URL's password.
		for (const secret of ["pdpm.agent.ABCDEFGH1234", "pl.ag_x.0123456789abcdef", "pl.ag_x.usage-key-xyz", "tok_live_zzzz1111", "Bearer tok_live_zzzz1111", "plainish-key", "7c1e0f3a9b2d4e6f8a0b1c2d", "pa55-w0rd"]) {
			expect(found, secret).toContain(secret);
		}
		// Plain settings stay: hiding "production" would corrupt every tool output that says it. Flags, numbers, paths
		// and plain URLs are no credentials either.
		for (const not of ["alpha-team-42", "production", "hello world there", "8080", "/Users/ann/work", "https://mcp.example/gh", "Hardac", "{}"]) expect(found).not.toContain(not);
	});

	it("hides them wherever they show up in text, encoded or not, longest first", () => {
		const s = new Scrubber(env);
		expect(s.text("key is pdpm.agent.ABCDEFGH1234!")).toBe(`key is ${REDACTED}!`);
		expect(s.text("Authorization: Bearer tok_live_zzzz1111")).toBe(`Authorization: ${REDACTED}`);
		expect(s.text("sent tok_live_zzzz1111 and pl.ag_x.0123456789abcdef")).toBe(`sent ${REDACTED} and ${REDACTED}`);
		expect(s.text("postgres://app:pa55-w0rd@db.local/x")).not.toContain("pa55-w0rd");
		expect(s.text("?q=pa55-w0rd")).toBe(`?q=${REDACTED}`);
		expect(new Scrubber({ MODEL_API_KEY: 'a"b\\c-secret-1' }).text('{"k":"a\\"b\\\\c-secret-1"}')).toBe(`{"k":"${REDACTED}"}`);
		expect(new Scrubber({ MODEL_API_KEY: "has space&sign=1" }).text("x=has%20space%26sign%3D1")).toBe(`x=${REDACTED}`);
	});

	it("hides the provider's extra headers, but not the stand-in key of a keyless server", () => {
		const s = new Scrubber({ MODEL_API_KEY: "no-key", MODEL_HEADERS: JSON.stringify({ "X-Api-Key": "org-abc-123456", "X-Org": "acme-corp" }) });
		expect(s.text("no-key org-abc-123456 acme-corp")).toBe(`no-key ${REDACTED} acme-corp`);
	});

	it("leaves short values and non-secrets alone", () => {
		const s = new Scrubber({ MODEL_API_KEY: "abc", MCP_SERVERS: JSON.stringify([{ slug: "a", name: "A", env: { LEVEL: "info", PORT: "8080", ON: "true" } }]) });
		expect(s.text("info 8080 true abc")).toBe("info 8080 true abc");
		expect(secretsFrom("X", 5)).toEqual([]);
	});

	it("learns the secrets of servers apps give a thread, as they come", () => {
		const late: string[] = [];
		const s = new Scrubber({}, () => late);
		expect(s.text("value late-secret-123")).toBe("value late-secret-123");
		late.push("late-secret-123");
		expect(s.text("value late-secret-123")).toBe(`value ${REDACTED}`);
	});

	it("survives an MCP_SERVERS that isn't JSON", () => {
		expect(() => new Scrubber({ MCP_SERVERS: "{not json" })).not.toThrow();
	});
});

describe("results", () => {
	const s = new Scrubber({ MODEL_API_KEY: "pdpm.agent.ABCDEFGH1234" });

	it("scrubs text parts, details, structured output and diagnostics; images pass through", () => {
		const image = { type: "image", data: "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3hJ5kL7aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3hJ5kL7", mimeType: "image/png" };
		const result = s.result({
			output: [{ type: "text", text: `got ${TOKEN}` }, image],
			details: { path: "/tmp/x", token: "whatever-it-was", nested: [`pdpm.agent.ABCDEFGH1234`] },
			structuredOutput: { rows: [{ note: `password=hunter2hunter2` }] },
			diagnostics: [{ severity: "error", code: "tool_error", message: `failed with ${TOKEN}` }],
			isError: true,
		} as never) as unknown as Record<string, any>;
		expect(result.output[0].text).toBe(`got ${REDACTED}`);
		expect(result.output[1]).toBe(image);
		expect(result.details).toEqual({ path: "/tmp/x", token: REDACTED, nested: [REDACTED] });
		expect(result.structuredOutput).toEqual({ rows: [{ note: `password=${REDACTED}` }] });
		expect(result.diagnostics[0].message).toBe(`failed with ${REDACTED}`);
		expect(result.isError).toBe(true);
	});

	it("is on unless the agent turned it off", () => {
		expect(scrubEnabled({})).toBe(true);
		expect(scrubEnabled({ SCRUB_SECRETS: "true" })).toBe(true);
		expect(scrubEnabled({ SCRUB_SECRETS: "false" })).toBe(false);
	});
});

describe("logs", () => {
	it("cleans what console writes, always", () => {
		const lines: string[] = [];
		const fake = { log: (l: string) => lines.push(l), info: vi.fn(), warn: vi.fn(), error: (l: string) => lines.push(l), debug: vi.fn() } as unknown as Console;
		const undo = installLogScrubbing({ MODEL_API_KEY: "pdpm.agent.ABCDEFGH1234" }, fake);
		fake.log("model key pdpm.agent.ABCDEFGH1234 and", { token: TOKEN });
		fake.error("[runtime] failed", new Error(`bad Authorization: Bearer abcdefghij12345`));
		fake.error("%s is %d", "count", 3);
		undo();
		expect(lines[0]).toContain(REDACTED);
		expect(lines[0]).not.toContain("ABCDEFGH1234");
		expect(lines[0]).not.toContain("ghp_");
		expect(lines[1]).toContain("failed");
		expect(lines[1]).not.toContain("abcdefghij12345");
		expect(lines[2]).toBe("count is 3");
		expect(fake.log).not.toBe(undefined);
	});
});
