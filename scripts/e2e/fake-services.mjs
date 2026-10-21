#!/usr/bin/env node
// Fake services for end-to-end QA (no keys, no network):
//
//   node scripts/e2e/fake-services.mjs [modelPort=5185] [judgePort=5186] [searchPort=5187]
//
// - An OpenAI-compatible model server (http://127.0.0.1:<modelPort>/v1): models fake-fast and fake-smart. It answers
//   in Markdown and calls tools when asked in plain words (only tools the request offers):
//     "remember that …"            → remember {about: "you"}        "note to self …"   → remember {about: "myself"}
//     "what do you know about me"  → recall                          "forget …"         → forget
//     "search the web for …"       → web_search                      "fetch https://…"  → web_fetch
//     "ask me …" / "confirm …"     → ask_person (choices / yes-no)   "notify me …"      → notify_person
//     "make a checklist"           → todo                            "read <path>"      → read
//     "write <path>: <text>"       → write                           "run <command>"    → bash
//     "ask <agent>: <question>"    → ask_agent                       "list agents"      → list_agents
//     "remind me …" / "every day"  → schedule                        "what time"        → get_time
//     "call <tool> <json>"         → any tool, exactly
//     "long answer"                → a slow, long reply (to try steering and stopping)
//     "fail"                       → a 500 from the model (to see errors)
//   After a tool result it says what the tool answered.
// - A TypeSafe System One stand-in (http://127.0.0.1:<judgePort>): POST /v1/systemone answers choice questions by
//   word overlap (agent routing, tool preselection), GET /v1/models lists jev-1.14.0.
// - A SearXNG stand-in (http://127.0.0.1:<searchPort>): /search?format=json returns three canned results.

import { createServer } from "node:http";

const [modelPort = 5185, judgePort = 5186, searchPort = 5187] = process.argv.slice(2).map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

function readBody(req) {
	return new Promise((resolve) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			try {
				resolve(JSON.parse(raw || "{}"));
			} catch {
				resolve({});
			}
		});
	});
}

const json = (res, status, body) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};

function textOf(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
	return "";
}

function imagesIn(content) {
	return Array.isArray(content) ? content.filter((p) => p.type === "image_url").length : 0;
}

// ——— the model ———

function decide(body) {
	const messages = body.messages ?? [];
	const last = messages.at(-1) ?? {};
	const tools = new Set((body.tools ?? []).map((t) => t.function?.name).filter(Boolean));
	const model = body.model ?? "fake";
	const thinking = body.reasoning_effort ?? "off";
	if (last.role === "tool") {
		const out = textOf(last.content).trim();
		return { text: `Done. The tool answered:\n\n> ${out.slice(0, 600).replace(/\n/g, "\n> ")}${out.length > 600 ? " …" : ""}` };
	}
	const said = textOf(last.content);
	// The person's words: after a "[Message from …]" speaker line, before an attachments block.
	const words = said.replace(/^\[Message from [^\]]*\]\n/, "").split("\nAttached files (in your workspace):")[0].trim();
	const lower = words.toLowerCase();
	const tool = (name, args) => (tools.has(name) ? { tool: name, args } : { text: `I'd use \`${name}\` for that, but I don't have it. (Turn it on in my Tools settings.)` });
	let m;
	if (lower === "fail") return { fail: true };
	if ((m = /^call (\w+)\s*(\{[\s\S]*\})?$/i.exec(words))) return tool(m[1], m[2] ? JSON.parse(m[2]) : {});
	if ((m = /^remember(?: that)?[:\s]+(.+)/is.exec(words))) return tool("remember", { about: "you", text: m[1].trim(), source: "person" });
	if ((m = /^note to self[:\s]+(.+)/is.exec(words))) return tool("remember", { about: "myself", text: m[1].trim() });
	if (/what do you know about me|what do you remember/i.test(words)) return tool("recall", { query: "" });
	if ((m = /^forget[:\s]+(.+)/is.exec(words))) return tool("forget", { query: m[1].trim() });
	if ((m = /search the web for[:\s]+(.+)/is.exec(words))) return tool("web_search", { query: m[1].trim() });
	if ((m = /fetch (https?:\/\/\S+)/i.exec(words))) return tool("web_fetch", { url: m[1] });
	if ((m = /^confirm[:\s]*(.*)/is.exec(words))) return tool("ask_person", { question: m[1].trim() || "Shall I go ahead?", yes_no: true });
	if ((m = /^ask me[:\s]*(.*)/is.exec(words))) return tool("ask_person", { question: m[1].trim() || "Which do you prefer?", choices: ["Morning", "Afternoon", "Evening"] });
	if ((m = /notify me[:\s]*(.*)/is.exec(words))) return tool("notify_person", { title: "Done", message: m[1].trim() || "The work you asked for is finished." });
	if (/checklist|to-?do list/i.test(words)) {
		return tool("todo", { items: [{ text: "Read the brief", status: "done" }, { text: "Draft the outline", status: "doing" }, { text: "Write it up", status: "pending" }] });
	}
	if ((m = /^read (\S+)/i.exec(words))) return tool("read", { path: m[1] });
	if ((m = /^write (\S+?):\s*([\s\S]+)/i.exec(words))) return tool("write", { path: m[1], content: m[2] });
	if ((m = /^run (.+)/is.exec(words))) return tool("bash", { command: m[1].trim() });
	if (/^list agents/i.test(words)) return tool("list_agents", {});
	if ((m = /^ask ([^:]+):\s*(.+)/is.exec(words))) return tool("ask_agent", { agent: m[1].trim(), message: m[2].trim() });
	if ((m = /^remind me (?:to )?(.+)/is.exec(words))) {
		const at = new Date(Date.now() + 2 * 60_000).toISOString().slice(0, 16);
		return tool("schedule", { when: at, message: m[1].trim(), name: "Reminder" });
	}
	if ((m = /^every day[:\s]+(.+)/is.exec(words))) return tool("schedule", { when: "0 9 * * *", message: m[1].trim(), name: "Daily", thread: "new" });
	if (/what time|the date/i.test(words)) return tool("get_time", {});
	if (/long answer/i.test(words)) {
		const para = "This is a long, slow reply so you can try steering or stopping it while it streams. ";
		return { text: Array.from({ length: 30 }, (_, i) => `${i + 1}. ${para}`).join("\n"), slow: true };
	}
	const images = imagesIn(last.content);
	const attached = said.includes("Attached files (in your workspace):") ? said.split("Attached files (in your workspace):")[1].trim().split("\n").length : 0;
	return {
		text:
			`Fake model **${model}** here (thinking: ${thinking}).\n\n` +
			`You said: _${words.slice(0, 300) || "(nothing, just files)"}_\n\n` +
			(attached ? `- Files attached: ${attached}\n` : "") +
			(images ? `- Images I can see: ${images}\n` : "") +
			"\nTry: `remember that …`, `search the web for …`, `ask me …`, `make a checklist`, `long answer`.",
	};
}

function sse(res, data) {
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function chat(req, res) {
	const body = await readBody(req);
	const model = body.model ?? "fake";
	const d = decide(body);
	if (d.fail) return json(res, 500, { error: { message: "The fake model failed on purpose." } });
	const id = `c${++calls}`;
	if (!body.stream) {
		const message = d.tool
			? { role: "assistant", content: null, tool_calls: [{ id: `call_${calls}`, type: "function", function: { name: d.tool, arguments: JSON.stringify(d.args) } }] }
			: { role: "assistant", content: d.text };
		return json(res, 200, {
			id,
			object: "chat.completion",
			model,
			choices: [{ index: 0, message, finish_reason: d.tool ? "tool_calls" : "stop" }],
			usage: { prompt_tokens: 400, completion_tokens: 60, total_tokens: 460 },
		});
	}
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	if (d.tool) {
		await sleep(150);
		sse(res, {
			id,
			object: "chat.completion.chunk",
			model,
			choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: d.tool, arguments: JSON.stringify(d.args) } }] }, finish_reason: null }],
		});
		sse(res, { id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
	} else {
		const pieces = d.text.split(/(?<= )/);
		for (let i = 0; i < pieces.length; i++) {
			if (res.destroyed) return;
			sse(res, { id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { ...(i === 0 ? { role: "assistant" } : {}), content: pieces[i] }, finish_reason: null }] });
			await sleep(d.slow ? 60 : 8);
		}
		sse(res, { id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
	}
	sse(res, { id, object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 400, completion_tokens: 60, total_tokens: 460 } });
	res.end("data: [DONE]\n\n");
}

createServer(async (req, res) => {
	const url = new URL(req.url, "http://x");
	if (req.method === "GET" && url.pathname.endsWith("/models")) {
		return json(res, 200, { object: "list", data: ["fake-fast", "fake-smart"].map((id) => ({ id, object: "model", owned_by: "fake" })) });
	}
	if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) return chat(req, res);
	json(res, 404, { error: { message: `no ${req.method} ${url.pathname}` } });
}).listen(modelPort, "127.0.0.1", () => console.log(`fake model   http://127.0.0.1:${modelPort}/v1  (fake-fast, fake-smart)`));

// ——— the judge (System One) ———

const tokens = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
function overlap(a, b) {
	let n = 0;
	for (const t of a) if (b.has(t)) n++;
	return n;
}

createServer(async (req, res) => {
	const url = new URL(req.url, "http://x");
	if (req.method === "GET" && url.pathname === "/v1/models") return json(res, 200, { models: [{ name: "jev-1.14.0" }] });
	if (req.method === "POST" && url.pathname === "/v1/systemone") {
		const body = await readBody(req);
		const stateWords = tokens(JSON.stringify(body.state ?? {}));
		const answers = {};
		for (const [name, q] of Object.entries(body.questions ?? {})) {
			if (q.type === "choice") {
				const scores = Object.entries(q.criteria ?? {}).map(([option, meaning]) => [option, overlap(stateWords, tokens(meaning)) + 0.2]);
				const total = scores.reduce((s, [, v]) => s + v, 0) || 1;
				const probabilities = Object.fromEntries(scores.map(([o, v]) => [o, v / total]));
				const [choice, best] = scores.sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
				answers[name] = { type: "choice", choice, confidence: best / total, probabilities };
			} else {
				answers[name] = { type: "noul", noul: overlap(stateWords, tokens(q.instructions)) > 2 ? 0.8 : 0.3 };
			}
		}
		return json(res, 200, { model: body.model ?? "jev-1.14.0", answers });
	}
	json(res, 404, { error: "not found" });
}).listen(judgePort, "127.0.0.1", () => console.log(`fake judge   http://127.0.0.1:${judgePort}   (System One, jev-1.14.0)`));

// ——— web search (SearXNG) ———

createServer((req, res) => {
	const url = new URL(req.url, "http://x");
	if (url.pathname === "/search") {
		const q = url.searchParams.get("q") ?? "";
		return json(res, 200, {
			query: q,
			results: [1, 2, 3].map((i) => ({
				title: `Result ${i} for ${q}`,
				url: `https://example.com/${encodeURIComponent(q)}/${i}`,
				content: `A canned search result (${i}) about ${q}, from the fake SearXNG.`,
			})),
		});
	}
	json(res, 404, { error: "not found" });
}).listen(searchPort, "127.0.0.1", () => console.log(`fake search  http://127.0.0.1:${searchPort}  (SearXNG)`));
