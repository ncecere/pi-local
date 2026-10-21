import { execFile } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAppleMcp } from "../src/lib/apple-mcp.ts";

// Tripwire as well as dependency injection: a regression must never launch a real Apple subprocess.
vi.mock("node:child_process", () => ({ execFile: vi.fn(() => { throw new Error("Unexpected Apple subprocess"); }) }));

// In-memory MCP wire, synthetic execution only; never starts osascript or an Apple app.
async function host(trustedHumanConfirmations?: boolean) {
 const input = new PassThrough();
 const execute = vi.fn(async () => '{"created":true}');
 const pending = new Map<number, (result: Record<string, unknown>) => void>();
 const questions: Record<string, unknown>[] = [];
 let onQuestion: ((question: Record<string, unknown>) => void) | undefined;
 const output = new Writable({ write(chunk, _encoding, done) {
  const msg = JSON.parse(String(chunk));
  if (msg.method === "elicitation/create") {
   if (onQuestion) { const reply = onQuestion; onQuestion = undefined; reply(msg); }
   else questions.push(msg);
  } else { pending.get(msg.id)?.(msg.result); pending.delete(msg.id); }
  done();
 } });
 await runAppleMcp("reminders", { input, output, execute, trustedHumanConfirmations });
 let id = 0;
 const send = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
 const call = (method: string, params: unknown = {}) => new Promise<Record<string, unknown>>((resolve) => {
  const next = ++id; pending.set(next, resolve);
  send({ jsonrpc: "2.0", id: next, method, params });
 });
 const question = () => new Promise<Record<string, unknown>>((resolve) => {
  const next = questions.shift(); if (next) resolve(next); else onQuestion = resolve;
 });
 await call("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: { form: {} } } });
 return { call, send, question, execute, close: () => input.end(), questions };
}

afterEach(() => vi.unstubAllEnvs());
describe.skipIf(process.platform !== "darwin")("Apple MCP host confirmation boundary", () => {
 it.each([undefined, false])("headless/default %s refuses creation even with elicitation support", async (trusted) => {
  const h = await host(trusted);
  try {
   expect(await h.call("tools/list")).toMatchObject({ tools: [{ name: "list_reminders" }] });
   const result = await h.call("tools/call", { name: "create_reminder", arguments: { list: "Synthetic", title: "Task" } });
   expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("unavailable") }] });
   expect(h.questions).toHaveLength(0);
   expect(h.execute).not.toHaveBeenCalled();
   expect(execFile).not.toHaveBeenCalled();
  } finally { h.close(); }
 });
 it.each(["careful", "balanced", "trusting", "custom"])("desktop still waits for an actual elicitation response under %s", async (profile) => {
  vi.stubEnv("TOOL_APPROVALS", JSON.stringify({ profile, rules: [{ tool: "*", action: "allow" }] }));
  const h = await host(true);
  const args = { list: "Synthetic", title: "Task" };
  try {
   expect(await h.call("tools/list")).toMatchObject({ tools: [{ name: "list_reminders" }, { name: "create_reminder" }] });
   const fabricated = await h.call("tools/call", { name: "create_reminder", arguments: { ...args, approve: true, trustedHumanConfirmations: true } });
   expect(fabricated.isError).toBe(true);
   expect(h.execute).not.toHaveBeenCalled();
   const result = h.call("tools/call", { name: "create_reminder", arguments: args });
   const question = await h.question();
   expect(question.params).toMatchObject({ message: expect.stringContaining(JSON.stringify(args, null, 2)) });
   // Wrong response ID and accepting without the explicit checkbox cannot approve.
   h.send({ jsonrpc: "2.0", id: "fabricated", result: { action: "accept", content: { approve: true } } });
   expect(h.execute).not.toHaveBeenCalled();
   h.send({ jsonrpc: "2.0", id: question.id, result: { action: "accept", content: {} } });
   expect((await result).isError).toBe(true);
   expect(h.execute).not.toHaveBeenCalled();
   const approved = h.call("tools/call", { name: "create_reminder", arguments: args });
   const next = await h.question();
   expect(h.execute).not.toHaveBeenCalled();
   h.send({ jsonrpc: "2.0", id: next.id, result: { action: "accept", content: { approve: true } } });
   expect(await approved).toMatchObject({ content: [{ text: '{"created":true}' }] });
   expect(h.execute).toHaveBeenCalledExactlyOnceWith("create_reminder", args);
  } finally { h.close(); }
 });
 it("desktop without client elicitation support refuses instead of fabricating success", async () => {
  const h = await host(true);
  try {
   await h.call("initialize", { capabilities: {} });
   expect((await h.call("tools/call", { name: "create_reminder", arguments: { list: "Synthetic", title: "Task" } })).isError).toBe(true);
   expect(h.execute).not.toHaveBeenCalled();
  } finally { h.close(); }
 });
});
