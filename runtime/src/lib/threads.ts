import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentChange, type Conversation, defineDoc, type Harness } from "@earendil-works/pi-durable";

export type ThreadRecord = { threadId: string; conversationId: number; title: string; createdAt: number; updatedAt: number };
type ThreadsState = { threads: Record<string, Omit<ThreadRecord, "threadId">> };

/** Maps client thread IDs to Pi conversation IDs, committed atomically with the conversation it points at. */
export const ThreadsDoc = defineDoc<ThreadsState>({
	kind: "pdp.threads",
	version: 1,
	scope: "session",
	initial: () => ({ threads: {} }),
});

const ctx = BACKGROUND_CONTEXT;

export class ThreadStore {
	private readonly creating = new Map<string, Promise<Conversation>>();

	constructor(
		private readonly harness: Harness,
		private readonly agent: () => AgentChange,
	) {}

	async get(threadId: string): Promise<Conversation | undefined> {
		const record = (await this.harness.snapshot(ThreadsDoc, ctx))?.threads[threadId];
		if (record === undefined) return undefined;
		return this.harness.conversation(record.conversationId as Conversation["id"], ctx);
	}

	/** Get or create; the process owns the storage, so an in-process guard is enough against double creation. */
	async ensure(threadId: string, firstMessage: string): Promise<Conversation> {
		const existing = await this.get(threadId);
		if (existing !== undefined) {
			// An untitled thread (a fork that started empty) takes its title from its first message.
			await this.harness.commit(async (tx) => {
				const record = (await tx.doc(ThreadsDoc)).threads[threadId];
				if (record !== undefined && record.title === "") record.title = titleFrom(firstMessage);
			}, ctx);
			return existing;
		}
		const pending = this.creating.get(threadId);
		if (pending !== undefined) return pending;
		const created = this.harness
			.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: this.agent(),
					init: async (tx, conversationId) => {
						const now = Date.now();
						(await tx.doc(ThreadsDoc)).threads[threadId] = { conversationId, title: titleFrom(firstMessage), createdAt: now, updatedAt: now };
					},
				},
				ctx,
			)
			.finally(() => this.creating.delete(threadId));
		this.creating.set(threadId, created);
		return created;
	}

	async touch(threadId: string): Promise<void> {
		await this.harness.commit(async (tx) => {
			const record = (await tx.doc(ThreadsDoc)).threads[threadId];
			if (record !== undefined) record.updatedAt = Date.now();
		}, ctx);
	}

	/**
	 * A new thread from an existing one (edit a message, branch a conversation): `at`, the newest entry of the source
	 * the new thread keeps (its transcript up to there, then its own); undefined starts it empty. The source is
	 * untouched. Answers undefined when the source doesn't exist, and throws when the new ID is taken.
	 */
	async fork(sourceId: string, threadId: string, at: number | undefined): Promise<Conversation | undefined> {
		const source = (await this.harness.snapshot(ThreadsDoc, ctx))?.threads[sourceId];
		if (source === undefined) return undefined;
		if ((await this.get(threadId)) !== undefined || this.creating.has(threadId)) throw new Error(`thread ${threadId} exists`);
		const options = {
			ownership: { kind: "ownerless" as const },
			agent: this.agent(),
			init: async (tx: Parameters<NonNullable<Parameters<Harness["createConversation"]>[0]["init"]>>[0], conversationId: number) => {
				const now = Date.now();
				// A fork that starts empty (editing the first message) is titled by its own first message.
				const title = at === undefined ? "" : source.title;
				(await tx.doc(ThreadsDoc)).threads[threadId] = { conversationId, title, createdAt: now, updatedAt: now };
			},
		};
		let created: Promise<Conversation>;
		if (at === undefined) created = this.harness.createConversation(options as never, ctx);
		else {
			const parent = await this.harness.conversation(source.conversationId as Conversation["id"], ctx);
			if (parent === undefined) return undefined;
			created = parent.fork(at as never, options as never, ctx);
		}
		this.creating.set(threadId, created);
		try {
			return await created;
		} finally {
			this.creating.delete(threadId);
		}
	}

	async remove(threadId: string): Promise<boolean> {
		return this.harness.commit(async (tx) => {
			const threads = (await tx.doc(ThreadsDoc)).threads;
			if (threads[threadId] === undefined) return false;
			delete threads[threadId];
			return true;
		}, ctx);
	}

	/** The thread a conversation belongs to (undefined: none, such as a task's own conversation). */
	async threadOf(conversationId: number): Promise<string | undefined> {
		const state = await this.harness.snapshot(ThreadsDoc, ctx);
		return Object.entries(state?.threads ?? {}).find(([, record]) => record.conversationId === conversationId)?.[0];
	}

	async list(): Promise<ThreadRecord[]> {
		const state = await this.harness.snapshot(ThreadsDoc, ctx);
		return Object.entries(state?.threads ?? {})
			.map(([threadId, record]) => ({ threadId, ...record }))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}
}

function titleFrom(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	if (line.length === 0) return "New chat";
	return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
