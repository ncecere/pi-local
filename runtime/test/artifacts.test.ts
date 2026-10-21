import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fakeModel, memoryStorage, startTestAgent, toolCall } from "@pdp/runtime/testing";
import { assistantAgent, defineDoc, startAgent } from "@pdp/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeServer } from "../src/lib/server.ts";
import { tempStoragePath } from "./support.ts";
import {
	ARTIFACT_CONTENT_BYTES,
	ARTIFACT_DOCUMENT_BYTES,
	type Artifact,
	type Artifacts,
	type ArtifactVersion,
	ArtifactsDoc,
	type ArtifactWrite,
	updateArtifact,
	validateArtifactWrite,
} from "../src/lib/artifacts.ts";

const write: ArtifactWrite = { title: "Report", type: "markdown", content: "# First" };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(() => new Promise<void>((resolve, reject) => {
		server.closeAllConnections();
		server.close((error) => error ? reject(error) : resolve());
	}));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe.each(["memory", "sqlite"] as const)("artifact HTTP edits on %s storage", (storage) => {
	it("returns parsed revisions with fully retained history after repeated commits", async () => {
		const model = fakeModel();
		const token = "artifact-regression-token";
		const agent = await startAgent({
			agentId: "artifact-regression",
			name: "Artifact regression",
			instructions: "Test artifacts.",
			storagePath: storage === "sqlite" ? await tempStoragePath(cleanup) : ":memory:",
			token,
			modelEnv: { PERSON_TOOLS: "on" },
		}, assistantAgent, { models: model, ...(storage === "memory" ? { storage: memoryStorage().open() } : {}) });
		cleanup.push(() => agent.close());
		const baseUrl = await listen(createServer(agent.handler));
		const conversation = await agent.threads.ensure("t", "Test");
		model.reply(toolCall("artifact", write), "Saved.");
		const submission = await conversation.submit({ type: "input", content: "Create artifact" }, BACKGROUND_CONTEXT);
		expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		const initial = (await agent.harness.snapshot(ArtifactsDoc, conversation.id, BACKGROUND_CONTEXT))!.artifacts[0]!;
		const path = `/threads/t/artifacts/${initial.id}`;
		const call = (suffix = "", body?: unknown) => fetch(baseUrl + path + suffix, {
			method: body === undefined ? "GET" : "PUT",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const { id: _id, versions: _versions, ...firstVersion } = initial;
		const history: ArtifactVersion[] = [firstVersion];
		for (let revision = 2; revision <= 6; revision++) {
			const edit = {
				title: `Report ${revision}`,
				type: revision % 2 ? "code" : "markdown",
				...(revision % 2 ? { language: "ts" } : {}),
				content: `Revision ${revision}: \"quoted\"\nline`,
				expectedRevision: revision - 1,
			};
			const response = await call("", edit);
			expect(response.status).toBe(200);
			const { data } = await response.json() as { data: Artifact };
			expect(data).toEqual({
				id: initial.id,
				title: edit.title,
				type: edit.type,
				...(revision % 2 ? { language: "ts" } : {}),
				content: edit.content,
				revision,
				updatedAt: expect.any(Number),
				versions: history.slice(-3),
			});
			expect((await (await call()).json()).data).toEqual(data);
			expect((await (await call("/history")).json()).data).toEqual(history.slice(-3));
			expect((await agent.harness.snapshot(ArtifactsDoc, conversation.id, BACKGROUND_CONTEXT))!.artifacts[0]).toEqual(data);
			const { id: _id, versions: _versions, ...version } = data;
			history.push(version);
		}
		const conflict = await call("", { ...write, expectedRevision: 1 });
		expect(conflict.status).toBe(409);
		expect((await conflict.json()).error.code).toBe("revision_conflict");
		const oversized = await call("", { ...write, content: "x".repeat(ARTIFACT_CONTENT_BYTES + 1), expectedRevision: 6 });
		expect(oversized.status).toBe(422);
		expect((await oversized.json()).error.code).toBe("artifact_too_large");
		expect((await (await call()).json()).data.revision).toBe(6);
	}, 30_000);
});

it("returns a JSON error, not an empty 200, when response serialization fails", async () => {
	const agent = await startTestAgent();
	cleanup.push(() => agent.close());
	await agent.agent.threads.ensure("t", "Test");
	const artifact = updateArtifact({ artifacts: [] }, write, "a", 1).artifact;
	const broken = Object.assign(artifact, { toJSON() { throw new Error("serialization failed"); } });
	const { server } = createRuntimeServer({
		harness: agent.harness,
		threads: agent.agent.threads,
		token: agent.token,
		info: { agentId: "test", name: "Test", model: "test" },
		artifacts: { read: async () => broken, edit: async () => broken },
	});
	const baseUrl = await listen(server);
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const response = await fetch(`${baseUrl}/threads/t/artifacts/a`, { headers: { authorization: `Bearer ${agent.token}` } });
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: { code: "internal", message: "Internal error" } });
	} finally {
		log.mockRestore();
	}
});

describe("artifact validation and pure updates", () => {
	it("bounds UTF-8 revisions, count, metadata and JSON serialization, without modifying input", () => {
		expect(validateArtifactWrite({ ...write, content: "x".repeat(ARTIFACT_CONTENT_BYTES) }).content.length).toBe(ARTIFACT_CONTENT_BYTES);
		expect(() => validateArtifactWrite({ ...write, content: "é".repeat(ARTIFACT_CONTENT_BYTES / 2 + 1) })).toThrow(/64 KiB/);
		expect(() => validateArtifactWrite({ ...write, title: "a".repeat(201) })).toThrow(/Title/);
		expect(() => validateArtifactWrite({ ...write, id: "../other" })).toThrow(/IDs/);
		let doc: Artifacts = { artifacts: [] };
		for (let i = 0; i < 10; i++) doc = updateArtifact(doc, { ...write, title: `a${i}` }, `a${i}`, 1).document;
		const before = JSON.stringify(doc);
		expect(() => updateArtifact(doc, { ...write, title: "eleven" }, "a11", 2)).toThrow(/10 artifacts/);
		expect(JSON.stringify(doc)).toBe(before);
		// Control characters fit in 64 KiB as UTF-8 but expand six-fold in JSON; history counts too.
		const big = { ...write, content: "\0".repeat(ARTIFACT_CONTENT_BYTES) };
		const first = updateArtifact({ artifacts: [] }, big, "big", 1).document;
		expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(ARTIFACT_DOCUMENT_BYTES);
		expect(() => updateArtifact(first, { ...big, id: "big", expectedRevision: 1 }, "big", 2)).toThrow(/750 KiB/);
		expect(first.artifacts[0]!.revision).toBe(1);
	});
	it("keeps stable IDs, requires the latest revision, and retains only three historical versions", () => {
		let result = updateArtifact({ artifacts: [] }, write, "a", 1);
		expect(() => updateArtifact(result.document, { ...write, id: "a" }, "unused", 2)).toThrow(/current revision 1/);
		expect(() => updateArtifact(result.document, { ...write, id: "missing", expectedRevision: 1 }, "unused", 2)).toThrow(
			/no such artifact/,
		);
		for (let revision = 1; revision <= 5; revision++)
			result = updateArtifact(
				result.document,
				{ ...write, id: "a", expectedRevision: revision, content: String(revision + 1) },
				"unused",
				revision + 1,
			);
		expect(result.artifact.id).toBe("a");
		expect(result.artifact.revision).toBe(6);
		expect(result.artifact.versions.map((v) => v.revision)).toEqual([3, 4, 5]);
	});
});

it("lazily persists tool writes, merges exposed docs, edits atomically, survives restart and forks current independently", async () => {
	const Notes = defineDoc({ kind: "test.notes", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ note: "kept" }) });
	const definition = { ...assistantAgent, documents: [Notes], expose: [Notes] };
	const agent = await startTestAgent(definition, { env: { PERSON_TOOLS: "on" } });
	cleanup.push(() => agent.close());
	const call = (path: string, method = "GET", body?: unknown) =>
		fetch(agent.baseUrl + path, {
			method,
			headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	await agent.agent.threads.ensure("t", "Test");
	expect(await agent.document("t", "artifacts")).toBeUndefined();
	expect((await call("/threads/t/artifacts/missing", "PUT", { ...write, expectedRevision: 1 })).status).toBe(404);
	expect(await agent.document("t", "artifacts")).toBeUndefined();
	expect((await agent.document("t", "test.notes"))!.value).toEqual({ note: "kept" });
	agent.model.reply(toolCall("artifact", write), "Saved.");
	await agent.send("t", "make it");
	const view = await agent.settled("t");
	const a = ((await agent.document("t", "artifacts"))!.value as Artifacts).artifacts[0]!;
	expect(view.documents?.artifacts).toBeDefined();
	expect(view.documents?.["test.notes"]).toBeDefined();
	expect(view.messages.find((m) => m.role === "tool")).toMatchObject({
		details: { id: a.id, title: "Report", revision: 1, reference: `artifacts/${a.id}` },
	});
	const path = `/threads/t/artifacts/${a.id}`;
	const edit = { ...write, content: "Manual", expectedRevision: 1 };
	const [one, two] = await Promise.all([call(path, "PUT", edit), call(path, "PUT", edit)]);
	expect([one.status, two.status].sort()).toEqual([200, 409]);
	expect((await (await call(`${path}/history`)).json()).data[0].content).toBe("# First");
	expect((await call(`/threads/other/artifacts/${a.id}`)).status).toBe(404);
	expect((await call(path, "PUT", { ...edit, expectedRevision: undefined })).status).toBe(400);
	expect((await call(path + "/workspace", "POST", { path: "x", expectedRevision: 2 })).status).toBe(403);
	const conversation = (await agent.agent.threads.get("t"))!;
	expect((await agent.harness.snapshot(ArtifactsDoc, conversation.id, BACKGROUND_CONTEXT))!.artifacts[0]!.revision).toBe(2);
	expect((await call("/threads/t/fork", "POST", { threadId: "branch", afterMessageId: view.messages[0]!.id })).status).toBe(201);
	const forked = (await agent.document("branch", "artifacts"))!.value as Artifacts;
	expect(forked.artifacts[0]!.content).toBe("Manual");
	expect((await call(`/threads/branch/artifacts/${a.id}`, "PUT", { ...write, content: "Branch", expectedRevision: 2 })).status).toBe(200);
	expect((await (await call(path)).json()).data.content).toBe("Manual");
	// A max-size revision is exposed intact even though its JSON is over the default 64 KiB exposure bound.
	agent.model.reply(toolCall("artifact", { ...write, content: "x".repeat(ARTIFACT_CONTENT_BYTES) }), "Large saved.");
	await agent.send("large", "make large");
	await agent.settled("large");
	expect(((await agent.document("large", "artifacts"))!.value as Artifacts).artifacts[0]!.content.length).toBe(ARTIFACT_CONTENT_BYTES);
	agent.model.reply(toolCall("artifact", { ...write, content: "x".repeat(ARTIFACT_CONTENT_BYTES + 1) }), "Refused.");
	await agent.send("invalid", "make too large");
	await agent.settled("invalid");
	expect(await agent.document("invalid", "artifacts")).toBeUndefined();
	const restarted = await agent.restart({ graceful: true });
	cleanup.push(() => restarted.close());
	expect(((await restarted.document("t", "artifacts"))!.value as Artifacts).artifacts[0]!.content).toBe("Manual");
	restarted.model.reply(toolCall("artifact", { action: "read", id: a.id }), "Read.");
	await restarted.send("t", "read latest");
	const read = await restarted.settled("t", { messages: 6 });
	expect(read.messages.filter((m) => m.role === "tool").at(-1)?.text).toContain('"content":"Manual"');
}, 30_000);
