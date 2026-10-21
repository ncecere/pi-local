import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { appleScript, appleTools, callApple, validateAppleArgs } from "../src/lib/apple-mcp.ts";

const range = { start: "2026-10-21T09:00:00Z", end: "2026-10-22T09:00:00Z" };
describe("Apple tools without personal data", () => {
 it("lists only bounded, annotated tools for each app", () => {
  expect(appleTools("calendar").map((t) => t.name)).toEqual(["calendar", "create_event"]);
  expect(appleTools("reminders").map((t) => t.name)).toEqual(["list_reminders", "create_reminder"]);
  expect(appleTools("notes").map((t) => t.name)).toEqual(["search_notes"]);
  for (const service of ["calendar", "reminders", "notes"] as const) for (const t of appleTools(service)) {
   expect(t.annotations.readOnlyHint).toBe(!t.name.startsWith("create_"));
   expect(appleScript(t.name)).toContain("JSON.parse(argv[0])");
  }
 });
 it("bounds ranges, input lengths and limits and refuses cross-app tools", () => {
  expect(validateAppleArgs("calendar", "calendar", range)).toEqual({ ...range, limit: 20 });
  for (const args of [{ ...range, limit: 101 }, { ...range, limit: 0 }, { ...range, limit: 2.5 }, { start: "2026-10-21", end: range.end }, { ...range, end: "2027-10-21T00:00:00Z" }, { ...range, end: range.start }, { ...range, script: "danger" }]) expect(() => validateAppleArgs("calendar", "calendar", args)).toThrow();
  expect(() => validateAppleArgs("notes", "search_notes", { query: "" })).toThrow();
  expect(() => validateAppleArgs("notes", "search_notes", { query: "a".repeat(201) })).toThrow();
  expect(() => validateAppleArgs("notes", "create_event", range)).toThrow();
  expect(() => appleScript("shell")).toThrow();
 });
 it("passes injection-looking text as data, never inserts it in source", async () => {
  const title = `quote\"; Application('System Events'); // \\ <b>title</b>`;
  const execute = vi.fn(async () => "created");
  const confirm = vi.fn(async () => true);
  expect(await callApple("reminders", "create_reminder", { list: "Tasks", title }, execute, confirm)).toBe("created");
  expect(execute).toHaveBeenCalledWith("create_reminder", { list: "Tasks", title });
  expect(confirm.mock.calls[0]).toBeDefined();
  expect(appleScript("create_reminder")).not.toContain(title);
 });
 it("requires explicit confirmation before every mutation, even without client approval support", async () => {
  const execute = vi.fn(async () => "created");
  await expect(callApple("calendar", "create_event", { ...range, title: "Review", calendar: "Work" }, execute, async () => false)).rejects.toThrow("Nothing was created");
  expect(execute).not.toHaveBeenCalled();
  await expect(callApple("reminders", "create_reminder", { list: "Work", title: "Task" }, execute, async () => { throw new Error("confirmation failed"); })).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
 });
 it("read-only calls don't ask for a mutation approval", async () => {
  const confirm = vi.fn(async () => false);
  expect(await callApple("calendar", "calendar", range, async () => '{"events":[]}', confirm)).toBe('{"events":[]}');
  expect(confirm).not.toHaveBeenCalled();
 });
 it("runs calendar script against synthetic objects only, retaining timezone and bounds", () => {
  const events = Array.from({ length: 10 }, (_, i) => ({ summary: () => `event ${i}`, startDate: () => new Date(range.start), endDate: () => new Date(range.end) }));
  const whose = vi.fn(() => () => events);
  const app = { calendars: () => [{ name: () => "Synthetic", events: { whose } }] };
  const ctx = vm.createContext({ Application: () => app, a: { ...range, limit: 2 } });
  vm.runInContext(appleScript("calendar"), ctx);
  const out = JSON.parse(vm.runInContext("run([JSON.stringify(a)])", ctx));
  expect(out.events).toHaveLength(2);
  expect(out.events[0]).toEqual({ title: "event 0", calendar: "Synthetic", start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString() });
  expect(out.recurringInstancesExpanded).toBe(false);
  expect(whose).toHaveBeenCalledOnce();
 });
 it("runs note script against synthetic objects, returning plain text only", () => {
  const app = { notes: { whose: () => () => [{ name: () => "Title", plaintext: () => "x".repeat(4000), body: () => { throw new Error("HTML must not be read"); } }] } };
  const ctx = vm.createContext({ Application: () => app });
  vm.runInContext(appleScript("search_notes"), ctx);
  const out = JSON.parse(vm.runInContext('run([JSON.stringify({query:"Title",limit:1})])', ctx));
  expect(out.notes[0].text).toHaveLength(2000);
 });
 it.skipIf(process.platform !== "darwin")("compiles every static JXA script without running it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-local-apple-compile-"));
  try {
   for (const name of ["calendar", "create_event", "list_reminders", "create_reminder", "search_notes"]) execFileSync("/usr/bin/osacompile", ["-l", "JavaScript", "-e", appleScript(name), "-o", join(dir, `${name}.scpt`)], { stdio: "pipe" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
 });
 it.skipIf(process.env.PI_LOCAL_TEST_APPLE !== "1" || process.platform !== "darwin")("opt-in live Automation smoke (no personal data read or changed)", () => {
  // Only ask whether processes run; never open, enumerate or modify real personal records.
  const value = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", "JSON.stringify(['Calendar','Reminders','Notes'].map(function(name){return {name:name,running:Application(name).running()};}))"], { encoding: "utf8", timeout: 20_000 });
  expect(JSON.parse(value)).toHaveLength(3);
 });
});
