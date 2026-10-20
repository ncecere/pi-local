// Custom state reaching apps: a tool's `details` in the thread view and its event streams, exposed documents (read,
// bounded, announced when they change), and the upgrade check before the storage is opened.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	AgentDefinitionError,
	applyDelta,
	type ChatView,
	type DeltaEvent,
	defineAgent,
	defineDoc,
	defineExtension,
	defineTool,
	MAX_DETAILS_BYTES,
	CONTRACT_VERSION, PI_DURABLE_VERSION,
	Type,
} from "@pdp/runtime";
import { fakeModel, gate, startTestAgent, type TestAgent, toolCall } from "@pdp/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { DeltaStream } from "../src/lib/delta.ts";

const running: TestAgent[] = [];
const servers: Server[] = [];
afterEach(async () => {
	while (running.length > 0) await running.pop()!.close();
	while (servers.length > 0) servers.pop()!.close();
});
const start = async (...args: Parameters<typeof startTestAgent>) => {
	const agent = await startTestAgent(...args);
	running.push(agent);
	return agent;
};

const Board = defineDoc<{ cards: string[] }>({ kind: "acme.board", version: 2, scope: "conversation", history: "latest", fork: "current", initial: () => ({ cards: [] }) });
const Hidden = defineDoc<{ secret: string }>({ kind: "acme.hidden", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ secret: "s3cret" }) });
const Shared = defineDoc<{ n: number }>({ kind: "acme.shared", version: 1, scope: "session", initial: () => ({ n: 0 }) });

/** `add_card` writes the board; its result carries details for UIs. `huge` returns details over the bound. */
const add = defineTool({
	name: "add_card",
	description: "Add a card",
	parameters: Type.Object({ text: Type.String() }),
	replay: "safe",
	execute: async ({ text }, api, context) => {
		await api.details({ adding: text }, context);
		await api.commit(async (tx) => {
			const board = await tx.doc(Board, api.conversationId);
			if (!board.cards.includes(text)) board.cards.push(text);
		}, context);
		return { output: [{ type: "text", text: "Added." }], details: { card: text, total: 1 } };
	},
});
const huge = defineTool({
	name: "huge",
	description: "Big details",
	parameters: Type.Object({}),
	execute: async () => ({ output: [{ type: "text", text: "big" }], details: { blob: "x".repeat(MAX_DETAILS_BYTES + 10) } }),
});
const boardAgent = (maxBytes?: number) =>
	defineAgent({
		documents: [Board, Hidden],
		expose: [maxBytes === undefined ? Board : { document: Board, maxBytes }],
		extensions: [defineExtension({ name: "board", tools: [add, huge] })],
	});

describe("exposing documents", () => {
	it.each([
		["a session document", { documents: [Shared], expose: [Shared as never] }, /only conversation documents/],
		["an undeclared document", { documents: [], expose: [Board] }, /not listed in documents/],
		["a bound over 1 MiB", { documents: [Board], expose: [{ document: Board, maxBytes: 2 * 1024 * 1024 }] }, /maxBytes/],
		["a bound of zero", { documents: [Board], expose: [{ document: Board, maxBytes: 0 }] }, /maxBytes/],
		["one document twice", { documents: [Board], expose: [Board, Board] }, /exposed twice/],
	])("refuses %s", (_what, definition, message) => {
		expect(() => defineAgent(definition as never)).toThrow(AgentDefinitionError);
		expect(() => defineAgent(definition as never)).toThrow(message);
	});
});

describe("details", () => {
	it("puts a tool's details on its result in the view, and leaves out details over the bound", async () => {
		const model = fakeModel();
		model.reply(toolCall("add_card", { text: "milk" }, { id: "c1" }), toolCall("huge", {}, { id: "c2" }), "Done.");
		const agent = await start(boardAgent(), { model });
		await agent.send("t", "add milk");
		const view = await agent.settled("t");
		const results = view.messages.filter((m) => m.role === "tool");
		expect(results[0]).toMatchObject({ toolCallId: "c1", details: { card: "milk", total: 1 } });
		expect(results[1]).toMatchObject({ toolCallId: "c2", detailsOmitted: true });
		expect(results[1]).not.toHaveProperty("details");
	});

	it("shows running details on the current round's tool, and sends them as delta events", async () => {
		const inTool = gate();
		const slow = defineTool({
			name: "slow",
			description: "Slow",
			parameters: Type.Object({}),
			execute: async (_args, api, context) => {
				await api.details({ step: 1 }, context);
				await inTool.wait(context);
				return { output: [{ type: "text", text: "slow done" }], details: { step: 2 } };
			},
		});
		const model = fakeModel();
		model.reply(toolCall("slow", {}, { id: "s1" }), "Done.");
		const agent = await start(defineAgent({ extensions: [defineExtension({ name: "slow", tools: [slow] })] }), { model });
		await agent.send("t", "go");
		await inTool.reached;
		const events = streamEvents(agent, "t");
		let view: ChatView | undefined;
		for (let i = 0; i < 100 && view?.tools[0]?.details === undefined; i++) {
			view = await agent.view("t");
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(view?.tools[0]).toMatchObject({ callId: "s1", details: { step: 1 } });
		inTool.open();
		const settled = await agent.settled("t");
		// Applying the stream's events gives the settled view, details included.
		const seen = await events.until((held) => held?.messages.length === settled.messages.length && !held.busy);
		expect(seen.messages.find((m) => m.role === "tool")).toMatchObject({ details: { step: 2 } });
		// The running details reached the stream before the result's (in its snapshot or a tool event).
		expect(JSON.stringify(events.all)).toContain('"details":{"step":1}');
		events.close();
	});

	it("diffs details changes of a running tool", () => {
		const base: ChatView = { busy: true, messages: [], tools: [{ callId: "a", name: "t", status: "running" }] };
		const stream = new DeltaStream(undefined, 0, () => 1000);
		stream.next(base);
		const steps: ChatView[] = [
			{ ...base, tools: [{ callId: "a", name: "t", status: "running", details: { n: 1 } }] },
			{ ...base, tools: [{ callId: "a", name: "t", status: "running", detailsOmitted: true }] },
			{ ...base, tools: [{ callId: "a", name: "t", status: "done", details: { n: 2 } }] },
		];
		let held: ChatView | undefined = base;
		for (const step of steps) {
			const events = stream.next(step);
			expect(events.length).toBe(1);
			for (const event of events) held = applyDelta(held, event);
			expect(held).toEqual(step);
		}
	});
});

describe("documents for apps", () => {
	it("reads an exposed document; others, and missing threads, are not found", async () => {
		const model = fakeModel();
		model.reply(toolCall("add_card", { text: "milk" }, { id: "c1" }), "Done.");
		const agent = await start(boardAgent(), { model });
		await agent.send("t", "add milk");
		await agent.settled("t");
		const doc = await agent.document("t", "acme.board");
		expect(doc).toMatchObject({ kind: "acme.board", version: 2, value: { cards: ["milk"] } });
		expect(doc!.revision).toMatch(/^[A-Za-z0-9_-]{22}$/);
		// Declared but not exposed, built-in, unknown: all the same answer.
		for (const kind of ["acme.hidden", "pi.live", "pdp.threads", "acme.nothing", "bad kind"]) expect(await agent.document("t", kind)).toBeUndefined();
		expect(await agent.document("nope", "acme.board")).toBeUndefined();
		const view = await agent.view("t");
		expect(view?.documents).toEqual({ "acme.board": { revision: doc!.revision } });
	});

	it("refuses a document over its bound", async () => {
		const model = fakeModel();
		model.reply(toolCall("add_card", { text: "a long card text" }, { id: "c1" }), "Done.");
		const agent = await start(boardAgent(20), { model });
		await agent.send("t", "add");
		await agent.settled("t");
		const res = await fetch(`${agent.baseUrl}/threads/t/documents/acme.board`, { headers: { authorization: `Bearer ${agent.token}` } });
		expect(res.status).toBe(422);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("document_too_large");
	});

	it("says in both stream formats when a document changes", async () => {
		const model = fakeModel();
		const agent = await start(boardAgent(), { model });
		await agent.send("t", "hello");
		await agent.settled("t");
		const first = (await agent.document("t", "acme.board"))!;
		const deltas = streamEvents(agent, "t");
		const views = streamViews(agent, "t");
		await deltas.until((held) => held?.documents?.["acme.board"]?.revision === first.revision);
		model.reply(toolCall("add_card", { text: "eggs" }, { id: "c2" }), "Done.");
		await agent.send("t", "add eggs");
		await agent.settled("t");
		const second = (await agent.document("t", "acme.board"))!;
		expect(second.revision).not.toBe(first.revision);
		await deltas.until((held) => held?.documents?.["acme.board"]?.revision === second.revision);
		expect(deltas.all).toContainEqual(expect.objectContaining({ type: "document.updated", kind: "acme.board", revision: second.revision }));
		await views.until((view) => view.documents?.["acme.board"]?.revision === second.revision);
		deltas.close();
		views.close();
	});
});


/** Follows a thread's delta stream (the thread must exist), applying its events. */
function streamEvents(agent: TestAgent, threadId: string) {
	const abort = new AbortController();
	const all: DeltaEvent[] = [];
	let held: ChatView | undefined;
	void (async () => {
		const res = await fetch(`${agent.baseUrl}/threads/${threadId}/events?format=delta`, { headers: { authorization: `Bearer ${agent.token}` }, signal: abort.signal });
		await readSse(res, (event, data) => {
			if (event === "") return;
			const parsed = JSON.parse(data) as DeltaEvent;
			all.push(parsed);
			held = applyDelta(held, parsed);
		}).catch(() => {});
	})();
	return {
		all,
		until: async (ready: (held: ChatView | undefined) => boolean): Promise<ChatView> => {
			const deadline = Date.now() + 10_000;
			while (!ready(held)) {
				if (Date.now() > deadline) throw new Error(`the stream never got there: ${JSON.stringify(held)?.slice(0, 500)}`);
				await new Promise((r) => setTimeout(r, 20));
			}
			return held!;
		},
		close: () => abort.abort(),
	};
}

/** Follows a thread's whole-view stream. */
function streamViews(agent: TestAgent, threadId: string) {
	const abort = new AbortController();
	let last: ChatView | undefined;
	void (async () => {
		const res = await fetch(`${agent.baseUrl}/threads/${threadId}/events`, { headers: { authorization: `Bearer ${agent.token}` }, signal: abort.signal });
		await readSse(res, (event, data) => {
			if (event === "view") last = JSON.parse(data) as ChatView;
		}).catch(() => {});
	})();
	return {
		until: async (ready: (view: ChatView) => boolean) => {
			const deadline = Date.now() + 10_000;
			while (last === undefined || !ready(last)) {
				if (Date.now() > deadline) throw new Error("the view stream never got there");
				await new Promise((r) => setTimeout(r, 20));
			}
			return last;
		},
		close: () => abort.abort(),
	};
}

async function readSse(res: Response, onEvent: (event: string, data: string) => void): Promise<void> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		buffer += decoder.decode(value, { stream: true });
		let end: number;
		while ((end = buffer.indexOf("\n\n")) >= 0) {
			const block = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			let event = "";
			let data = "";
			for (const line of block.split("\n")) {
				if (line.startsWith("event: ")) event = line.slice(7);
				else if (line.startsWith("data: ")) data += line.slice(6);
			}
			if (data !== "") onEvent(event, data);
		}
	}
}
