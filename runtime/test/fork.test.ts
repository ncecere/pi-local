import { startTestAgent } from "@pdp/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

describe("forking a thread", () => {
	it("edits a message (fork before it) and branches after a reply, leaving the source alone", async () => {
		const agent = await startTestAgent();
		cleanup.push(() => agent.close());
		const post = (path: string, body: unknown) =>
			fetch(`${agent.baseUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
		agent.model.reply("first answer", "second answer", "edited answer", "branch answer", "fork of fork answer");
		await agent.send("t1", "first question");
		await agent.settled("t1");
		await agent.send("t1", "second question");
		const source = await agent.settled("t1", { messages: 4 });
		const [q1, a1, q2] = source.messages;

		// Edit the second question: the new thread keeps the first exchange only.
		const edit = await post("/threads/t1/fork", { threadId: "t1-edit", beforeMessageId: q2!.id });
		expect(edit.status).toBe(201);
		expect((await agent.view("t1-edit"))!.messages.map((m) => m.text)).toEqual(["first question", "first answer"]);
		await agent.send("t1-edit", "edited second question");
		const edited = await agent.settled("t1-edit", { messages: 4 });
		expect(edited.messages.map((m) => m.text)).toEqual(["first question", "first answer", "edited second question", "edited answer"]);

		// Branch after the first answer.
		expect((await post("/threads/t1/fork", { threadId: "t1-branch", afterMessageId: a1!.id })).status).toBe(201);
		await agent.send("t1-branch", "another way");
		const branch = await agent.settled("t1-branch", { messages: 4 });
		expect(branch.messages.map((m) => m.text)).toEqual(["first question", "first answer", "another way", "branch answer"]);

		// A fork of a fork, before a message the fork inherited from its parent.
		expect((await post("/threads/t1-edit/fork", { threadId: "t1-edit-2", afterMessageId: edited.messages[1]!.id })).status).toBe(201);
		expect((await agent.view("t1-edit-2"))!.messages.map((m) => m.text)).toEqual(["first question", "first answer"]);

		// Editing the first message starts empty; the source is untouched throughout.
		expect((await post("/threads/t1/fork", { threadId: "t1-fresh", beforeMessageId: q1!.id })).status).toBe(201);
		expect((await agent.view("t1-fresh"))!.messages).toEqual([]);
		expect((await agent.view("t1"))!.messages.map((m) => m.text)).toEqual(source.messages.map((m) => m.text));

		// Refusals.
		expect((await post("/threads/t1/fork", { threadId: "t1-edit", beforeMessageId: q2!.id })).status).toBe(409);
		expect((await post("/threads/t1/fork", { threadId: "x", beforeMessageId: "e99999" })).status).toBe(400);
		expect((await post("/threads/nope/fork", { threadId: "y", afterMessageId: q1!.id })).status).toBe(404);
		expect((await post("/threads/t1/fork", { threadId: "z" })).status).toBe(400);
	}, 20_000);
});
