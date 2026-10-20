// A minimal MCP server over stdio (newline-delimited JSON-RPC), for tests. Tools: echo (returns its text and the
// server's working directory and FIXTURE_VALUE), app_only (hidden from the model through _meta.ui.visibility), and
// fail (an error result). With FIXTURE_CRASH=1 it writes to stderr and exits before answering.
import { createInterface } from "node:readline";

if (process.env.FIXTURE_CRASH === "1") {
	process.stderr.write("fixture: cannot start, missing configuration\n");
	process.exit(1);
}
process.stderr.write("fixture: started\n");

const tools = [
	{ name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
	{ name: "app_only", description: "For the app's interface only", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } },
	{ name: "fail", description: "Always fails", inputSchema: { type: "object" } },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.id === undefined) return; // notifications
	const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
	switch (msg.method) {
		case "initialize":
			return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" }, instructions: "Fixture server." });
		case "tools/list":
			return reply({ tools });
		case "tools/call": {
			const { name, arguments: args } = msg.params;
			if (name === "echo") return reply({ content: [{ type: "text", text: `echo: ${args.text} | cwd: ${process.cwd()} | value: ${process.env.FIXTURE_VALUE ?? "-"}` }] });
			if (name === "fail") return reply({ content: [{ type: "text", text: "it failed" }], isError: true });
			return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
		}
		case "ping":
			return reply({});
		default:
			return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
	}
});
