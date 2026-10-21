import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import { type CallIdentities, callInstance, entryMessageId, taskIdentity } from "./call-identity.ts";

/**
 * Who sent a user message, as the platform says (never as its client says): a person, a service account, or a trigger
 * (an unattended run the platform started). `via`: the app a person used.
 */
export type Author = { kind: "user" | "service_account" | "trigger" | "agent"; id: string; name: string; via?: string };

/** The author kinds the platform sends. */
export const AUTHOR_KINDS: ReadonlySet<string> = new Set(["user", "service_account", "trigger", "agent"]);

/**
 * The entry a user message is placed as: pi's user message (what the model sees, which may start with a line naming
 * the speaker) plus `data`, what the transcript shows: the text as sent, when, and by whom.
 */
export const USER_ENTRY = "pdp.user";
export type UserEntryData = { text: string; at: number; author?: Author; requestId?: string; attachments?: ChatAttachment[] };
/** A file sent with a message: saved in the agent's workspace (path relative to it). */
export type ChatAttachment = { path: string; name: string; size: number; mediaType: string };
/** The most files one message may carry. */
export const MAX_ATTACHMENTS = 20;

/** The chat view the platform relays to clients: transcript plus the reply in progress. */
export type ChatView = {
	busy: boolean;
	messages: ChatMessage[];
	/** The assistant reply being generated, if any. */
	partial?: ChatPartial;
	/** Tool calls of the current round. */
	tools: ChatTool[];
	/**
	 * Paged reads only (`limit` or `before` given): pass it as `before` for the earlier messages. Absent when there are
	 * none, and on unpaged reads.
	 */
	earlierCursor?: string;
	/**
	 * The documents the agent exposes to apps (docs/custom-agents.md, Documents for apps) that exist in this thread, by
	 * kind, with each one's revision: it changes when the document does (read it with
	 * `GET /threads/{thread}/documents/{kind}`). Absent when the agent exposes none.
	 */
	documents?: Record<string, ChatDocumentRef>;
	/**
	 * Tool calls of this thread waiting for a person's approval (docs/approvals.md), with a redacted view of their
	 * arguments; calls in a subagent's conversation too. Absent when there are none.
	 */
	approvals?: ChatApproval[];
};

/** An exposed document in the view: its revision (a hash of its content; equal content, equal revision). */
export type ChatDocumentRef = { revision: string };

export type ChatPartial = { text: string; thinking: string };
/**
 * A tool call of the current round. `details`: what the tool published for UIs so far (its last `api.details()`),
 * JSON, at most MAX_DETAILS_BYTES; `detailsOmitted` says it was larger and left out.
 */
export type ChatTool = { callId: string; instanceId?: string; taskId?: string; name: string; status: string; output?: string } & ChatDetails;

/** A tool's `details` (pi-durable's channel for UIs), bounded: see boundedDetails. */
export type ChatDetails = { details?: unknown; detailsOmitted?: true };

/** The most a tool's details may take in the view, as JSON (larger ones are left out, with `detailsOmitted`). */
export const MAX_DETAILS_BYTES = 16 * 1024;

/** A tool's details as the view carries them: JSON only, at most MAX_DETAILS_BYTES, else omitted (and said so). */
export function boundedDetails(value: unknown): ChatDetails {
	if (value === undefined || value === null) return {};
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch {
		return { detailsOmitted: true };
	}
	if (json === undefined) return {};
	if (Buffer.byteLength(json, "utf8") > MAX_DETAILS_BYTES) return { detailsOmitted: true };
	return { details: value };
}

export type ChatToolCall = { id: string; instanceId?: string; taskId?: string; name: string; arguments: unknown; startedAt?: number; endedAt?: number; approval?: ChatApproval };

/**
 * A request to approve a tool call: pending, or how it was decided. On a transcript's tool call (without `arguments`,
 * which the call has) and in the view's pending list.
 */
export type ChatApproval = {
	id: string;
	/** Opaque durable task identity; provider call IDs may repeat. */
	taskId?: string;
	callId: string;
	tool: string;
	status: "pending" | "approved" | "denied" | "timed_out" | "cancelled";
	requestedAt: number;
	expiresAt?: number;
	summary?: string;
	/** What asked: "builtin" or "rule" (an approval rule), "profile", "tools", "judge" (fast judgments), "author". */
	source?: string;
	requestedFor?: Author;
	decidedAt?: number;
	decidedBy?: { kind: "user" | "service_account" | "system"; id?: string; name: string };
	reason?: string;
	arguments?: unknown;
};

/** A thread's approvals, indexed by durable tool task (never by provider call ID). */
export type ViewApprovals = { byTask: ReadonlyMap<string, ChatApproval>; pending: ChatApproval[] };
export type ChatUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };

/** `at`: Unix milliseconds (a user message's sending, an assistant reply's start). */
export type ChatMessage =
	| { id: string; role: "user"; text: string; author?: Author; at?: number; requestId?: string; attachments?: ChatAttachment[] }
	| {
			id: string;
			role: "assistant";
			text: string;
			thinking?: string;
			toolCalls?: ChatToolCall[];
			error?: string;
			at?: number;
			model?: { provider: string; id: string };
			usage?: ChatUsage;
			stopReason?: string;
	  }
	| ({ id: string; role: "tool"; toolCallId: string; instanceId?: string; taskId?: string; name: string; text: string; isError: boolean; at?: number } & ChatDetails);

export function buildView(
	entries: readonly EntryRecord[],
	live: Readonly<LiveState> | undefined,
	documents?: Record<string, ChatDocumentRef>,
	approvals?: ViewApprovals,
	identities?: CallIdentities,
): ChatView {
	return {
		busy: live?.run !== undefined,
		messages: buildMessages(entries, approvals?.byTask, identities),
		...liveParts(live, identities),
		...(documents === undefined ? {} : { documents }),
		...(approvals === undefined || approvals.pending.length === 0 ? {} : { approvals: approvals.pending }),
	};
}

/**
 * The transcript part of the view: it changes only when entries (or the approvals on its calls) do; the delta stream
 * reuses it otherwise.
 */
export function buildMessages(entries: readonly EntryRecord[], approvals?: ReadonlyMap<string, ChatApproval>, identities?: CallIdentities): ChatMessage[] {
	// End times belong to the durable call occurrence, not every reuse of its provider ID.
	const resultAt = new Map<string, number>();
	for (const entry of entries) {
		(entry.model ?? []).forEach((message, index) => {
			const source = identities?.results.get(entryMessageId(entry, index));
			if (source !== undefined && message.role === "toolResult" && typeof message.timestamp === "number") resultAt.set(source, message.timestamp);
		});
	}
	const messages: ChatMessage[] = [];
	for (const entry of entries) {
		if (entry.kind === "pi.system" || entry.kind === "pi.compaction") continue;
		const data = entry.kind === USER_ENTRY ? userData(entry.data) : undefined;
		(entry.model ?? []).forEach((message, index) => {
			const id = entryMessageId(entry, index);
			const converted = convert(id, message as Message, resultAt, approvals, identities);
			if (converted === undefined) return;
			if (converted.role === "user" && data !== undefined) {
				// The text as sent: the model's copy may start with a line naming the speaker.
				converted.text = data.text ?? converted.text;
				if (data.at !== undefined) converted.at = data.at;
				if (data.author !== undefined) converted.author = data.author;
				// The sender's request ID: a client matches what it sent to the transcript by it, not by the text.
				if (data.requestId !== undefined) converted.requestId = data.requestId;
				// The files it carried (the model's copy names them in its text).
				if (data.attachments !== undefined && data.attachments.length > 0) converted.attachments = data.attachments;
			}
			messages.push(converted);
		});
	}
	return messages;
}

/** The live part of the view: the reply in progress and the current round's tools. */
export function liveParts(live: Readonly<LiveState> | undefined, identities?: CallIdentities): Pick<ChatView, "partial" | "tools"> {
	const partialMessage = live?.generation?.message as AssistantMessage | undefined;
	return {
		...(partialMessage === undefined
			? {}
			: { partial: { text: textOf(partialMessage), thinking: thinkingOf(partialMessage) } }),
		tools: (live?.tools ?? []).map((slot, index) => ({
			callId: slot.callId,
			...(slot.taskId === undefined ? {} : { taskId: taskIdentity(slot.taskId) }),
			...(identities?.liveSources.has(index) ? { instanceId: identities.liveSources.get(index) } : {}),
			name: slot.name,
			status: slot.status,
			...(slot.output === undefined ? {} : { output: slot.output }),
			...boundedDetails((slot as { details?: unknown }).details),
		})),
	};
}

/** A pdp.user entry's data, read defensively (it is stored JSON). */
function userData(value: unknown): Partial<UserEntryData> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { text, at, author, requestId, attachments } = value as Record<string, unknown>;
	const out: Partial<UserEntryData> = {};
	const files = parseAttachments(attachments);
	if (files !== undefined && files.length > 0) out.attachments = files;
	if (typeof text === "string") out.text = text;
	if (typeof requestId === "string") out.requestId = requestId;
	if (typeof at === "number") out.at = at;
	if (typeof author === "object" && author !== null) {
		const { kind, id, name, via } = author as Record<string, unknown>;
		if (typeof kind === "string" && AUTHOR_KINDS.has(kind) && typeof id === "string" && typeof name === "string") {
			out.author = { kind: kind as Author["kind"], id, name, ...(typeof via === "string" ? { via } : {}) };
		}
	}
	return out;
}

const timeOf = (message: { timestamp?: unknown }) => (typeof message.timestamp === "number" && message.timestamp > 0 ? message.timestamp : undefined);

function convert(id: string, message: Message, resultAt: ReadonlyMap<string, number>, approvals?: ReadonlyMap<string, ChatApproval>, identities?: CallIdentities): ChatMessage | undefined {
	const at = timeOf(message as { timestamp?: unknown });
	switch (message.role) {
		case "user":
			return {
				id,
				role: "user",
				text: typeof message.content === "string" ? message.content : message.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n"),
				...(at === undefined ? {} : { at }),
			};
		case "assistant": {
			// Tool calls are made when the response ends (its start plus its duration, when known).
			const calledAt = at === undefined ? undefined : at + (typeof message.durationMs === "number" ? message.durationMs : 0);
			const toolCalls = message.content.flatMap((block): ChatToolCall[] => {
				if (block.type !== "toolCall") return [];
				const instanceId = callInstance(id, block.id);
				const taskId = identities?.byInstance.get(instanceId);
				const endedAt = resultAt.get(instanceId);
				const approval = taskId === undefined ? undefined : approvals?.get(taskId);
				return [
					{
						id: block.id,
						instanceId,
						...(taskId === undefined ? {} : { taskId }),
						name: block.name,
						arguments: block.arguments ?? {},
						...(calledAt === undefined ? {} : { startedAt: calledAt }),
						...(endedAt === undefined ? {} : { endedAt }),
						...(approval === undefined ? {} : { approval }),
					},
				];
			});
			const thinking = thinkingOf(message);
			const error =
				message.stopReason === "aborted" ? "Interrupted" : message.stopReason === "error" ? (message.errorMessage ?? "The model request failed") : undefined;
			const usage = message.usage;
			return {
				id,
				role: "assistant",
				text: textOf(message),
				...(thinking ? { thinking } : {}),
				...(toolCalls.length > 0 ? { toolCalls } : {}),
				...(error === undefined ? {} : { error }),
				...(at === undefined ? {} : { at }),
				...(typeof message.provider === "string" && typeof message.model === "string" ? { model: { provider: message.provider, id: message.model } } : {}),
				...(usage === undefined
					? {}
					: {
							usage: {
								input: usage.input ?? 0,
								output: usage.output ?? 0,
								cacheRead: usage.cacheRead ?? 0,
								cacheWrite: usage.cacheWrite ?? 0,
								total: usage.totalTokens ?? 0,
							},
						}),
				...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
			};
		}
		case "toolResult":
			return {
				id,
				role: "tool",
				toolCallId: message.toolCallId,
				...(identities?.results.has(id) ? { instanceId: identities.results.get(id), taskId: identities.byInstance.get(identities.results.get(id)!) } : {}),
				name: message.toolName,
				text: message.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n"),
				isError: message.isError,
				...(at === undefined ? {} : { at }),
				...boundedDetails((message as { details?: unknown }).details),
			};
		default:
			return undefined;
	}
}

const textOf = (message: AssistantMessage) => message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
const thinkingOf = (message: AssistantMessage) =>
	message.content.flatMap((b) => (b.type === "thinking" && !b.redacted ? [b.thinking] : [])).join("\n\n");

/** A page of the transcript: the `limit` messages before the message `before` names (the newest when absent). */
export type MessagePage = { before?: string; limit: number };

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;
const MESSAGE_ID = /^e\d{1,15}(:\d{1,6})?$/;

/** The opaque cursor naming a message (clients pass it back as `before`). */
export function messageCursor(id: string): string {
	return Buffer.from(`m:${id}`, "utf8").toString("base64url");
}

/** The message a cursor names, or undefined when it is malformed. */
export function cursorMessage(cursor: string): string | undefined {
	if (cursor.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
	const raw = Buffer.from(cursor, "base64url").toString("utf8");
	if (!raw.startsWith("m:")) return undefined;
	const id = raw.slice(2);
	return MESSAGE_ID.test(id) && messageCursor(id) === cursor ? id : undefined;
}

/**
 * Reads `?before=` and `?limit=`: undefined when neither is given (the whole transcript, as before paging existed),
 * a page otherwise, or an error for a malformed value.
 */
export function parsePage(query: URLSearchParams): { page?: MessagePage; error?: { code: string; message: string } } {
	const rawLimit = query.get("limit");
	const rawBefore = query.get("before");
	if (rawLimit === null && rawBefore === null) return {};
	let limit = DEFAULT_PAGE;
	if (rawLimit !== null) {
		limit = /^\d{1,4}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
		if (!(limit >= 1 && limit <= MAX_PAGE)) return { error: { code: "invalid_limit", message: `limit must be between 1 and ${MAX_PAGE}` } };
	}
	if (rawBefore === null || rawBefore === "") return { page: { limit } };
	const before = cursorMessage(rawBefore);
	if (before === undefined) return { error: { code: "invalid_cursor", message: "Invalid cursor" } };
	return { page: { before, limit } };
}

/**
 * The view with only one page of its messages, and `earlierCursor` when earlier messages exist. A page never starts
 * with a tool result: it then also holds the reply that made the call (so it may hold a few more than `limit`). A
 * cursor whose message is no longer in the view (the conversation was compacted or reset) gives an empty page.
 */
export function pageView(view: ChatView, page: MessagePage): ChatView {
	const all = view.messages;
	const end = page.before === undefined ? all.length : all.findIndex((m) => m.id === page.before);
	if (end < 0) return { ...view, messages: [] };
	let start = Math.max(0, end - page.limit);
	while (start > 0 && all[start]?.role === "tool") start--;
	const { earlierCursor: _, ...rest } = view;
	return { ...rest, messages: all.slice(start, end), ...(start > 0 ? { earlierCursor: messageCursor(all[start]!.id) } : {}) };
}

/** A message's attachments, checked (undefined when the value is not a list of them). */
export function parseAttachments(value: unknown): ChatAttachment[] | undefined {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return undefined;
	const out: ChatAttachment[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) return undefined;
		const { path, name, size, mediaType } = item as Record<string, unknown>;
		if (typeof path !== "string" || !safeRelative(path)) return undefined;
		const file = {
			path,
			name: typeof name === "string" && name.trim() ? name.slice(0, 255) : (path.split("/").pop() ?? path),
			size: typeof size === "number" && Number.isFinite(size) && size >= 0 ? Math.floor(size) : 0,
			mediaType: typeof mediaType === "string" ? mediaType.slice(0, 100) : "",
		};
		out.push(file);
	}
	return out;
}

/** A path inside the workspace as written: relative, no "..", no NUL, not too long. */
function safeRelative(path: string): boolean {
	if (path === "" || path.length > 1000 || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
	return !path.split(/[\\/]/).includes("..");
}

/** The block the model reads after the text: `Attached files (in your workspace):` and a line per file. */
export function attachmentBlock(files: readonly ChatAttachment[]): string {
	if (files.length === 0) return "";
	return ["Attached files (in your workspace):", ...files.map((file) => `- ${file.path} (${formatBytes(file.size)})`)].join("\n");
}

/** "512 B", "120 KB", "4.2 MB" (1 KB = 1024 B), as the app writes sizes. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)} ${units[unit]}`;
}
