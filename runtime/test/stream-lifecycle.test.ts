import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeServer } from "../src/lib/server.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

class Response extends EventEmitter {
	destroyed = false;
	writableEnded = false;
	headersSent = false;
	statusCode = 200;
	write = vi.fn((_data: string) => true);
	writeHead = vi.fn((status: number) => { this.statusCode = status; this.headersSent = true; return this; });
	end = vi.fn((data?: string) => { if (data) this.write(data); this.writableEnded = true; return this; });
}

function fixture() {
	const closed = deferred<void>();
	const docClosed = deferred<void>();
	const entries = [
		{ id: 1, conversationId: 1, kind: "pi.assistant", byTaskId: 10, model: [{ role: "assistant", timestamp: 1, stopReason: "toolUse", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "echo fixture" } }] }] },
		{ id: 2, conversationId: 1, kind: "pi.tool-result", byTaskId: 20, model: [{ role: "toolResult", timestamp: 2, toolCallId: "c", toolName: "bash", isError: false, content: [{ type: "text", text: "fixture" }] }] },
	];
	const value = { entries, docs: {} };
	let onChange: ((v: typeof value) => Promise<void>) | undefined;
	const watch = {
		value, closed: closed.promise,
		start: vi.fn((callback) => { onChange = callback; }),
		stop: vi.fn(async () => { closed.resolve(); }),
	};
	const docWatch = { value: { fixture: true }, closed: docClosed.promise, start: vi.fn(), stop: vi.fn(async () => { docClosed.resolve(); }) };
	const harness = {
		getTask: vi.fn(async (_id: number): Promise<unknown> => undefined),
		watchDoc: vi.fn(async () => docWatch),
		inspect: vi.fn(async () => ({ tasks: [] })),
		taskGraph: vi.fn(async () => ({ value: { tasks: {} }, dispose() {} })),
	};
	const conversation = { id: 1, watch: vi.fn(async () => watch) };
	const unsubscribe = vi.fn();
	const approvals = {
		viewOf: vi.fn(() => ({ byTask: new Map(), pending: [] })),
		onChange: vi.fn(() => unsubscribe),
		waiting: vi.fn(() => ({ pending: 0, threads: new Set() })),
	};
	const runtime = createRuntimeServer({
		harness: harness as never, threads: { get: vi.fn(async () => conversation), list: vi.fn(async () => []) } as never,
		token: "fixture", info: { agentId: "fixture", name: "Fixture", model: "fake" }, approvals: approvals as never,
		documents: new Map([["fixture", { document: {} as never, maxBytes: 1000 }]]),
	});
	const request = (url: string) => Object.assign(new EventEmitter(), { method: "GET", url, headers: { authorization: "Bearer fixture" }, destroyed: false });
	const req = request("/threads/t/events");
	const res = new Response();
	const start = () => runtime.handler(req as IncomingMessage, res as unknown as ServerResponse);
	const disconnect = () => { req.destroyed = true; res.destroyed = true; req.emit("close"); res.emit("close"); };
	const status = async () => {
		const response = new Response();
		runtime.handler(request("/status") as IncomingMessage, response as unknown as ServerResponse);
		await vi.waitFor(() => expect(response.end).toHaveBeenCalled());
		return JSON.parse(response.write.mock.calls.map(([s]) => s).join("")).data.openStreams;
	};
	return { start, disconnect, req, res, watch, docWatch, conversation, harness, approvals, unsubscribe, status, change: async () => onChange?.({ ...value, entries: [...entries] }) };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("SSE initialization and queued frame cleanup", () => {
	it("disconnect during delayed first task lookup stops both watches and never starts the stream", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const lookup = deferred<unknown>();
		f.harness.getTask.mockImplementation(() => lookup.promise);
		f.start();
		await vi.waitFor(() => expect(f.harness.getTask).toHaveBeenCalledOnce());
		f.disconnect();
		expect(f.watch.stop).toHaveBeenCalledOnce();
		expect(f.docWatch.stop).toHaveBeenCalledOnce();
		lookup.resolve(undefined);
		await vi.waitFor(async () => expect(await f.status()).toBe(0));
		expect(f.watch.start).not.toHaveBeenCalled();
		expect(f.approvals.onChange).not.toHaveBeenCalled();
		expect(f.res.write).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("lookup rejection after close cannot end or write the closed response", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const lookup = deferred<unknown>();
		f.harness.getTask.mockImplementation(() => lookup.promise);
		f.start();
		await vi.waitFor(() => expect(f.harness.getTask).toHaveBeenCalledOnce());
		f.req.emit("close"); // rely on our close guard, not response.destroyed being set first
		lookup.reject(new Error("lookup finished after disconnect"));
		await vi.waitFor(async () => expect(await f.status()).toBe(0));
		expect(f.watch.stop).toHaveBeenCalledOnce();
		expect(f.docWatch.stop).toHaveBeenCalledOnce();
		expect(f.res.write).not.toHaveBeenCalled();
		expect(f.res.end).not.toHaveBeenCalled();
		expect(f.watch.start).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejected initial task lookup ends sent SSE headers safely and stops all watches", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const f = fixture();
		f.harness.getTask.mockRejectedValue(new Error("synthetic lookup failure"));
		f.start();
		await vi.waitFor(() => expect(f.res.end).toHaveBeenCalledOnce());
		expect(f.res.writeHead).toHaveBeenCalledOnce(); // no JSON error headers after the SSE headers
		expect(f.res.write).not.toHaveBeenCalled();
		expect(f.watch.stop).toHaveBeenCalledOnce();
		expect(f.docWatch.stop).toHaveBeenCalledOnce();
		expect(f.watch.start).not.toHaveBeenCalled();
		expect(await f.status()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		f.disconnect();
		expect(f.watch.stop).toHaveBeenCalledOnce();
	});

	it("failed document initialization stops the acquired watch and sends one ordinary error before SSE headers", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const f = fixture();
		f.harness.watchDoc.mockRejectedValue(new Error("synthetic document failure"));
		f.start();
		await vi.waitFor(() => expect(f.res.end).toHaveBeenCalledOnce());
		expect(f.res.statusCode).toBe(500);
		expect(f.res.writeHead).toHaveBeenCalledOnce();
		expect(f.watch.stop).toHaveBeenCalledOnce();
		expect(f.watch.start).not.toHaveBeenCalled();
		expect(f.harness.getTask).not.toHaveBeenCalled();
		expect(await f.status()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("close cancels an in-flight frame, an already queued frame, timers and the counted subscription", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.start();
		await vi.waitFor(() => expect(f.watch.start).toHaveBeenCalledOnce());
		expect(await f.status()).toBe(1);
		const writes = f.res.write.mock.calls.length;
		const lookup = deferred<unknown>();
		f.harness.getTask.mockImplementation(() => lookup.promise);
		await f.change();
		await vi.advanceTimersByTimeAsync(100);
		expect(f.harness.getTask).toHaveBeenCalledTimes(2);
		await f.change();
		await vi.advanceTimersByTimeAsync(100); // queued behind the previous frame
		f.disconnect();
		expect(f.unsubscribe).toHaveBeenCalledOnce();
		expect(f.watch.stop).toHaveBeenCalledOnce();
		expect(f.docWatch.stop).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		lookup.resolve(undefined);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(f.harness.getTask).toHaveBeenCalledTimes(2); // queued frame never looked up tasks
		expect(f.res.write).toHaveBeenCalledTimes(writes);
		expect(await f.status()).toBe(0);
		await f.change(); // late watch/doc callback cannot schedule another frame
		expect(vi.getTimerCount()).toBe(0);
	});

	it("disconnect before conversation.watch resolves stops the late-acquired watch", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const pending = deferred<typeof f.watch>();
		f.conversation.watch.mockImplementation(() => pending.promise);
		f.start();
		await vi.waitFor(() => expect(f.conversation.watch).toHaveBeenCalledOnce());
		f.disconnect();
		pending.resolve(f.watch);
		await vi.waitFor(() => expect(f.watch.stop).toHaveBeenCalledOnce());
		expect(f.harness.watchDoc).not.toHaveBeenCalled();
		expect(f.res.writeHead).not.toHaveBeenCalled();
		expect(await f.status()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
