import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord, Harness, LiveState } from "@earendil-works/pi-durable";

/** Presentation identity, not the provider's protocol ID. Stable before execution and after reload/paging. */
export const callInstance = (messageId: string, callId: string): string => `${messageId}/tool/${encodeURIComponent(callId)}`;
export const taskIdentity = (id: unknown): string => `t${id}`;
export type CallIdentities = {
	byTask: ReadonlyMap<string, string>;
	byInstance: ReadonlyMap<string, string>;
	results: ReadonlyMap<string, string>;
	liveSources: ReadonlyMap<number, string>;
};
export const entryMessageId = (entry: EntryRecord, index: number): string => index === 0 ? `e${entry.id}` : `e${entry.id}:${index}`;

/**
 * Resolve durable tool-task inputs, never a thread-global provider-ID match. Task inputs are immutable; cache only
 * successful reads. Synthetic results (unavailable/unstarted calls) share their assistant's generation task instead.
 */
export class CallIdentityReader {
	private readonly sources = new Map<string, string>();
	constructor(private readonly harness: Harness) {}

	async read(entries: readonly EntryRecord[], live?: Readonly<LiveState>): Promise<CallIdentities> {
		const ids = new Set<number>();
		for (const entry of entries) if (entry.byTaskId !== undefined && entry.model?.some((m) => m.role === "toolResult")) ids.add(Number(entry.byTaskId));
		for (const slot of live?.tools ?? []) if (slot.taskId !== undefined) ids.add(Number(slot.taskId));
		await Promise.all([...ids].map(async (id) => {
			const key = taskIdentity(id);
			if (this.sources.has(key)) return;
			const task = await this.harness.getTask(id as never, BACKGROUND_CONTEXT);
			const input = task?.input as { kind?: string; assistant?: number; callId?: string } | undefined;
			if (task?.kind === "pi.tool" && input?.kind !== "nested" && typeof input?.assistant === "number" && typeof input.callId === "string") {
				this.sources.set(key, callInstance(`e${input.assistant}`, input.callId));
			}
		}));
		const byTask = new Map<string, string>();
		for (const id of ids) {
			const key = taskIdentity(id);
			const source = this.sources.get(key);
			if (source !== undefined) byTask.set(key, source);
		}
		const byInstance = new Map([...byTask].map(([task, source]) => [source, task]));
		const generated = new Map<string, string[]>();
		for (const entry of entries) {
			if (entry.byTaskId === undefined) continue;
			(entry.model ?? []).forEach((message, index) => {
				if (message.role !== "assistant") return;
				for (const block of message.content) if (block.type === "toolCall") {
					const key = `${taskIdentity(entry.byTaskId)}/${block.id}`;
					generated.set(key, [...(generated.get(key) ?? []), callInstance(entryMessageId(entry, index), block.id)]);
				}
			});
		}
		const results = new Map<string, string>();
		for (const entry of entries) {
			if (entry.byTaskId === undefined) continue;
			(entry.model ?? []).forEach((message, index) => {
				if (message.role !== "toolResult") return;
				const task = taskIdentity(entry.byTaskId);
				const candidates = generated.get(`${task}/${message.toolCallId}`);
				const source = byTask.get(task) ?? (candidates?.length === 1 ? candidates[0] : undefined);
				if (source !== undefined) results.set(entryMessageId(entry, index), source);
			});
		}
		const liveSources = new Map<number, string>();
		(live?.tools ?? []).forEach((slot, index) => {
			const candidates = generated.get(`${taskIdentity(live?.run?.taskId)}/${slot.callId}`);
			const source = slot.taskId === undefined ? (candidates?.length === 1 ? candidates[0] : undefined) : byTask.get(taskIdentity(slot.taskId));
			if (source !== undefined) liveSources.set(index, source);
		});
		return { byTask, byInstance, results, liveSources };
	}
}
