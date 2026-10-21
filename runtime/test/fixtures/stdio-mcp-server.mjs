// A minimal MCP server over stdio (newline-delimited JSON-RPC), for tests. Tools: echo (returns its text and the
// server's working directory and FIXTURE_VALUE), app_only (hidden from the model through _meta.ui.visibility), and
// fail (an error result). With FIXTURE_CRASH=1 it writes to stderr and exits before answering. With FIXTURE_ELICIT=1 it
// also has confirm, which asks the person first (MCP elicitation, as m365-mcp does before it sends) when the client
// declared elicitation, and refuses otherwise. With FIXTURE_ACTIONS=1 it also has list_items (annotated read-only),
// delete_item (annotated destructive) and send_note (no annotations), each answering "<name>: <text>".
import { createInterface } from "node:readline";

if (process.env.FIXTURE_CRASH === "1") {
	process.stderr.write("fixture: cannot start, missing configuration\n");
	process.exit(1);
}
process.stderr.write("fixture: started\n");

const tools = [
	{ name: "echo", description: "Echo the text back", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
	{ name: "app_only", description: "For the app's interface only", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } },
	{ name: "fail", description: "Always fails", inputSchema: { type: "object" } },
	...(process.env.FIXTURE_ELICIT === "1"
		? [{ name: "confirm", description: "Asks the person before it 'sends' the text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }]
		: []),
];
if (process.env.FIXTURE_ACTIONS === "1") {
	const schema = { type: "object", properties: { text: { type: "string" } } };
	tools.push(
		{ name: "list_items", description: "List the items", annotations: { readOnlyHint: true }, inputSchema: schema },
		{ name: "delete_item", description: "Delete an item", annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: schema },
		{ name: "send_note", description: "Send a note", inputSchema: schema },
	);
}
// FIXTURE_MANY_TOOLS=n: n more tools with long descriptions (a listing bigger than a pipe's 64 KiB).
for (let i = 0; i < Number(process.env.FIXTURE_MANY_TOOLS ?? 0); i++) {
	tools.push({ name: `bulk_${i}`, description: `Bulk tool ${i}. ${"x".repeat(1000)}`, inputSchema: { type: "object" } });
}
let clientCapabilities = {};
let nextAsk = 1;
const asked = new Map(); // our request id → resolve

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.id === undefined) return; // notifications
	if (msg.method === undefined) {
		// A response to our own request (the elicitation).
		asked.get(msg.id)?.(msg);
		asked.delete(msg.id);
		return;
	}
	const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
	switch (msg.method) {
		case "initialize":
			clientCapabilities = msg.params.capabilities ?? {};
			return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" }, instructions: "Fixture server." });
		case "tools/list":
			return reply({ tools });
		case "tools/call": {
			const { name, arguments: args } = msg.params;
			if (name === "echo") return reply({ content: [{ type: "text", text: `echo: ${args.text} | cwd: ${process.cwd()} | value: ${process.env.FIXTURE_VALUE ?? "-"}` }] });
			if (["list_items", "delete_item", "send_note"].includes(name)) return reply({ content: [{ type: "text", text: `${name}: ${args.text ?? ""}` }] });
			if (name === "fail") return reply({ content: [{ type: "text", text: "it failed" }], isError: true });
			if (name === "confirm") {
				if (!clientCapabilities.elicitation) return reply({ content: [{ type: "text", text: "Nothing was sent: this client can't ask the person." }], isError: true });
				const id = `ask-${nextAsk++}`;
				asked.set(id, (answer) => {
					const r = answer.result ?? {};
					if (answer.error) return reply({ content: [{ type: "text", text: `ask failed: ${answer.error.message}` }], isError: true });
					if (r.action === "accept" && r.content?.send === true) return reply({ content: [{ type: "text", text: `sent: ${args.text}` }] });
					return reply({ content: [{ type: "text", text: `not sent (${r.action})` }], isError: true });
				});
				const wait = Number(process.env.FIXTURE_ELICIT_DELAY_MS ?? 0);
				return void setTimeout(
					() =>
						send({
							jsonrpc: "2.0",
							id,
							method: "elicitation/create",
							params: {
								mode: "form",
								message: `Send this?\n\nText: ${args.text}`,
								requestedSchema: { type: "object", properties: { send: { type: "boolean", title: "Yes, go ahead", default: false } }, required: ["send"] },
							},
						}),
					wait,
				);
			}
			return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
		}
		case "ping":
			return reply({});
		default:
			return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
	}
});
