import { approvalId } from "./approvals.ts";
import { defineExtension, defineTool, Type, type Extension, type HookApi, type ToolHookCall } from "./facade.ts";

import { isBuilderTool } from "./approval-rules.ts";
export const builderEnabled = (env: Record<string, string | undefined>) => env.AGENT_BUILDER === "true" && !!env.PLATFORM_GATEWAY_URL && !!env.PLATFORM_KEY;

export function agentBuilder(options: { gatewayUrl: string; key: string; fetch?: typeof fetch }) {
	const send = async (action: string, body: unknown) => {
		const response = await (options.fetch ?? fetch)(`${options.gatewayUrl.replace(/\/$/, "")}/builder/${action}`, {
			method: "POST",
			headers: { authorization: `Bearer ${options.key}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(60_000),
		});
		const json = (await response.json()) as { data?: unknown; error?: { message?: string } };
		if (!response.ok) throw new Error(json.error?.message ?? "The builder request failed.");
		return json.data;
	};
	const fields = {
		templateId: Type.Optional(Type.String({ description: "Existing template ID, e.g. assistant, researcher, coding, planner or concierge" })),
		name: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
		instructions: Type.Optional(Type.String()),
		modelId: Type.Optional(Type.String({ description: "An existing provider/model ID; omitted on creation uses the app default" })),
		workspace: Type.Optional(
			Type.Object(
				{
					tools: Type.Array(Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("edit"), Type.Literal("bash")])),
					folder: Type.Optional(Type.String()),
					sandbox: Type.Optional(Type.Boolean()),
					network: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
		),
		schedule: Type.Optional(
			Type.Object(
				{
					name: Type.Optional(Type.String()),
					message: Type.String(),
					at: Type.Optional(Type.String()),
					cron: Type.Optional(Type.String()),
					timezone: Type.Optional(Type.String()),
					threadMode: Type.Optional(Type.Union([Type.Literal("new"), Type.Literal("this")])),
					missedPolicy: Type.Optional(Type.Union([Type.Literal("skip"), Type.Literal("run_once")])),
					paused: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
		),
	};
	const tool = (name: "create_agent" | "update_agent") =>
		defineTool({
			name,
			description:
				name === "create_agent"
					? "Propose a new agent with the person. Always waits for approval of the complete configuration, including defaults and first schedule. No credentials, skills, knowledge or setup commands are accepted."
					: "Propose changes to an agent you created (never yourself or unrelated agents). Always asks human approval. Omitted fields stay unchanged; schedule adds a first schedule, not shell automation.",
			parameters: Type.Object(
				{
					...fields,
					...(name === "update_agent" ? { agent: Type.String({ description: "ID returned when you created the agent" }) } : { name: Type.String() }),
				},
				{ additionalProperties: false },
			),
			replay: "safe",
			execute: async (_args, api) => {
				try {
					const result = await send("apply", { key: `${api.conversationId}:${api.taskId}` });
					return { output: [{ type: "text", text: JSON.stringify(result) }] };
				} catch (error) {
					return { output: [{ type: "text", text: (error as Error).message }], isError: true };
				}
			},
		});
	const extension: Extension = defineExtension({ name: "agent-builder", tools: [tool("create_agent"), tool("update_agent")] });
	return {
		extension,
		// The approval hook asks about this immutable, fully defaulted snapshot, not only the model's input.
		prepare: async (call: ToolHookCall, api: HookApi): Promise<ToolHookCall> => {
			if (!isBuilderTool(call.name)) return call;
			const proposal = await send("prepare", {
				key: `${api.conversationId}:${api.taskId}`,
				approvalId: approvalId(api.taskId as unknown as number),
				tool: call.name,
				configuration: call.arguments,
			});
			return { ...call, arguments: proposal as ToolHookCall["arguments"] };
		},
	};
}
