import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTool, type Extension, Type } from "./facade.ts";

/**
 * Tools for working with the person (PERSON_TOOLS=on):
 *  - `ask_person`: ask them a question and wait for the answer (a card in the conversation, the same as an MCP
 *    server's question; it waits up to 15 minutes, then the agent hears that nobody answered).
 *  - `notify_person`: a notification on their computer ("The report is ready.").
 *  - `todo`: a checklist the agent keeps while it works, shown beside the conversation (the `todo` document).
 */

export const PERSON_EXTENSION = "pdp-person";

export type TodoItem = { text: string; status: "pending" | "doing" | "done" };
export type TodoList = { items: TodoItem[] };

/** The conversation's checklist: exposed to the app (`todo`). Persisted protocol: never rename the kind. */
export const TodoDoc = defineDoc<TodoList>({
	kind: "todo",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ items: [] }),
});

export type PersonOptions = {
	gatewayUrl: string;
	key: string;
	threadOf: (conversationId: number) => Promise<string | undefined>;
	fetch?: typeof fetch;
};

function text(value: string, isError = false) {
	return { output: [{ type: "text" as const, text: value }], ...(isError ? { isError: true } : {}) };
}

const mark = (s: TodoItem["status"]) => (s === "done" ? "[x]" : s === "doing" ? "[~]" : "[ ]");

export function personExtension(options: PersonOptions): Extension {
	const doFetch = options.fetch ?? fetch;
	const base = options.gatewayUrl.replace(/\/$/, "");
	const headers = { authorization: `Bearer ${options.key}`, "content-type": "application/json" };
	async function call<T>(method: string, path: string, body: unknown, signal?: AbortSignal, timeoutMs = 15_000) {
		const signals = [AbortSignal.timeout(timeoutMs)];
		if (signal) signals.push(signal);
		const res = await doFetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any(signals) });
		const answer = (await res.json().catch(() => undefined)) as { data?: T; error?: { message?: string } } | undefined;
		if (res.ok && answer && "data" in answer) return { ok: true as const, data: answer.data as T };
		return { ok: false as const, status: res.status, message: answer?.error?.message ?? `The app refused (status ${res.status}).` };
	}

	const ask = defineTool({
		name: "ask_person",
		description:
			"Ask the person a question and wait for their answer, instead of guessing: a choice between options, a yes/no confirmation, or a short text answer. Use it when you need a decision or a fact only they know. It waits up to 15 minutes.",
		parameters: Type.Object({
			question: Type.String({ description: "The question, complete enough to answer without reading the conversation." }),
			choices: Type.Optional(Type.Array(Type.String(), { minItems: 2, maxItems: 8, description: "Options to choose from." })),
			yes_no: Type.Optional(Type.Boolean({ description: "A yes/no confirmation." })),
		}),
		execute: async (args, api, ctx: Context) => {
			const threadId = await options.threadOf(api.conversationId as unknown as number).catch(() => undefined);
			let schema: Record<string, unknown>;
			if (args.choices && args.choices.length >= 2) {
				schema = { type: "object", properties: { answer: { type: "string", title: "Your answer", enum: args.choices } }, required: ["answer"] };
			} else if (args.yes_no) {
				schema = { type: "object", properties: { yes: { type: "boolean", title: "Yes", default: false } }, required: ["yes"] };
			} else {
				schema = { type: "object", properties: { answer: { type: "string", title: "Your answer", maxLength: 2000 } }, required: ["answer"] };
			}
			const created = await call<{ id: string }>("POST", "/person/ask", { message: args.question, requestedSchema: schema, threadId: threadId ?? "" }, ctx.abortSignal);
			if (!created.ok) return text(created.message, true);
			const id = created.data.id;
			const withdraw = () => void doFetch(`${base}/mcp/elicitations/${encodeURIComponent(id)}`, { method: "DELETE", headers }).catch(() => {});
			ctx.abortSignal?.addEventListener("abort", withdraw, { once: true });
			try {
				for (;;) {
					const res = await call<{ done: boolean; action?: string; content?: Record<string, unknown> }>(
						"GET",
						`/mcp/elicitations/${encodeURIComponent(id)}?wait=25`,
						undefined,
						ctx.abortSignal,
						35_000,
					);
					if (!res.ok) return text(res.status === 404 ? "The question was withdrawn (the app restarted or the agent slept); ask again if you still need the answer." : res.message, true);
					if (!res.data.done) continue;
					const { action, content } = res.data;
					if (action === "accept") {
						if (args.yes_no && !args.choices) return text(content?.yes === true ? "They answered: yes." : "They answered: no.");
						return text(`They answered: ${String(content?.answer ?? "")}`);
					}
					if (action === "decline") return text(args.yes_no ? "They answered: no." : "They declined to answer.");
					return text("Nobody answered (the question expired or was dismissed). Carry on without it, or ask again later.");
				}
			} finally {
				ctx.abortSignal?.removeEventListener("abort", withdraw);
			}
		},
	});

	const notify = defineTool({
		name: "notify_person",
		description:
			"Send the person a notification on their computer: for something worth interrupting them for, like finished long work or a problem that needs them. Keep it to one short sentence. Rate-limited.",
		parameters: Type.Object({
			title: Type.String({ description: "A few words." }),
			message: Type.String({ description: "One short sentence." }),
		}),
		execute: async (args, api, ctx: Context) => {
			const threadId = await options.threadOf(api.conversationId as unknown as number).catch(() => undefined);
			const res = await call<{ sent: boolean }>("POST", "/person/notify", { title: args.title, message: args.message, threadId: threadId ?? "" }, ctx.abortSignal);
			if (!res.ok) return text(res.message, true);
			return text("Notification sent.");
		},
	});

	const todo = defineTool({
		name: "todo",
		description:
			"Keep a checklist for the current task, shown to the person beside the conversation: write the whole list each time, each item pending, doing or done. Use it for work with several steps; keep one item doing at a time.",
		parameters: Type.Object({
			items: Type.Array(
				Type.Object({
					text: Type.String(),
					status: Type.Union([Type.Literal("pending"), Type.Literal("doing"), Type.Literal("done")]),
				}),
				{ maxItems: 30 },
			),
		}),
		replay: "safe",
		execute: async (args, api, ctx: Context) => {
			const items = args.items.map((i) => ({ text: i.text.trim().slice(0, 300), status: i.status })).filter((i) => i.text !== "");
			await api.commit(async (tx) => {
				const doc = await tx.doc(TodoDoc, api.conversationId);
				doc.items = items;
			}, ctx);
			const done = items.filter((i) => i.status === "done").length;
			return { output: [{ type: "text", text: `Checklist (${done}/${items.length} done):\n${items.map((i) => `${mark(i.status)} ${i.text}`).join("\n")}` }], details: { items } };
		},
	});

	return defineExtension({ name: PERSON_EXTENSION, tools: [ask, notify, todo] });
}
