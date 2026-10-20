import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type AgentConfig, AgentOwnedElsewhereError, type AgentProcess, startAgent } from "./agent.ts";
import { assistantAgent, DEFAULT_INSTRUCTIONS } from "./assistant.ts";
import { AgentDefinitionError, type AgentDefinition } from "./define.ts";

/**
 * What a process runs: one definition, or a function that picks one from the agent's variables (the runtime picks by
 * AGENT_KIND, docs/first-party-agents.md). Throwing an AgentDefinitionError there is a misconfiguration.
 */
export type AgentChoice = AgentDefinition | ((env: Readonly<Record<string, string | undefined>>) => AgentDefinition);

/** The line the app waits for on stdout, with the port the runtime listens on (PORT=0 picks a free one). */
export const READY_PREFIX = "PI_RUNTIME_READY ";

/**
 * Runs one agent process, configured by environment variables (docs/runtime-contract.md lists every one):
 *
 *   AGENT_ID, AGENT_NAME, AGENT_INSTRUCTIONS   identity and prompt
 *   AGENT_STORAGE                              the agent's storage file, `<agent dir>/state.sqlite`
 *   RUNTIME_TOKEN                              bearer token the app presents
 *   MODEL_PROVIDER, MODEL_*                    see models.ts
 *   RUNTIME_WATCH_STDIN=true                   stop when stdin closes: the app holds the other end, so a crashed app
 *                                              never leaves a runtime writing the agent's storage
 *
 * PORT and HOST say where to listen (HOST is loopback; PORT=0, the default, picks a free port). Once listening it
 * prints `PI_RUNTIME_READY {"port":N}` on stdout. The process exits 1 when storage fails, so its supervisor starts a
 * fresh one that resumes from storage; 2 when it is misconfigured; 3 when another process owns the agent. SIGINT,
 * SIGTERM and (with RUNTIME_WATCH_STDIN) the end of stdin stop it gracefully: work in flight stays pending and resumes
 * on the next start.
 */
export async function runAgentProcess(choose: AgentChoice = assistantAgent, env: NodeJS.ProcessEnv = process.env): Promise<Server> {
	const get = (name: string, fallback?: string): string => {
		const value = env[name] || fallback;
		if (value === undefined || value === "") {
			console.error(`[runtime] ${name} is required`);
			process.exit(2);
		}
		return value;
	};

	const port = Number(get("PORT", "0"));
	const host = get("HOST", "127.0.0.1");
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		console.error("[runtime] PORT must be a port number");
		process.exit(2);
	}
	const config: AgentConfig = {
		agentId: get("AGENT_ID"),
		name: get("AGENT_NAME", "Assistant"),
		instructions: get("AGENT_INSTRUCTIONS", DEFAULT_INSTRUCTIONS),
		storagePath: get("AGENT_STORAGE"),
		token: get("RUNTIME_TOKEN"),
		modelEnv: env,
	};

	let agent: AgentProcess;
	try {
		const definition = typeof choose === "function" ? choose(config.modelEnv) : choose;
		agent = await startAgent(config, definition);
	} catch (error) {
		if (error instanceof AgentDefinitionError) {
			// A definition the agent's variables can't make (an unknown AGENT_KIND, bad AGENT_KIND_SETTINGS): misconfigured.
			console.error(`[agent ${config.agentId}] ${error.message}`);
			process.exit(2);
		}
		if (error instanceof AgentOwnedElsewhereError) {
			// The supervisor sees exit code 3 and retries later.
			console.error(`[agent ${config.agentId}] another process owns this agent; exiting`);
			process.exit(3);
		}
		throw error;
	}

	const server = createServer(agent.handler);
	server.listen(port, host, () => {
		const actual = (server.address() as AddressInfo).port;
		console.log(`[runtime] listening on http://${host}:${actual}`);
		console.log(`${READY_PREFIX}${JSON.stringify({ port: actual })}`);
	});

	let closing = false;
	const close = async (code: number) => {
		if (closing) return;
		closing = true;
		server.close();
		server.closeAllConnections();
		await agent.close();
		process.exit(code);
	};
	// Graceful hibernation: work in flight stays pending in storage and resumes on the next start.
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void close(0));
	if (env.RUNTIME_WATCH_STDIN === "true") {
		process.stdin.on("end", () => void close(0));
		process.stdin.on("error", () => void close(0));
		process.stdin.resume();
	}
	return server;
}
