import { describe, expect, it } from "vitest";
import { type ApprovalRecord, type ApprovalStatus, Approvals, parseApprovalPolicy } from "../src/lib/approvals.ts";

async function viewOf(statuses: ApprovalStatus[], times?: number[]) {
	const records: ApprovalRecord[] = statuses.map((status, i) => ({
		id: `ap_${i}`, threadId: "t", conversationId: 1, taskId: 20, callId: "same", tool: "bash",
		arguments: { command: `echo hook-${i}` }, status, requestedAt: times?.[i] ?? 100, // tied by default, approved inserted first
	}));
	const approvals = new Approvals(parseApprovalPolicy(undefined));
	await approvals.bind({ snapshot: async () => ({ items: Object.fromEntries(records.map((r) => [r.id, r])) }) } as never, {} as never);
	return { view: approvals.viewOf("t", 1), approvals, records };
}

describe("keyed approval view selection on one durable task", () => {
	for (const status of ["denied", "cancelled", "timed_out"] as const) {
		for (const statuses of [["approved", status], [status, "approved"]] as ApprovalStatus[][]) {
			it(`${statuses.join(" then ")} cannot display Approved when timestamps tie`, async () => {
				const { view, approvals } = await viewOf(statuses);
				expect(view.byTask.get("t20")?.status).toBe(status);
				expect(view.byTask.get("t20")?.id).toBe(approvals.forCall(1, "same", 20)?.id);
			});
		}
	}
	it("mixed blocking terminals never lose to Approved", async () => {
		const { view } = await viewOf(["approved", "denied", "cancelled", "timed_out", "approved"]);
		expect(view.byTask.get("t20")?.status).toBe("denied");
	});
	it("mixed terminal timestamps cannot override the first blocking hook named by the audit", async () => {
		const { view, approvals } = await viewOf(["approved", "denied", "timed_out", "cancelled", "approved"], [1000, 1, 900, 800, 2000]);
		expect(view.byTask.get("t20")).toMatchObject({ id: "ap_1", status: "denied" });
		expect(view.byTask.get("t20")?.id).toBe(approvals.forCall(1, "same", 20)?.id);
	});
	it("pending wins over every terminal and every pending record is retained", async () => {
		const { view } = await viewOf(["approved", "denied", "pending", "cancelled", "pending", "timed_out"]);
		expect(view.byTask.get("t20")).toMatchObject({ id: "ap_2", status: "pending" });
		expect(view.pending).toMatchObject([
			{ id: "ap_2", taskId: "t20", arguments: { command: "echo hook-2" } },
			{ id: "ap_4", taskId: "t20", arguments: { command: "echo hook-4" } },
		]);
	});
});
