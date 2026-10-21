import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Conversation, type ConversationDocToken, type ConversationId, type DocumentWatch, type Harness, type JsonObject, LiveDoc, type UserInput } from "@earendil-works/pi-durable";
import { abortBackground, type LiveWork, liveWork, olderThan, reportBackground } from "./background.ts";
import { type Approvals, type DecisionInput, parseApprovalPolicy, waitingThreads } from "./approvals.ts";
import type { ThreadStore } from "./threads.ts";
import { DELTA_VERSION, DeltaStream } from "./delta.ts";
import { EXPOSED_KIND } from "./define.ts";
import { afterCursor, type FactCandidate, lastCursor, validCursor } from "./memory-extract.ts";
import { ARTIFACT_ID, ArtifactError, type Artifact } from "./artifacts.ts";
import { CONTRACT_VERSION, PI_DURABLE_VERSION } from "./version.ts";
import {
	AUTHOR_KINDS,
	type Author,
	buildMessages,
	buildView,
	type ChatDocumentRef,
	type ChatMessage,
	type ChatView,
	liveParts,
	type MessagePage,
	pageView,
	parsePage,
	USER_ENTRY,
	type UserEntryData,
	attachmentBlock,
	type ChatAttachment,
	MAX_ATTACHMENTS,
	parseAttachments,
} from "./view.ts";

/** The documents an agent exposes to apps, by kind, with their bounds (define.ts, exposedDocuments). */
/** What the person chose for a conversation's message (empty: the agent's own model, the model's default thinking). */
export type MessageChoice = { model: string; thinking: string };

export type ExposedDocuments = ReadonlyMap<string, { document: ConversationDocToken<JsonObject>; maxBytes: number }>;

const ctx = BACKGROUND_CONTEXT;
const MAX_BODY = 256 * 1024;
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The longest `olderThanMs` POST /background/abort takes (ten years). */
const MAX_OLDER_THAN_MS = 10 * 366 * 24 * 3600 * 1000;
/** How long POST /background/abort waits for the aborted work to end. */
const ABORT_WAIT_MS = 5_000;

export type RuntimeOptions = {
	harness: Harness;
	threads: ThreadStore;
	/** Shared secret the platform presents; every route but /healthz requires it. */
	token: string;
	info: { agentId: string; name: string; model: string };
	/** Prepares a thread before a message (its MCP servers), after it exists. */
	/**
	 * The model's copy of a message with files: its text (with the block naming them), and whatever the agent adds,
	 * such as the images for a model that sees them. Without it, the text alone.
	 */
	inputFor?: (threadId: string, text: string, attachments: readonly ChatAttachment[]) => Promise<UserInput>;
	/** choice: the model ("provider/modelId", "" the agent's own) and thinking level ("" the default) the person chose. */
	beforeMessage?: (threadId: string, conversation: Conversation, text: string, choice: MessageChoice) => Promise<void>;
	/** A message was submitted to the thread (its reply's end is reported to the platform). */
	afterMessage?: (threadId: string, submissionId: number) => void;
	/** The conversation documents apps may read (none by default). */
	documents?: ExposedDocuments;
	/** Bound by the agent to its conversation-scoped SQLite document; absent: no artifact API. */
	artifacts?: {
		read: (conversationId: ConversationId, id: string) => Promise<Artifact | undefined>;
		edit: (conversationId: ConversationId, id: string, input: unknown) => Promise<Artifact>;
		save?: (conversationId: ConversationId, id: string, path: string, expectedRevision: number) => Promise<void>;
	};
	/**
	 * Whether a task of this kind stands for a wait on a person's answer (an approval, a question): such a task, and the
	 * work only waiting on it, keeps the agent awake neither as a busy thread nor as background work. Default: none.
	 */
	waitsForPerson?: (kind: string) => boolean;
	/** Tool approvals (docs/approvals.md): shown in the view, decided through POST /approvals/{id}. */
	approvals?: Approvals;
	/**
	 * Facts about the person in new messages of a thread (POST /memory/extract, the platform's end-of-conversation
	 * suggestions). None: the route answers 404.
	 */
	extractMemory?: (messages: readonly ChatMessage[], known: readonly string[], signal: AbortSignal, threadId: string) => Promise<FactCandidate[] | undefined>;
};

/**
 * The agent's private HTTP interface. Only the platform calls it, with the agent's bearer token; clients never reach a
 * runtime directly. Pi is the source of truth: the runtime keeps no state of its own besides the open harness.
 */
export function createRuntimeServer(options: RuntimeOptions): {
	server: Server;
	handler: RequestListener;
	lastActivity: () => number;
	/** Records activity now (a reply just ended, for instance), so the reaper doesn't hibernate an agent that just worked. */
	touch: () => void;
} {
	const { harness, threads, approvals } = options;
	const exposed: ExposedDocuments = options.documents ?? new Map();
	const expected = Buffer.from(`Bearer ${options.token}`);
	let lastActivity = Date.now();
	const touch = () => {
		lastActivity = Date.now();
	};
	// Open event streams. The platform's replicas don't share what each one has seen, so the runtime, which serves every
	// stream, says how many are open (/status): whichever replica reaps idle agents asks here, never its own records.
	let openStreams = 0;

	const authorized = (request: IncomingMessage) => {
		const header = Buffer.from(request.headers.authorization ?? "");
		return header.length === expected.length && timingSafeEqual(header, expected);
	};

	// Live work from pi-durable's task graph (background.ts): busy threads and background work.
	const firstSeen = new Map<number, number>();
	const waitsForPerson = options.waitsForPerson ?? (() => false);
	const currentWork = async () =>
		liveWork(
			harness,
			(await threads.list()).map((thread) => thread.conversationId),
			{ waitsForPerson, firstSeen },
		);
	// Background work ending counts as activity (the idle clock starts then), unless the platform aborted it for its
	// age (POST /background/abort): the reaper hibernates the agent right after that. Work running doesn't touch: the
	// platform sees it in backgroundWork, and must be able to tell it from requests when it is past its ceiling.
	let activeUnits = new Set<number>();
	const abortedForAge = new Set<number>();
	const observe = (work: LiveWork) => {
		const active = new Set(work.units.filter((unit) => !unit.idle).map((unit) => unit.taskId as number));
		let ended = false;
		for (const id of activeUnits) if (!active.has(id) && !abortedForAge.delete(id)) ended = true;
		for (const id of abortedForAge) if (!active.has(id)) abortedForAge.delete(id);
		activeUnits = active;
		if (ended) touch();
	};

	const viewOf = async (threadId: string): Promise<ChatView | undefined> => {
		const conversation = await threads.get(threadId);
		if (conversation === undefined) return undefined;
		const watch = await conversation.watch(ctx);
		const value = watch.value;
		await watch.stop();
		return buildView(
			value.entries,
			value.docs["pi.live"] as never,
			await documentRefs(harness, conversation.id, exposed),
			approvals?.viewOf(threadId, conversation.id as unknown as number),
		);
	};

	/** An exposed document of a thread: GET /threads/{thread}/documents/{kind}. */
	const readDocument = async (threadId: string, kind: string, response: ServerResponse) => {
		const conversation = await threads.get(threadId);
		if (conversation === undefined) return fail(response, 404, "thread_not_found", "Thread not found");
		const entry = EXPOSED_KIND.test(kind) ? exposed.get(kind) : undefined;
		// A kind the agent doesn't expose reads as one the thread doesn't have: apps learn nothing about the others.
		const value = entry === undefined ? undefined : await harness.snapshot(entry.document, conversation.id, ctx);
		if (entry === undefined || value === undefined || value === null) return fail(response, 404, "document_not_found", "The thread has no such document");
		const text = JSON.stringify(value);
		if (Buffer.byteLength(text, "utf8") > entry.maxBytes) {
			return fail(response, 422, "document_too_large", `The document is larger than the agent exposes (${entry.maxBytes} bytes)`);
		}
		return json(response, 200, { kind, version: entry.document.definition.version, revision: revisionOf(text), value });
	};

	const route = async (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://runtime");
		const parts = url.pathname.split("/").filter(Boolean);
		const method = request.method ?? "GET";

		if (method === "GET" && url.pathname === "/healthz") return json(response, 200, { ok: true });
		if (!authorized(request)) return fail(response, 401, "unauthorized", "Unauthorized");

		if (method === "GET" && url.pathname === "/status") {
			const work = await currentWork();
			observe(work);
			// A reply that waits only for a person's decision (an approval, docs/approvals.md) doesn't make its thread busy:
			// busyThreads leaves it out (contract 2, docs/hibernation.md), and waitingThreads says how many there are.
			const waiting = approvals?.waiting();
			const waitingCount = waiting === undefined ? 0 : await waitingThreads(harness, threads, waiting.threads);
			const busy = Math.max(0, work.busyThreads - waitingCount);
			if (busy > 0) touch();
			return json(response, 200, {
				...options.info,
				busyThreads: busy,
				waitingThreads: waitingCount,
				pendingApprovals: waiting?.pending ?? 0,
				openStreams,
				lastActivityAt: lastActivity,
				backgroundWork: reportBackground(work),
				contractVersion: CONTRACT_VERSION,
				piDurableVersion: PI_DURABLE_VERSION,
			});
		}
		if (method === "POST" && url.pathname === "/background/abort") {
			// The platform's ceiling (docs/hibernation.md): background work older than this no longer keeps the agent awake.
			const body = (await readJson(request)) as { olderThanMs?: unknown };
			const age = body.olderThanMs;
			if (typeof age !== "number" || !Number.isInteger(age) || age < 0 || age > MAX_OLDER_THAN_MS) {
				return fail(response, 400, "invalid_older_than", "olderThanMs is a whole number of milliseconds, at least 0");
			}
			const work = await currentWork();
			observe(work);
			const old = olderThan(work, Date.now() - age);
			for (const unit of old) abortedForAge.add(unit.taskId as number);
			const { aborted, settled } = await abortBackground(harness, old, ABORT_WAIT_MS);
			observe(await currentWork());
			return json(response, 200, { aborted: aborted.length, settled });
		}
		if (method === "GET" && url.pathname === "/threads") return json(response, 200, await threads.list());
		if (parts[0] === "approvals") return routeApproval(request, response, parts, url);
		if (method === "POST" && url.pathname === "/memory/extract") return routeExtract(request, response);

		if (parts[0] !== "threads" || parts[1] === undefined) return fail(response, 404, "not_found", "Not found");
		const threadId = parts[1];
		if (!THREAD_ID.test(threadId)) return fail(response, 400, "invalid_thread_id", "Thread IDs are 1-64 letters, digits, dashes or underscores");
		const action = parts[2];

		if (method === "GET" && action === undefined) {
			const { page, error } = parsePage(url.searchParams);
			if (error !== undefined) return fail(response, 400, error.code, error.message);
			// Someone reading a thread (often right after its reply) is using the agent.
			touch();
			const view = await viewOf(threadId);
			if (view === undefined) return fail(response, 404, "thread_not_found", "Thread not found");
			return json(response, 200, page === undefined ? view : pageView(view, page));
		}
		if (method === "DELETE" && action === undefined) {
			const conversation = await threads.get(threadId);
			if (conversation !== undefined) await conversation.abort(ctx).catch(() => {});
			await approvals?.reconcile(threadId).catch(() => {});
			return (await threads.remove(threadId)) ? json(response, 200, { ok: true }) : fail(response, 404, "thread_not_found", "Thread not found");
		}
		if (method === "POST" && action === "messages") {
			touch();
			const body = (await readJson(request)) as {
				text?: unknown;
				requestId?: unknown;
				author?: unknown;
				announceAuthor?: unknown;
				whenBusy?: unknown;
				model?: unknown;
				thinking?: unknown;
				attachments?: unknown;
			};
			const text = typeof body.text === "string" ? body.text.trim() : "";
			const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
			const attachments = parseAttachments(body.attachments);
			if (attachments === undefined) {
				return fail(response, 400, "invalid_attachments", `attachments is a list of at most ${MAX_ATTACHMENTS} files ({path, name, size, mediaType}, paths inside the workspace)`);
			}
			// A message is text, files, or both.
			if ((text.length === 0 && attachments.length === 0) || text.length > 32_000) return fail(response, 400, "invalid_text", "text is required (at most 32,000 characters)");
			if (requestId !== undefined && !THREAD_ID.test(requestId)) return fail(response, 400, "invalid_request_id", "requestId must be 1-64 letters, digits, dashes or underscores");
			// While a reply runs: a follow-up waits for it to end; a steer joins it after its current tool round.
			const whenBusy = body.whenBusy ?? "followUp";
			if (whenBusy !== "followUp" && whenBusy !== "steer") return fail(response, 400, "invalid_when_busy", "whenBusy must be followUp or steer");
			// The platform (the only caller) says who sent the message, and whether the model is told (shared threads).
			const author = parseAuthor(body.author);
			const conversation = await threads.ensure(threadId, text || attachments.map((file) => file.name).join(", "));
			const choice: MessageChoice = {
				model: typeof body.model === "string" ? body.model.trim() : "",
				thinking: typeof body.thinking === "string" ? body.thinking.trim() : "",
			};
			await options.beforeMessage?.(threadId, conversation, text, choice);
			const data: UserEntryData = {
				text,
				at: Date.now(),
				...(author === undefined ? {} : { author }),
				...(requestId === undefined ? {} : { requestId }),
				...(attachments.length > 0 ? { attachments } : {}),
			};
			// The model reads the text, then the block naming the files; the agent may add the images themselves.
			const spoken = author !== undefined && body.announceAuthor === true ? `${speakerLine(author)}\n${text}` : text;
			const written = [spoken, attachmentBlock(attachments)].filter((part) => part !== "").join("\n\n");
			const content: UserInput = options.inputFor ? await options.inputFor(threadId, written, attachments) : written;
			const submission = await conversation.submit(
				{
					type: "input",
					content,
					whenBusy,
					entry: { kind: USER_ENTRY, data },
					...(requestId === undefined ? {} : { requestId }),
				},
				ctx,
			);
			await threads.touch(threadId);
			options.afterMessage?.(threadId, submission.id as number);
			return json(response, 202, { submissionId: submission.id });
		}
		if (method === "POST" && action === "fork") {
			// A new thread from this one (edit and resend a message, or branch the conversation): with beforeMessageId it
			// keeps the transcript up to the message before that one; with afterMessageId, up to and with that one.
			touch();
			const body = (await readJson(request)) as { threadId?: unknown; beforeMessageId?: unknown; afterMessageId?: unknown };
			const newId = body.threadId;
			if (typeof newId !== "string" || !THREAD_ID.test(newId)) return fail(response, 400, "invalid_thread_id", "threadId must be 1-64 letters, digits, dashes or underscores");
			const before = typeof body.beforeMessageId === "string" ? body.beforeMessageId : undefined;
			const after = typeof body.afterMessageId === "string" ? body.afterMessageId : undefined;
			if ((before === undefined) === (after === undefined)) return fail(response, 400, "invalid_fork", "Give beforeMessageId or afterMessageId");
			const view = await viewOf(threadId);
			if (view === undefined) return fail(response, 404, "thread_not_found", "Thread not found");
			const index = view.messages.findIndex((m) => m.id === (before ?? after));
			if (index < 0) return fail(response, 400, "invalid_message_id", "No such message in this thread");
			// The entry a message came from: its ID is e<entry>, or e<entry>:<n> for one of several messages of an entry.
			const entryOf = (id: string) => Number(/^e(\d+)/.exec(id)?.[1]);
			const keep = before !== undefined ? view.messages[index - 1] : view.messages[index];
			const at = keep === undefined ? undefined : entryOf(keep.id);
			if (at !== undefined && !Number.isSafeInteger(at)) return fail(response, 400, "invalid_message_id", "That message can't be forked from");
			try {
				const forked = await threads.fork(threadId, newId, at);
				if (forked === undefined) return fail(response, 404, "thread_not_found", "Thread not found");
			} catch (error) {
				if (/exists/.test((error as Error).message)) return fail(response, 409, "thread_exists", "That thread ID is taken");
				throw error;
			}
			return json(response, 201, { threadId: newId });
		}
		if (method === "POST" && action === "stop") {
			touch();
			const conversation = await threads.get(threadId);
			if (conversation === undefined) return fail(response, 404, "thread_not_found", "Thread not found");
			await conversation.abort(ctx);
			// A request whose call the stop ended is cancelled (and the platform told).
			await approvals?.reconcile(threadId).catch(() => {});
			return json(response, 202, { ok: true });
		}
		if (action === "artifacts" && options.artifacts && parts.length >= 4 && parts.length <= 5) {
			const id = parts[3]!;
			if (!ARTIFACT_ID.test(id)) return fail(response, 400, "invalid_artifact_id", "Invalid artifact ID");
			const conversation = await threads.get(threadId);
			if (!conversation) return fail(response, 404, "thread_not_found", "Thread not found");
			touch();
			if (method === "GET" && (parts.length === 4 || parts[4] === "history")) {
				const artifact = await options.artifacts.read(conversation.id, id);
				if (!artifact) return fail(response, 404, "artifact_not_found", "This conversation has no such artifact");
				return json(response, 200, parts[4] === "history" ? artifact.versions : artifact);
			}
			if (method === "PUT" && parts.length === 4) return json(response, 200, await options.artifacts.edit(conversation.id, id, await readJson(request)));
			if (method === "POST" && parts[4] === "workspace") {
				if (!options.artifacts.save) return fail(response, 403, "no_write_tool", "This agent has no workspace write capability");
				const body = await readJson(request) as { path?: unknown; expectedRevision?: unknown };
				if (!body || typeof body !== "object" || typeof body.path !== "string" || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) return fail(response, 400, "invalid_request", "path and a positive expectedRevision are required");
				await options.artifacts.save(conversation.id, id, body.path, body.expectedRevision as number);
				return json(response, 200, { path: body.path });
			}
		}
		if (method === "GET" && action === "documents" && parts[3] !== undefined && parts.length === 4) {
			touch();
			return readDocument(threadId, parts[3], response);
		}
		if (method === "GET" && action === "events") {
			const options = streamOptions(url.searchParams, request.headers["last-event-id"]);
			if ("error" in options) return fail(response, 400, options.error.code, options.error.message);
			return streamThread(threadId, request, response, options);
		}
		return fail(response, 404, "not_found", "Not found");
	};

	/**
	 * Tool approvals: `GET /approvals[?thread=]` lists the requests (pending first), `POST /approvals/{id}` applies a
	 * decision `{decision: approve|deny|timeout|cancel, reason?, decidedBy?}` (the platform's, or a test's).
	 */
	// POST /memory/extract {threadId, since?, known?}: read messages after a stable durable message ID.
	// The app holds the shared extraction claim until it saves the result and advances the cursor. One small request
	// to the agent's model; only the person's own messages count as a source (never a schedule's or another agent's).
	const routeExtract = async (request: IncomingMessage, response: ServerResponse) => {
		if (options.extractMemory === undefined) return fail(response, 404, "not_found", "Memory suggestions are not offered");
		const body = (await readJson(request)) as { threadId?: unknown; since?: unknown; known?: unknown };
		if (typeof body.threadId !== "string" || !THREAD_ID.test(body.threadId)) return fail(response, 400, "invalid_thread_id", "Name the thread");
		if (body.since !== undefined && !validCursor(body.since)) return fail(response, 400, "invalid_since", "Use a durable message ID");
		if (body.known !== undefined && (!Array.isArray(body.known) || body.known.length > 40 || body.known.some((v) => typeof v !== "string" || v.length > 1000))) return fail(response, 400, "invalid_known", "Use at most 40 facts");
		const since = (body.since as string | undefined) ?? "";
		const known = (body.known as string[] | undefined) ?? [];
		const view = await viewOf(body.threadId);
		if (view === undefined) return fail(response, 404, "thread_not_found", "Thread not found");
		const fresh = afterCursor(view.messages, since);
		// App shutdown cancels the HTTP request: propagate that to the provider, rather than leaving an auxiliary
		// request running for two minutes and holding the runtime's own shutdown open.
		const disconnected = new AbortController();
		const onClose = () => disconnected.abort(new Error("Memory extraction request closed"));
		response.once("close", onClose);
		if (response.destroyed) onClose();
		try {
			const signal = AbortSignal.any([AbortSignal.timeout(120_000), disconnected.signal]);
			const facts = await options.extractMemory(fresh, known, signal, body.threadId);
			if (facts === undefined) return fail(response, 502, "extraction_failed", "No valid memory extraction was returned");
			return json(response, 200, { facts, cursor: lastCursor(fresh, since) });
		} finally {
			response.off("close", onClose);
		}
	};

	const routeApproval = async (request: IncomingMessage, response: ServerResponse, parts: string[], url: URL) => {
		const method = request.method ?? "GET";
		if (approvals === undefined) return fail(response, 404, "not_found", "Not found");
		if (method === "GET" && parts.length === 1) {
			const thread = url.searchParams.get("thread") ?? undefined;
			return json(response, 200, approvals.list(thread));
		}
		const id = parts[1];
		// The platform's word that the agent's rules or profile changed: `{profile, tools, rules, builtin, timeoutSeconds}`.
		if (method === "POST" && parts.length === 2 && id === "policy") {
			approvals.setPolicy(parseApprovalPolicy(JSON.stringify(await readJson(request))));
			return json(response, 200, { ok: true });
		}
		if (method === "POST" && parts.length === 2 && id !== undefined) {
			touch();
			if (!/^ap_[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(response, 404, "approval_not_found", "Approval not found");
			const body = (await readJson(request)) as { decision?: unknown; reason?: unknown; decidedBy?: unknown };
			const decision = body.decision;
			if (decision !== "approve" && decision !== "deny" && decision !== "timeout" && decision !== "cancel") {
				return fail(response, 400, "invalid_decision", "decision must be approve, deny, timeout or cancel");
			}
			const input: DecisionInput = { decision };
			if (typeof body.reason === "string") input.reason = body.reason;
			const by = body.decidedBy as { kind?: unknown; id?: unknown; name?: unknown } | undefined;
			if (typeof by === "object" && by !== null && (by.kind === "user" || by.kind === "service_account" || by.kind === "system") && typeof by.name === "string") {
				input.decidedBy = { kind: by.kind, name: by.name, ...(typeof by.id === "string" ? { id: by.id } : {}) };
			}
			const result = await approvals.decide(id, input);
			if (result === undefined) return fail(response, 404, "approval_not_found", "Approval not found");
			return json(response, 200, { id, ...result });
		}
		return fail(response, 404, "not_found", "Not found");
	};

	/**
	 * Server-sent events, coalesced to 10/s: by default the whole chat view after every commit that touches the thread
	 * (`view` events); with `format=delta` a snapshot and then only the changes (see delta.ts). `limit` keeps either to
	 * the latest messages.
	 */
	const streamThread = async (threadId: string, request: IncomingMessage, response: ServerResponse, options: StreamOptions) => {
		const conversation = await threads.get(threadId);
		if (conversation === undefined) return fail(response, 404, "thread_not_found", "Thread not found");
		const watch = await conversation.watch(ctx);
		// The exposed documents are watched too: a change to one is a `document.updated` (deltas), or a view with its
		// new revision.
		const docs = new DocumentWatches(harness, conversation.id, exposed);
		await docs.refresh();
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
		touch();
		// The transcript is rebuilt only when the entries (or the thread's approvals) changed: a frame that only moves the
		// reply in progress or a tool keeps the same entries (pi-durable shares unchanged parts between frames).
		let entries: unknown;
		let messages: ChatMessage[] = [];
		let approvalsSeen = -1;
		let approvalsVersion = 0;
		let shown = approvals?.viewOf(threadId, conversation.id as unknown as number);
		const current = (value: typeof watch.value): { view: ChatView; changed: boolean } => {
			const changed = value.entries !== entries || approvalsSeen !== approvalsVersion;
			if (changed) {
				entries = value.entries;
				approvalsSeen = approvalsVersion;
				shown = approvals?.viewOf(threadId, conversation.id as unknown as number);
				messages = buildMessages(value.entries, shown?.byCall);
			}
			const live = value.docs["pi.live"] as never as Parameters<typeof liveParts>[0];
			const documents = docs.refs();
			const pending = shown === undefined || shown.pending.length === 0 ? {} : { approvals: shown.pending };
			return {
				view: { busy: live?.run !== undefined, messages, ...liveParts(live), ...(documents === undefined ? {} : { documents }), ...pending },
				changed,
			};
		};
		const deltas = options.format === "delta" ? new DeltaStream(options.limit, options.lastSeq) : undefined;
		const page: MessagePage | undefined = options.limit === undefined ? undefined : { limit: options.limit };
		const send = (value: typeof watch.value) => {
			const { view, changed } = current(value);
			if (deltas === undefined) {
				response.write(`event: view\ndata: ${JSON.stringify(page === undefined ? view : pageView(view, page))}\n\n`);
				return;
			}
			let out = "";
			for (const event of deltas.next(view, changed)) out += `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
			if (out !== "") response.write(out);
		};
		send(watch.value);
		if (options.once) {
			await watch.stop();
			await docs.stop();
			response.end();
			return;
		}
		let latest = watch.value;
		let timer: NodeJS.Timeout | undefined;
		const schedule = () => {
			touch();
			timer ??= setTimeout(() => {
				timer = undefined;
				send(latest);
			}, 100);
		};
		docs.onChange = schedule;
		watch.start(async (value) => {
			latest = value;
			// A document a thread didn't have yet (one declared after the thread began) is watched once it exists.
			await docs.refresh().catch(() => {});
			schedule();
		});
		// An approval asked or decided in this thread changes the view without a commit to the conversation.
		const unsubscribe = approvals?.onChange((changed) => {
			if (changed !== threadId) return;
			approvalsVersion++;
			schedule();
		});
		const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
		openStreams++;
		let ended = false;
		const end = () => {
			unsubscribe?.();
			clearInterval(keepAlive);
			if (timer !== undefined) clearTimeout(timer);
			void watch.stop();
			void docs.stop();
			if (ended) return;
			ended = true;
			openStreams--;
			// Someone was watching until now: the idle clock starts here.
			touch();
		};
		request.on("close", end);
		void watch.closed.then(() => {
			end();
			response.end();
		});
	};

	const handler: RequestListener = (request, response) => {
		route(request, response).catch((error: unknown) => {
			const status = error instanceof RequestError || error instanceof ArtifactError ? error.status : 500;
			if (status === 500) console.error("[runtime] request failed", error);
			if (!response.headersSent) fail(response, status, error instanceof ArtifactError ? error.code : status === 500 ? "internal" : "invalid_request", status === 500 ? "Internal error" : (error as Error).message);
			else response.end();
		});
	};
	return { server: createServer(handler), handler, lastActivity: () => lastActivity, touch };
}

type StreamOptions = { once: boolean; format: "view" | "delta"; limit?: number; lastSeq: number };

/** A document's revision: a hash of its JSON (equal content, equal revision, on any runtime). */
export function revisionOf(json: string): string {
	return createHash("sha256").update(json).digest("base64url").slice(0, 22);
}

/** The exposed documents a conversation has, with their revisions; undefined when it has none. */
async function documentRefs(harness: Harness, conversationId: ConversationId, exposed: ExposedDocuments): Promise<Record<string, ChatDocumentRef> | undefined> {
	let out: Record<string, ChatDocumentRef> | undefined;
	for (const [kind, { document }] of exposed) {
		const value = await harness.snapshot(document, conversationId, ctx);
		if (value === undefined || value === null) continue;
		(out ??= {})[kind] = { revision: revisionOf(JSON.stringify(value)) };
	}
	return out;
}

/** One event stream's watches of a conversation's exposed documents. */
class DocumentWatches {
	private readonly watches = new Map<string, DocumentWatch<JsonObject>>();
	/** Each document's latest value and its revision (computed once per value). */
	private readonly latest = new Map<string, { value: unknown; revision: string }>();
	private stopped = false;
	/** Called when a watched document changes. */
	onChange: () => void = () => {};

	constructor(
		private readonly harness: Harness,
		private readonly conversationId: ConversationId,
		private readonly exposed: ExposedDocuments,
	) {}

	/** Starts watching the exposed documents that exist and aren't watched yet. */
	async refresh(): Promise<void> {
		for (const [kind, { document }] of this.exposed) {
			if (this.stopped || this.watches.has(kind)) continue;
			const watch = await this.harness.watchDoc(document, this.conversationId, ctx);
			if (watch === undefined) continue;
			if (this.stopped) {
				void watch.stop();
				return;
			}
			this.watches.set(kind, watch);
			this.note(kind, watch.value);
			watch.start(async (value) => {
				this.note(kind, value);
				this.onChange();
			});
			void watch.closed.then(() => {
				// Retired: forget it; a new incarnation is watched at the next refresh.
				if (this.watches.get(kind) === watch) {
					this.watches.delete(kind);
					this.latest.delete(kind);
				}
			});
		}
	}

	private note(kind: string, value: unknown): void {
		if (this.latest.get(kind)?.value === value) return;
		if (value === null || value === undefined) this.latest.delete(kind);
		else this.latest.set(kind, { value, revision: revisionOf(JSON.stringify(value)) });
	}

	refs(): Record<string, ChatDocumentRef> | undefined {
		let out: Record<string, ChatDocumentRef> | undefined;
		for (const [kind, { revision }] of this.latest) (out ??= {})[kind] = { revision };
		return out;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		const watches = [...this.watches.values()];
		this.watches.clear();
		await Promise.all(watches.map((watch) => watch.stop().catch(() => {})));
	}
}

/**
 * An event stream's options: `once`, `format` (view, the default, or delta), `v` (the delta format's version: 1),
 * `limit` (the latest messages only) and, for deltas, the Last-Event-ID a reconnecting client sends (its sequence
 * goes on from there, after a new snapshot).
 */
export function streamOptions(query: URLSearchParams, lastEventId: string | string[] | undefined): StreamOptions | { error: { code: string; message: string } } {
	const format = query.get("format") ?? "view";
	if (format !== "view" && format !== "delta") return { error: { code: "invalid_format", message: "format must be view or delta" } };
	const v = query.get("v");
	if (v !== null && (format !== "delta" || v !== String(DELTA_VERSION))) {
		return { error: { code: "unsupported_version", message: `The delta format's version is ${DELTA_VERSION}` } };
	}
	let limit: number | undefined;
	if (query.get("limit") !== null) {
		const { page, error } = parsePage(new URLSearchParams({ limit: query.get("limit")! }));
		if (error !== undefined) return { error };
		limit = page!.limit;
	}
	const last = typeof lastEventId === "string" && /^\d{1,15}$/.test(lastEventId) ? Number(lastEventId) : 0;
	return { once: query.get("once") === "true", format, ...(limit === undefined ? {} : { limit }), lastSeq: format === "delta" ? last : 0 };
}

/** The author the platform sent, or undefined when absent or malformed. */
function parseAuthor(value: unknown): Author | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { kind, id, name, via } = value as Record<string, unknown>;
	if (!AUTHOR_KINDS.has(kind as string) || typeof id !== "string" || typeof name !== "string") return undefined;
	const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
	return {
		kind: kind as Author["kind"],
		id: id.slice(0, 64),
		name: clean(name),
		...(typeof via === "string" && clean(via) !== "" ? { via: clean(via) } : {}),
	};
}

/** The line that tells the model who is speaking (shared threads, where several people talk to the agent). */
export function speakerLine(author: Author): string {
	const name = author.name === "" ? "someone" : author.name;
	// A trigger's run (a schedule or a webhook): no person is speaking.
	if (author.kind === "trigger") return `[Message from trigger ${name}]`;
	if (author.kind === "agent") return `[Message from agent ${name}, who is asking you for help]`;
	return `[Message from ${name}${author.via === undefined ? "" : ` via ${author.via}`}]`;
}

class RequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** Platform conventions: `{"data": …}` on success, `{"error": {"code", "message"}}` otherwise. */
function json(response: ServerResponse, status: number, body: unknown): void {
	if (status === 204) {
		response.writeHead(204).end();
		return;
	}
	// Serialization can throw; let the handler send a JSON error before committing success headers.
	const text = JSON.stringify({ data: body });
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(text);
}

function fail(response: ServerResponse, status: number, code: string, message: string): void {
	const text = JSON.stringify({ error: { code, message } });
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(text);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) throw new RequestError(413, "request body too large");
		chunks.push(chunk as Buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	} catch {
		throw new RequestError(400, "invalid JSON");
	}
}
