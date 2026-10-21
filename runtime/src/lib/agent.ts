import type { RequestListener } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { AgentDoc, type Conversation, createRegistry, type Extension, Harness, type HarnessSettings, type ModelRef, type Storage, type ToolRegistration } from "@earendil-works/pi-durable";
import { ActivityReporter, ToolAudit } from "./audit.ts";
import { Approvals, parseApprovalPolicy } from "./approvals.ts";
import { redactArguments } from "./redact.ts";
import { assistantAgent } from "./assistant.ts";
import { PLATFORM_PERSON_WAIT_KINDS } from "./background.ts";
import {
	type AgentContext,
	type AgentDefinition,
	AgentDefinitionError,
	createConversationDocuments,
	createSessionDocuments,
	defineAgent,
	exposedDocuments,
	resolveExtensions,
	resolveSettings,
} from "./define.ts";
import { agentCallsExtension } from "./agent-calls.ts";
import { AgentMcp } from "./mcp.ts";
import { scheduleExtension } from "./schedule.ts";
import { createAgentModels } from "./models.ts";
import { createRuntimeServer } from "./server.ts";
import { AgentOwnedElsewhereError, openSqliteAgentStorage } from "./storage/sqlite.ts";
import { gatewayCall, gatewayPost, ThreadStatusReporter } from "./thread-status.ts";
import { ThreadStore } from "./threads.ts";
import { memoryExtension } from "./memory.ts";
import type { ImageContent, ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { imageProcessor } from "./images.ts";
import type { ChatAttachment } from "./view.ts";
import { ModelChoices } from "./model-choices.ts";
import { personExtension, TodoDoc } from "./person.ts";
import { parseWebTools, webExtension } from "./web.ts";
import { createWorkspaceEnv, parseWorkspaceTools, workspaceExtension } from "./workspace.ts";

/** Everything one agent needs, from the environment the app starts the runtime with. */
export type AgentConfig = {
	agentId: string;
	name: string;
	instructions: string;
	/** The agent's pi-durable storage file (`<agent dir>/state.sqlite`), owned by this process alone. */
	storagePath: string;
	/** Bearer token the app presents on every request. */
	token: string;
	/** Model, MCP and gateway settings (MODEL_*, MCP_*, PLATFORM_*), see models.ts and mcp.ts. */
	modelEnv: Record<string, string | undefined>;
};

/** Replacements for what the platform normally provides, for tests (see the test kit, `@pdp/runtime/testing`). */
export type StartOptions = {
	/** An open storage to use instead of the agent's SQLite file (`storagePath` is then unused). */
	storage?: Storage;
	/** Models to use instead of those MODEL_* describes. */
	models?: { models: MutableModels; model: ModelRef };
	/**
	 * The agent can't go on: its storage failed or its database connection was lost. The default logs and exits the
	 * process with status 1, so the supervisor starts a fresh one that resumes from storage (the runtime contract).
	 */
	onFatal?: (error: unknown) => void;
};

/** What a process serves for an agent: its HTTP handler, and a graceful stop. */
export type AgentProcess = {
	handler: RequestListener;
	close(): Promise<void>;
};

export type RunningAgent = AgentProcess & {
	handler: RequestListener;
	/** The open harness, for tests and tools that need to look at storage. */
	harness: Harness;
	threads: ThreadStore;
	/** Graceful stop: work in flight stays pending in storage and resumes on the next start. */
	close(): Promise<void>;
};

const ctx = BACKGROUND_CONTEXT;

export { AgentOwnedElsewhereError };

/**
 * Open the agent's storage (taking its ownership, see storage/sqlite.ts), install the definition's extensions and
 * the MCP servers' tools, resume unfinished work and return its HTTP handler. Throws AgentOwnedElsewhereError when
 * another process owns the agent. Once running, it calls `onFatal` (by default: exits the process) when storage
 * fails, so the supervisor starts a fresh one that resumes from storage. Which runtime version may open an agent's
 * storage is the app's decision, made before it starts the process (it reads `piDurableVersion` at `/status`).
 *
 * The library owns the extension selection: every thread selects the definition's extensions, then the MCP
 * servers', on creation, again before every message, and at start for runs a previous process left unfinished.
 */
export async function startAgent(config: AgentConfig, definition: AgentDefinition = assistantAgent, options: StartOptions = {}): Promise<RunningAgent> {
	const log = (...args: unknown[]) => console.log(`[agent ${config.agentId}]`, ...args);
	const logError = (...args: unknown[]) => console.error(`[agent ${config.agentId}]`, ...args);
	let closing = false;
	let fatal = false;
	const onFatal = (error: unknown) => {
		if (closing || fatal) return;
		fatal = true;
		if (options.onFatal) return options.onFatal(error);
		logError("storage failed; exiting so the agent restarts from storage", error instanceof Error ? error.message : error);
		process.exit(1);
	};

	defineAgent(definition);
	// Tool approvals: the template's (TOOL_APPROVALS) through the library's own extension, and authors' hooks through
	// the context. Bound to the harness once it is open.
	const approvals = new Approvals(parseApprovalPolicy(config.modelEnv.TOOL_APPROVALS));
	const context: AgentContext = { agentId: config.agentId, name: config.name, instructions: config.instructions, env: config.modelEnv, approvals };
	// The schedule tools, when the platform allows them for the agent's template version (and the definition doesn't
	// leave them out): after the definition's extensions, before the MCP servers'. They name their thread through the
	// thread store, which exists once the harness is open.
	let threadStore: ThreadStore | undefined;
	const scheduling =
		definition.schedules !== false &&
		config.modelEnv.PLATFORM_SCHEDULES === "true" &&
		!!config.modelEnv.PLATFORM_GATEWAY_URL &&
		!!config.modelEnv.PLATFORM_KEY;
	// The workspace (WORKSPACE_DIR) and the tools that work in it (WORKSPACE_TOOLS): after the definition's own, so a
	// definition's guard sees them; their file operations can't leave the workspace (workspace.ts).
	const workspaceDir = config.modelEnv.WORKSPACE_DIR;
	const workspaceTools = parseWorkspaceTools(config.modelEnv.WORKSPACE_TOOLS);
	if (workspaceTools.length > 0 && !workspaceDir) throw new AgentDefinitionError("WORKSPACE_TOOLS needs WORKSPACE_DIR");
	const workspaceTemp = workspaceDir ? (config.modelEnv.WORKSPACE_TEMP_DIR ?? `${workspaceDir.replace(/\/$/, "")}/../tmp`) : undefined;
	const workspace = workspaceExtension(workspaceTools, workspaceTemp ? { convertedDir: `${workspaceTemp.replace(/\/$/, "")}/converted` } : {});
	const workspaceEnv = workspaceDir ? createWorkspaceEnv({ root: workspaceDir, tempDir: workspaceTemp!, processEnv: config.modelEnv }) : undefined;
	// Tool preselection (fast judgments): with deferred tools (many MCP tools), the app may judge which ones a message
	// needs, and they are loaded before the model runs, as tool_search would (small models often skip tool_search).
	const pickTools =
		config.modelEnv.PLATFORM_GATEWAY_URL && config.modelEnv.PLATFORM_KEY
			? async (message: string, tools: { name: string; description: string }[]): Promise<string[]> => {
					const res = await fetch(`${config.modelEnv.PLATFORM_GATEWAY_URL!.replace(/\/$/, "")}/judge/tools`, {
						method: "POST",
						headers: { authorization: `Bearer ${config.modelEnv.PLATFORM_KEY}`, "content-type": "application/json" },
						body: JSON.stringify({ message, tools, limit: 8 }),
						signal: AbortSignal.timeout(6_000),
					});
					if (!res.ok) return [];
					return ((await res.json()) as { data?: { tools?: string[] } }).data?.tools ?? [];
				}
			: undefined;
	const preselect = async (conversation: Conversation, selection: readonly Extension[], message: string) => {
		const deferred = selection.flatMap((e) => (e.tools ?? []) as ToolRegistration[]).filter((t) => (t as { deferred?: boolean }).deferred === true);
		if (deferred.length === 0 || !pickTools) return;
		const stored = (await harness.snapshot(AgentDoc, conversation.id, ctx)) as { modelTools?: string[] | { add?: string[]; remove?: string[] } } | undefined;
		const current = stored?.modelTools;
		if (Array.isArray(current)) return; // an exact selection: not ours to change
		const loaded = new Set(current?.add ?? []);
		const candidates = deferred.filter((t) => !loaded.has(t.name));
		if (candidates.length === 0) return;
		const picked = await pickTools(
			message,
			candidates.map((t) => ({ name: t.name, description: (t.description ?? "").slice(0, 400) })),
		);
		if (picked.length === 0) return;
		const byName = new Map(deferred.map((t) => [t.name, t]));
		const add = [...loaded, ...picked].map((n) => byName.get(n)).filter((t): t is ToolRegistration => t !== undefined);
		const remove = (current?.remove ?? []).map((n) => byName.get(n)).filter((t): t is ToolRegistration => t !== undefined);
		await conversation.configure({ modelTools: { add, ...(remove.length ? { remove } : {}) } }, ctx);
	};
	// Working with the person (PERSON_TOOLS=on): ask_person, notify_person, todo.
	const person =
		config.modelEnv.PERSON_TOOLS === "on" && config.modelEnv.PLATFORM_GATEWAY_URL && config.modelEnv.PLATFORM_KEY
			? personExtension({
					gatewayUrl: config.modelEnv.PLATFORM_GATEWAY_URL,
					key: config.modelEnv.PLATFORM_KEY,
					threadOf: async (conversationId) => threadStore?.threadOf(conversationId),
				})
			: undefined;
	// Memory (MEMORY=on): the person's profile and the agent's own notes every turn, and the memory tools.
	const memory =
		config.modelEnv.MEMORY === "on" && config.modelEnv.PLATFORM_GATEWAY_URL && config.modelEnv.PLATFORM_KEY
			? memoryExtension({
					gatewayUrl: config.modelEnv.PLATFORM_GATEWAY_URL,
					key: config.modelEnv.PLATFORM_KEY,
					threadOf: async (conversationId) => threadStore?.threadOf(conversationId),
				})
			: undefined;
	// Web search and reading (WEB_TOOLS), through the gateway.
	const web =
		config.modelEnv.PLATFORM_GATEWAY_URL && config.modelEnv.PLATFORM_KEY
			? webExtension({ gatewayUrl: config.modelEnv.PLATFORM_GATEWAY_URL, key: config.modelEnv.PLATFORM_KEY, tools: parseWebTools(config.modelEnv.WEB_TOOLS) })
			: undefined;
	// Asking other agents (AGENT_CALLS, with the gateway): the app decides who may be asked (agent-calls.ts).
	const calling = config.modelEnv.AGENT_CALLS === "true" && !!config.modelEnv.PLATFORM_GATEWAY_URL && !!config.modelEnv.PLATFORM_KEY;
	const extensions = [
		...resolveExtensions(definition, context),
		...(workspace ? [workspace] : []),
		...(web ? [web] : []),
		...(memory ? [memory] : []),
		...(person ? [person] : []),
		...(calling
			? [
					agentCallsExtension({
						gatewayUrl: config.modelEnv.PLATFORM_GATEWAY_URL!,
						key: config.modelEnv.PLATFORM_KEY!,
						threadOf: async (conversationId) => threadStore?.threadOf(conversationId),
						stopping: () => closing,
					}),
				]
			: []),
		...(scheduling
			? [
					scheduleExtension({
						gatewayUrl: config.modelEnv.PLATFORM_GATEWAY_URL!,
						key: config.modelEnv.PLATFORM_KEY!,
						threadOf: async (conversationId) => threadStore?.threadOf(conversationId),
					}),
				]
			: []),
	];
	const settings = resolveSettings(definition, context);
	// The person tools' checklist is every agent's (when they're on), exposed beside the conversation.
	const withPerson = person && !(definition.documents ?? []).some((d) => d.definition.kind === TodoDoc.definition.kind)
		? { ...definition, documents: [...(definition.documents ?? []), TodoDoc], expose: [...(definition.expose ?? []), TodoDoc] }
		: definition;
	// Made with each conversation: the definition's documents. The checklist isn't: the todo tool makes it when first
	// written, so a conversation lists it (and the app shows it) only once there is one.
	const documents = definition.documents ?? [];
	const exposed = exposedDocuments(withPerson);

	const personWaits = new Set([...PLATFORM_PERSON_WAIT_KINDS, ...(definition.waitsForPerson ?? [])]);

	const created = options.models ? { ...options.models, source: "given", usage: undefined } : createAgentModels(config.modelEnv);
	const { models, model, usage } = created;
	// Models the person chose for single conversations (through the platform, loaded when first asked for).
	const choices =
		config.modelEnv.PLATFORM_GATEWAY_URL && config.modelEnv.PLATFORM_KEY
			? new ModelChoices({
					models,
					gatewayUrl: config.modelEnv.PLATFORM_GATEWAY_URL,
					key: config.modelEnv.PLATFORM_KEY,
					usageKey: config.modelEnv.MODEL_USAGE_KEY,
				})
			: undefined;
	log(`model ${model.provider}/${model.modelId} via ${created.source}${definition.name ? `; agent ${definition.name}` : ""}${scheduling ? "; schedules on" : ""}`);

	const storage = options.storage ?? (await openSqliteAgentStorage({ path: config.storagePath })).storage;

	const registry = createRegistry();
	for (const extension of extensions) registry.install(extension);
	// Asks (or refuses) as the agent's approval rules and profile say; selected last, so it sees the arguments other
	// hooks settled on and a call another hook blocks is never put to a person.
	const asking: Extension[] = [];
	// MCP servers: the template's, and those apps gave threads (installed before resuming, so resumed runs find their tools).
	const mcp = new AgentMcp(config.modelEnv, (ext) => registry.install(ext));
	for (const ext of mcp.extensions) registry.install(ext);
	await mcp.restore().catch((error: unknown) => logError("thread MCP servers:", (error as Error).message));

	// The default selection is what a conversation gets when nothing chose for it (one a tool creates, for instance):
	// the agent's extensions and the template's MCP servers, never another thread's servers.
	const base = (): Extension[] => [...extensions, ...mcp.extensions, ...asking];
	const harnessSettings: HarnessSettings = Object.defineProperties({}, {
		...Object.getOwnPropertyDescriptors(settings),
		extensions: { get: base, enumerable: true },
	});
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			settings: harnessSettings,
			...(workspaceDir
				? {
						env: () => workspaceEnv!,
					}
				: {}),
			conversationCreated: async (tx, conversation) => {
				await createConversationDocuments(tx, conversation, documents);
				await definition.conversationCreated?.(tx, conversation);
			},
			onReport: (error) => logError(error),
		},
		ctx,
	);
	if (documents.some((doc) => doc.definition.scope === "session")) await harness.commit((tx) => createSessionDocuments(tx, documents), ctx);

	const current: ModelRef = { provider: model.provider, modelId: model.modelId };
	// The model each thread's latest message runs on (the person's choice, or the agent's): what attached images suit.
	const usedModel = new Map<string, ModelRef>();
	const threads = new ThreadStore(harness, () => ({ model: current, extensions: base() }));
	threadStore = threads;
	// Calls to the template's MCP servers through the platform name their thread, so the platform can say who they are for.
	mcp.threadOf = (conversationId) => threads.threadOf(conversationId);
	const env = config.modelEnv;
	const gateway = env.PLATFORM_GATEWAY_URL && env.PLATFORM_KEY ? gatewayCall(env.PLATFORM_GATEWAY_URL, env.PLATFORM_KEY) : undefined;
	await approvals.bind(harness, threads, gateway);
	// MCP tools' annotations (read-only, destructive) tell the approval rules what a tool does.
	approvals.toolInfo = (name) => mcp.toolInfo(name);
	// Fast judgments: a call the rules would let run may be judged risky by the platform (and then asks). Only ever
	// tightens; without a platform, or when it fails or doesn't answer, the rules stand.
	if (env.PLATFORM_GATEWAY_URL && env.PLATFORM_KEY) {
		approvals.judge = async (call, signal) => {
			const res = await fetch(`${env.PLATFORM_GATEWAY_URL!.replace(/\/$/, "")}/judge/approval`, {
				method: "POST",
				headers: { authorization: `Bearer ${env.PLATFORM_KEY}`, "content-type": "application/json" },
				body: JSON.stringify({ tool: call.name, arguments: redactArguments(call.arguments ?? {}) }),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6_000)]) : AbortSignal.timeout(6_000),
			});
			if (!res.ok) return false;
			return ((await res.json()) as { data?: { risky?: boolean } }).data?.risky === true;
		};
	}
	// Selected when the policy asks or refuses anything (the platform always sends the built-in rules, so it does), or
	// while a request it made is pending. A policy pushed later (POST /approvals/policy) only takes effect in an agent
	// that has it selected.
	if (approvals.active() || approvals.pending().length > 0) asking.push(approvals.extension());
	// The audit log: each tool call that ends is reported to the platform (audit.ts). It only watches, so it is selected
	// last, after the approvals, and is always there when there is a platform to tell.
	const activity =
		env.PLATFORM_GATEWAY_URL && env.PLATFORM_KEY ? new ActivityReporter(gatewayPost(env.PLATFORM_GATEWAY_URL, env.PLATFORM_KEY)) : undefined;
	if (activity) {
		const audit = new ToolAudit(activity, { approvalFor: (conversationId, callId) => approvals.forCall(conversationId, callId), threadOf: async (conversationId) => (await threads.threadOf(conversationId)) ?? (await approvals.placeOf(conversationId).catch(() => undefined))?.threadId });
		audit.bind(harness);
		asking.push(audit.extension());
	}
	for (const extension of asking) registry.install(extension);
	// pi keeps the model and extensions a conversation was created with (pi.agent). A thread begun before the agent's
	// model changed would keep asking for the old one, which this runtime no longer has (its turns would end unanswered,
	// no_model), and one begun before an extension was added would run without it (a guard, say). So the runtime moves
	// every thread to the agent's model and selection: here, before resuming, for runs a previous process left
	// unfinished, and before every message (an equal value writes nothing).
	// A conversation the person gave a model of its own (MessageChoice) keeps it, and its thinking level.
	const align = (conversation: Conversation, selection: readonly Extension[], use: ModelRef = current, thinking?: ModelThinkingLevel | null) =>
		conversation.configure({ model: use, extensions: [...selection], ...(thinking === undefined ? {} : { thinkingLevel: thinking }) }, ctx);
	for (const record of await threads.list()) {
		const selection = [...extensions, ...mcp.installed(record.threadId), ...asking];
		const stored = await harness.snapshot(AgentDoc, record.conversationId as never, ctx);
		const chosen = ModelChoices.catalogIdOf(stored?.model);
		const use = chosen && choices ? await choices.ref(chosen).catch(() => current) : current;
		if (sameSelection(stored, use, selection)) continue;
		const conversation = await threads.get(record.threadId);
		if (conversation !== undefined) await align(conversation, selection, use);
	}
	// Continue runs, tool calls and queued input left by a previous process.
	harness.resume();
	void approvals.sync().catch((error: unknown) => logError("approvals sync:", (error as Error).message));
	harness.closed.then((end) => {
		if (end.reason === "failed") onFatal(end.error);
	});

	// The platform keeps a record of every thread and its status (so listing doesn't wake the agent).
	const status =
		env.PLATFORM_GATEWAY_URL && env.PLATFORM_KEY
			? new ThreadStatusReporter(harness, threads, gatewayPost(env.PLATFORM_GATEWAY_URL, env.PLATFORM_KEY))
			: undefined;
	// Before the runtime says it is ready (at most 3 s): a sync arriving later could report a thread idle just after
	// the platform marked it busy for a message on its way.
	if (status) {
		const synced = status.sync().catch((error: unknown) => logError("thread sync:", (error as Error).message));
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([synced, new Promise<void>((resolve) => (timer = setTimeout(resolve, 3_000)))]);
		clearTimeout(timer);
	}
	const { handler, touch } = createRuntimeServer({
		harness,
		threads,
		token: config.token,
		info: { agentId: config.agentId, name: config.name, model: `${model.provider}/${model.modelId}` },
		beforeMessage: async (threadId, conversation, text, choice) => {
			const servers = await mcp.forThread(threadId).catch((error: unknown) => {
				logError(`MCP servers of thread ${threadId}:`, (error as Error).message);
				return mcp.extensions;
			});
			const selection = [...extensions, ...servers, ...asking];
			// The person's choice for this conversation; a model that can't be loaded answers with the agent's own.
			let use = current;
			if (choice.model && choices) {
				use = await choices.ref(choice.model).catch((error: unknown) => {
					logError(`model ${choice.model} for thread ${threadId}:`, (error as Error).message);
					return current;
				});
			}
			await align(conversation, selection, use, thinkingOf(choice.thinking));
			usedModel.set(threadId, use);
			if (pickTools) await preselect(conversation, selection, text).catch((error: unknown) => logError("tool preselection:", (error as Error).message));
		},
		// Attached images, for a model that sees them: in the message itself (resized to fit), not only named.
		inputFor: async (threadId, text, attachments) => {
			const images = attachments.filter(isImageFile).slice(0, MAX_INLINE_IMAGES);
			if (images.length === 0 || workspaceEnv === undefined) return text;
			const ref = usedModel.get(threadId) ?? current;
			const target = models.getModel(ref.provider, ref.modelId);
			if (target !== undefined && !target.input.includes("image")) {
				return `${text}\n(The model answering can't see images: ${images.map((file) => file.name).join(", ")} ${images.length === 1 ? "is" : "are"} only named here.)`;
			}
			const resize = target?.inputLimits?.images?.resize;
			const limits = {
				maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
				maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
				maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
			};
			const parts: (TextContent | ImageContent)[] = [{ type: "text", text }];
			for (const file of images) {
				const bytes = await workspaceEnv.readBinaryFile(file.path, ctx);
				if (!bytes.ok) continue;
				const prepared = await imageProcessor.prepare(bytes.value, imageTypeOf(file), limits).catch(() => undefined);
				if (prepared) parts.push({ type: "image", data: prepared.data, mimeType: prepared.mimeType });
			}
			return parts.length > 1 ? parts : text;
		},
		approvals,
		afterMessage: status ? (threadId, submissionId) => status.watch(threadId, submissionId) : undefined,
		documents: exposed,
		waitsForPerson: (kind) => personWaits.has(kind),
	});
	// A reply that just ended is recent work: the reaper waits a full idle period after it.
	if (status) status.onReplyEnd = touch;
	return {
		handler,
		harness,
		threads,
		close: async () => {
			closing = true;
			approvals.close();
			await harness.close(ctx).catch(() => {});
			await activity?.stop();
			await usage?.flush();
			await choices?.flush();
			await mcp.close();
			await status?.stop();
		},
	};
}

/** Whether a conversation's stored agent already has this model and exactly this extension selection. */
/** At most this many attached images go in a message itself; the rest are only named (the agent may read them). */
const MAX_INLINE_IMAGES = 5;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };

function imageTypeOf(file: ChatAttachment): string {
	if (file.mediaType.startsWith("image/")) return file.mediaType;
	return IMAGE_TYPES[file.path.split(".").pop()?.toLowerCase() ?? ""] ?? "";
}

function isImageFile(file: ChatAttachment): boolean {
	return Object.values(IMAGE_TYPES).includes(imageTypeOf(file));
}

/** A chosen thinking level for pi ("" or unknown: none, the model's default). */
function thinkingOf(level: string): ModelThinkingLevel | null {
	return level === "off" || level === "low" || level === "medium" || level === "high" ? level : null;
}

function sameSelection(stored: { model?: ModelRef; extensions?: unknown } | undefined, model: ModelRef, selection: readonly Extension[]): boolean {
	if (stored === undefined) return false;
	if (stored.model?.provider !== model.provider || stored.model?.modelId !== model.modelId) return false;
	const names = stored.extensions;
	return Array.isArray(names) && names.length === selection.length && names.every((name, i) => name === selection[i]!.name);
}
