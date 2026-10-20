import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Extension, Type } from "./facade.ts";

/** The extension's name (selected like the agent's own extensions). */
export const AGENT_CALLS_EXTENSION = "agent-calls";

export type AgentCallsOptions = {
	/** The app's gateway (PLATFORM_GATEWAY_URL) and this runtime's key (PLATFORM_KEY). */
	gatewayUrl: string;
	key: string;
	/** The thread a conversation belongs to (a subagent's or task's conversation has none). */
	threadOf: (conversationId: number) => Promise<string | undefined>;
	fetch?: typeof fetch;
	/**
	 * Whether the runtime is shutting down (hibernation, the app quitting). Its running tools are aborted then, but
	 * that is no reason to stop the ask: the call resumes at the next start and goes on waiting for the same reply.
	 */
	stopping?: () => boolean;
	/** How long one wait for an answer lasts before asking again (the app answers sooner when the reply ends). */
	pollTimeoutMs?: number;
};

type Peer = { id: string; name: string; description?: string; kind?: string; via?: string };
type AskStarted = { askId: string; agentId: string; agentName: string; threadId: string };
type AskState = { status: "pending" | "done" | "failed"; text?: string; error?: string };

class GatewayError extends Error {}

/**
 * Asking other agents (docs/api.md, "Teams and agents asking agents"): `list_agents` says who this agent may ask, and
 * `ask_agent` sends one of them a message and waits for its reply. The app decides who may ask whom, sends the
 * message (as this agent, in a conversation of the asked agent's own) and follows the reply; the asked agent wakes,
 * answers, and goes back to sleep like for anyone else.
 *
 * `ask_agent` is replay-safe: the ask is keyed by this conversation and the tool call, so a runtime that restarts in
 * the middle of a call asks again with the same key, finds the same ask and goes on waiting for the same reply.
 */
export function agentCallsExtension(options: AgentCallsOptions): Extension {
	const doFetch = options.fetch ?? fetch;
	const base = options.gatewayUrl.replace(/\/$/, "");
	const headers = { authorization: `Bearer ${options.key}`, "content-type": "application/json" };
	const call = async <T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
		const res = await doFetch(`${base}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
		});
		const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { message?: string } };
		if (!res.ok) throw new GatewayError(json.error?.message ?? `The app answered status ${res.status}.`);
		return json.data as T;
	};

	const listAgents = defineTool({
		name: "list_agents",
		description: "List the other agents you may ask for help with ask_agent: their IDs, names and what they do.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async () => {
			const peers = await call<Peer[]>("GET", "/a2a/agents");
			if (peers.length === 0) return { output: [{ type: "text", text: "You may not ask any other agents." }] };
			const lines = peers.map((p) => `- ${p.name} (id: ${p.id}${p.kind ? `, ${p.kind}` : ""})${p.description ? `: ${p.description}` : ""}`);
			return { output: [{ type: "text", text: `Agents you may ask:\n${lines.join("\n")}` }], details: { agents: peers } };
		},
	});

	const askAgent = defineTool({
		name: "ask_agent",
		description:
			"Ask another agent (see list_agents) and wait for its reply. Give it everything it needs in the message: it " +
			"sees only what you send. With conversation \"continue\" (the default) it remembers your earlier asks in this " +
			"conversation; \"new\" starts it fresh.",
		parameters: Type.Object({
			agent: Type.String({ description: "The agent's ID or exact name, from list_agents" }),
			message: Type.String({ description: "What to ask or tell it" }),
			conversation: Type.Optional(Type.Union([Type.Literal("continue"), Type.Literal("new")])),
		}),
		replay: "safe",
		execute: async (args, api, context: Context) => {
			const signal = context.abortSignal;
			const callerThread = await options.threadOf(api.conversationId as unknown as number);
			let started: AskStarted;
			try {
				started = await call<AskStarted>(
					"POST",
					"/a2a/asks",
					{
						agent: args.agent,
						message: args.message,
						conversation: args.conversation ?? "continue",
						threadId: callerThread,
						key: `${api.conversationId}:${api.callId}`,
					},
					signal,
				);
			} catch (error) {
				if (error instanceof GatewayError) return { output: [{ type: "text", text: error.message }], isError: true };
				throw error;
			}
			const details = { agentId: started.agentId, agentName: started.agentName, threadId: started.threadId };
			// Stopped by a person (the thread's Stop): the asked agent stops too. Not when the runtime is going to sleep.
			const onAbort = () => {
				if (options.stopping?.()) return;
				void call("POST", `/a2a/asks/${started.askId}/stop`).catch(() => {});
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				for (;;) {
					if (signal?.aborted) throw signal.reason ?? new Error("aborted");
					const state = await call<AskState>("GET", `/a2a/asks/${started.askId}?waitMs=${options.pollTimeoutMs ?? 25_000}`, undefined, signal);
					if (state.status === "done") return { output: [{ type: "text", text: state.text || "(no reply)" }], details };
					if (state.status === "failed") {
						return { output: [{ type: "text", text: `${started.agentName} could not answer: ${state.error ?? "unknown error"}` }], isError: true, details };
					}
				}
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},
	});

	return defineExtension({ name: AGENT_CALLS_EXTENSION, tools: [listAgents, askAgent] });
}
