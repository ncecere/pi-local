// The Pi Local agent runtime, run as a process by the app's supervisor:
//   runtime.mjs             one agent, configured by environment (docs/runtime-contract.md): the library's default
//                           composition (the assistant), or the kind AGENT_KIND names (triage, researcher).
//   runtime.mjs mcp-probe   connect to one MCP server, sign in if asked, list its tools (src/lib/probe.ts).
if (process.argv[2] === "mcp-probe") {
	const { runMcpProbe } = await import("./lib/probe.ts");
	await runMcpProbe();
} else {
	const { runAgentProcess } = await import("@pdp/runtime");
	const { agentFromEnv } = await import("@pdp/runtime/kinds");
	await runAgentProcess(agentFromEnv);
}
