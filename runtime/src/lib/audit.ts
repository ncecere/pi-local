import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, type EntryRecord, type Extension, GenerationTask, type Harness, type HookApi, hook } from "@earendil-works/pi-durable";
import type { ApprovalRecord } from "./approvals.ts";
import { redactArguments } from "./redact.ts";

/**
 * The audit log's runtime half: each tool call is reported to the platform's gateway (`POST /activity`) when it ends,
 * batched, with the tool's name, a redacted view of its arguments, how it ended, how long it took and what was decided
 * about its approval. The platform keeps the log (internal/activity); this only tells it.
 *
 * Where calls end: pi-durable's `afterTool` hook runs only for calls that executed, and a call blocked by an approval,
 * refused by a rule or never run at all (unavailable, invalid arguments, interrupted) has no such hook. Every call of a
 * round, whichever way it ended, has a result entry by the time the generation task's `afterTools` hook runs, so that
 * is where they are read (the entry carries the outcome, the duration and the end time the tool task wrote). A stopped
 * run need not reach afterTools: the platform records cancelled/timed-out approvals as declined itself. Both paths
 * carry the durable approval ID so the platform keeps just one tool activity, even if a result arrives later.
 *
 * Reporting is best effort: a failure here never touches the run. A call whose report can't be delivered after a few
 * tries, or that is queued when the process dies, is not in the log.
 */

/** How a call ended: it ran (ok, or error), a rule or a person refused it (denied), or it asked and nobody decided (declined). */
export type ToolOutcome = "ok" | "error" | "denied" | "declined";

/** A tool call that ended, as the gateway's /activity takes it (internal/activity, ToolItem). */
export type ToolActivity = {
	/** The call's result entry in this agent's storage: names the call even where providers repeat call IDs. */
	entryId: string;
	callId: string;
	/** The thread whose run made the call (absent: a conversation no thread owns). */
	threadId?: string;
	tool: string;
	/** Bounded and redacted (redact.ts); the platform redacts again. */
	arguments: unknown;
	outcome: ToolOutcome;
	/** How long the tool ran (absent when it never ran). */
	durationMs?: number;
	/** When it ended (Unix ms). */
	endedAt: number;
	approval?: { id: string; status: ApprovalRecord["status"]; by?: string; source?: string; waitedMs?: number; reason?: string };
	/** What the model was told when the call failed or was refused (short). */
	error?: string;
};

type Post = (path: string, body: unknown) => Promise<void>;

export type ActivityReporterOptions = {
	/** How long a call waits for company before the batch is sent (default 1 s). */
	flushMs?: number;
	/** Calls per request (default 200, the most the gateway takes). */
	batch?: number;
	/** Calls kept while the platform can't be reached; the oldest go first (default 2,000). */
	maxQueued?: number;
	/** The first wait before sending a failed batch again; it doubles each time (default 1 s, five tries). */
	retryMs?: number;
};

/** Batches tool calls and sends them in order. */
export class ActivityReporter {
	private queue: ToolActivity[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private sending: Promise<void> = Promise.resolve();
	private stopped = false;
	private readonly flushMs: number;
	private readonly batch: number;
	private readonly maxQueued: number;
	private readonly retryMs: number;

	constructor(
		private readonly post: Post,
		options: ActivityReporterOptions = {},
	) {
		this.flushMs = options.flushMs ?? 1000;
		this.batch = options.batch ?? 200;
		this.maxQueued = options.maxQueued ?? 2000;
		this.retryMs = options.retryMs ?? 1000;
	}

	/** Queues a call that ended. */
	add(item: ToolActivity): void {
		if (this.stopped) return;
		this.queue.push(item);
		if (this.queue.length > this.maxQueued) this.queue.splice(0, this.queue.length - this.maxQueued);
		if (this.queue.length >= this.batch) void this.flush();
		else this.timer ??= setTimeout(() => void this.flush(), this.flushMs).unref();
	}

	/** Sends what is queued now; resolves once everything queued so far has been sent (or given up on). */
	flush(): Promise<void> {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		while (this.queue.length > 0) {
			const items = this.queue.splice(0, this.batch);
			this.sending = this.sending.then(() => this.deliver(items));
		}
		return this.sending;
	}

	/** Takes no more calls and sends what is left, trying once (the process is closing: no waiting to try again). */
	async stop(): Promise<void> {
		this.stopped = true;
		await this.flush();
	}

	private async deliver(items: ToolActivity[]): Promise<void> {
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				await this.post("/activity", { items });
				return;
			} catch (error) {
				if (this.stopped || attempt === 4) {
					console.error(`[runtime] reporting ${items.length} tool call(s) to the activity log failed:`, (error as Error).message);
					return;
				}
				await new Promise((r) => setTimeout(r, this.retryMs * 2 ** attempt));
			}
		}
	}
}

/** What the audit asks of the agent: the request made for a call, and the thread a conversation belongs to (a subagent's: its owner's). */
export interface AuditSources {
	approvalFor(conversationId: number, callId: string, taskId: number | undefined): ApprovalRecord | undefined;
	threadOf(conversationId: number): Promise<string | undefined>;
}

const ctx = BACKGROUND_CONTEXT;
const MAX_ERROR = 300;

/** The tool-call audit: an extension whose generation hook reports a round's calls to the reporter. */
export class ToolAudit {
	private harness: Harness | undefined;
	/** A conversation's thread never changes: asked once. */
	private readonly threads = new Map<number, string | undefined>();

	constructor(
		private readonly reporter: ActivityReporter,
		private readonly sources: AuditSources,
	) {}

	/** Connects the audit to the open agent. */
	bind(harness: Harness): void {
		this.harness = harness;
	}

	/** The library's extension: reports each round's calls once they are all terminal. Selected in every thread. */
	extension(): Extension {
		return defineExtension({
			name: "pdp-audit",
			hooks: [
				hook(GenerationTask, {
					afterTools: async (assistant: unknown, results: readonly unknown[], api: HookApi) => {
						try {
							await this.report(Number(assistant), results.map(Number), Number(api.conversationId));
						} catch (error) {
							console.error("[runtime] activity:", (error as Error).message);
						}
					},
				}),
			],
		});
	}

	/** Reports the calls of one round: `assistant` made them, `results` are their result entries. */
	async report(assistant: number, results: number[], conversationId: number): Promise<void> {
		const harness = this.harness;
		if (harness === undefined || results.length === 0) return;
		const conversation = await harness.conversation(conversationId as never, ctx);
		if (conversation === undefined) return;
		const ids = [assistant, ...results];
		const page = await conversation.entries(
			{ minEntryId: Math.min(...ids) as never, maxEntryId: Math.max(...ids) as never, order: "ascending" },
			500,
			undefined,
			ctx,
		);
		const byId = new Map(page.items.map((entry) => [Number(entry.id), entry]));
		const calls = new Map<string, { name: string; arguments: unknown }>();
		for (const message of byId.get(assistant)?.model ?? []) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, { name: block.name, arguments: block.arguments });
		}
		if (!this.threads.has(conversationId)) {
			const threadId = await this.sources.threadOf(conversationId).catch(() => undefined);
			if (threadId !== undefined) this.threads.set(conversationId, threadId);
		}
		const threadId = this.threads.get(conversationId);
		for (const id of results) {
			const entry = byId.get(id);
			const item = entry === undefined ? undefined : this.itemOf(entry, calls, conversationId, threadId);
			if (item !== undefined) this.reporter.add(item);
		}
	}

	private itemOf(entry: EntryRecord, calls: Map<string, { name: string; arguments: unknown }>, conversationId: number, threadId: string | undefined): ToolActivity | undefined {
		const message = entry.model?.find((m) => m.role === "toolResult");
		if (message?.role !== "toolResult") return undefined;
		const call = calls.get(message.toolCallId);
		const approval = this.sources.approvalFor(conversationId, message.toolCallId, entry.byTaskId === undefined ? undefined : Number(entry.byTaskId));
		const diagnostics = (entry.data as { diagnostics?: { severity?: string; code?: string; message?: string }[] } | undefined)?.diagnostics ?? [];
		const blocked = diagnostics.some((d) => d.code === "blocked");
		const outcome: ToolOutcome = blocked
			? approval !== undefined && (approval.status === "timed_out" || approval.status === "cancelled")
				? "declined"
				: "denied"
			: message.isError
				? "error"
				: "ok";
		// What went wrong: the harness's own error diagnostics ("Tool call blocked: denied by Bo"), else what the tool said.
		const said = diagnostics
			.filter((d) => d.severity === "error" && typeof d.message === "string")
			.map((d) => d.message)
			.join(" ");
		const text = (said !== "" ? said : message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ").replace(/<harness>|<\/harness>/g, " "))
			.replace(/\s+/g, " ")
			.trim();
		const item: ToolActivity = {
			entryId: String(entry.id),
			callId: message.toolCallId,
			tool: message.toolName,
			arguments: redactArguments(call?.arguments ?? {}),
			outcome,
			endedAt: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
		};
		if (threadId !== undefined) item.threadId = threadId;
		const duration = (message as { durationMs?: unknown }).durationMs;
		if (typeof duration === "number" && duration >= 0) item.durationMs = Math.round(duration);
		if (outcome !== "ok" && text !== "") item.error = text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}…` : text;
		if (approval !== undefined) {
			item.approval = {
				id: approval.id,
				status: approval.status,
				...(approval.decidedBy === undefined ? {} : { by: approval.decidedBy.name }),
				...(approval.source === undefined ? {} : { source: approval.source }),
				...(approval.reason === undefined ? {} : { reason: approval.reason }),
				...(approval.decidedAt === undefined ? {} : { waitedMs: Math.max(0, approval.decidedAt - approval.requestedAt) }),
			};
		}
		return item;
	}
}
