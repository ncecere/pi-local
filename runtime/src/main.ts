// The Pi Local agent runtime, run as a process by the app's supervisor:
//   runtime.mjs             one agent, configured by environment (docs/runtime-contract.md): the library's default
//                           composition (the assistant), or the kind AGENT_KIND names (triage, researcher).
//   runtime.mjs mcp-probe   connect to one MCP server, sign in if asked, list its tools (src/lib/probe.ts).
//   runtime.mjs version     print {contractVersion, piDurableVersion} as JSON: the app checks, before it starts an
//                           agent, that this runtime is not older than the one that last wrote the agent's storage.
if (process.argv[2] === "version") {
	const { CONTRACT_VERSION, PI_DURABLE_VERSION } = await import("./lib/version.ts");
	console.log(JSON.stringify({ contractVersion: CONTRACT_VERSION, piDurableVersion: PI_DURABLE_VERSION }));
} else if (process.argv[2] === "mcp-probe") {
	const { runMcpProbe } = await import("./lib/probe.ts");
	await runMcpProbe();
} else {
	// Logs are cleaned of credentials and of this runtime's own secrets, whatever the agent's switch says (scrub.ts).
	const { installLogScrubbing } = await import("./lib/scrub.ts");
	installLogScrubbing(process.env);
	const { runAgentProcess } = await import("@pdp/runtime");
	const { agentFromEnv } = await import("@pdp/runtime/kinds");
	await runAgentProcess(agentFromEnv);
}
