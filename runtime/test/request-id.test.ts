import { startTestAgent } from "@pdp/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

describe("user messages carry their request ID", () => {
	it("so a client matches what it sent to the transcript by ID, not by its text", async () => {
		const agent = await startTestAgent();
		cleanup.push(() => agent.close());
		await agent.send("t1", "same words", { requestId: "first-1" });
		await agent.settled("t1");
		await agent.send("t1", "same words", { requestId: "second-2" });
		const view = await agent.settled("t1", { messages: 4 });
		const users = view.messages.filter((m) => m.role === "user") as { requestId?: string; text: string }[];
		expect(users.map((m) => [m.text, m.requestId])).toEqual([
			["same words", "first-1"],
			["same words", "second-2"],
		]);
		// Without one, none is made up.
		await agent.send("t2", "no id");
		const other = await agent.settled("t2");
		expect((other.messages[0] as { requestId?: string }).requestId).toBeUndefined();
	});
});
