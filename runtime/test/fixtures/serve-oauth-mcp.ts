// Runs the OAuth MCP fixture server for other test suites (the Go app's): prints its URL, serves until stdin closes.
import { startOAuthMcpServer } from "./oauth-mcp-server.ts";

const server = await startOAuthMcpServer();
console.log(JSON.stringify({ url: server.url }));
process.stdin.on("end", () => void server.close().then(() => process.exit(0)));
process.stdin.resume();
