import { execFile } from "node:child_process";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { appleScript, appleTools, callApple, executeApple, validateAppleArgs } from "../src/lib/apple-mcp.ts";

// No Apple subprocess may run in this suite, even on a developer's Mac.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const range = { start: "2026-10-21T09:00:00Z", end: "2026-10-22T09:00:00Z" };
describe("Apple tools without personal data", () => {
 it("lists only bounded, annotated tools for each app", () => {
  expect(appleTools("calendar", true).map((t) => t.name)).toEqual(["calendar", "create_event"]);
  expect(appleTools("reminders", true).map((t) => t.name)).toEqual(["list_reminders", "create_reminder"]);
  expect(appleTools("notes").map((t) => t.name)).toEqual(["search_notes"]);
  for (const service of ["calendar", "reminders", "notes"] as const) for (const t of appleTools(service, true)) {
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
 it.each(["calendar", "create_event"])("validates Gregorian dates and timezones for %s", (name) => {
  const args = name === "create_event" ? { calendar: "Synthetic", title: "Review" } : { calendar: "Synthetic" };
  for (const value of ["2026-02-30T09:00Z", "2026-02-29T09:00Z", "1900-02-29T09:00Z", "2028-04-31T09:00Z", "2028-00-01T09:00Z", "2028-13-01T09:00Z", "2028-02-00T09:00Z", "2028-02-29T24:00Z", "2028-02-29T09:60Z", "2028-02-29T09:00:60Z", "2028-02-29T09:00+24:00", "2028-02-29T09:00+05:60"]) {
   expect(() => validateAppleArgs("calendar", name, { ...args, start: value, end: "2028-03-01T10:00Z" })).toThrow("valid Gregorian");
   expect(() => validateAppleArgs("calendar", name, { ...args, start: "2026-02-28T09:00Z", end: value })).toThrow("valid Gregorian");
  }
  for (const year of [2000, 2028]) for (const offset of ["Z", "+05:30", "-07:00"]) {
   const valid = { ...args, start: `${year}-02-29T09:00:00.123${offset}`, end: `${year}-03-01T09:00:00.123${offset}` };
   expect(validateAppleArgs("calendar", name, valid)).toMatchObject(valid);
  }
 });
 it("uses the exact validated timezone representation in confirmation and execution", async () => {
  const args = { calendar: "Synthetic", title: "Leap day", start: "2028-02-29T09:00+05:30", end: "2028-02-29T11:00+05:30" };
  const execute = vi.fn(async () => "created"), confirm = vi.fn(async (_message: string) => true);
  await callApple("calendar", "create_event", args, execute, confirm, true);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(args, null, 2)));
  expect(execute).toHaveBeenCalledWith("create_event", args);
  await expect(callApple("calendar", "create_event", { ...args, start: "2028-02-30T09:00+05:30" }, execute, confirm, true)).rejects.toThrow();
  expect(execute).toHaveBeenCalledOnce();
  expect(confirm).toHaveBeenCalledOnce();
 });
 it("defaults to read-only and cannot take trust or approval from fabricated tool arguments", async () => {
  expect(appleTools("calendar").map((t) => t.name)).toEqual(["calendar"]);
  expect(appleTools("reminders").map((t) => t.name)).toEqual(["list_reminders"]);
  const execute = vi.fn(async () => "created"), confirm = vi.fn(async () => true);
  for (const [service, name, args] of [
   ["reminders", "create_reminder", { list: "Synthetic", title: "Task" }],
   ["calendar", "create_event", { ...range, calendar: "Synthetic", title: "Review" }],
  ] as const) {
   await expect(callApple(service, name, args, execute, confirm)).rejects.toThrow("unavailable");
   await expect(callApple(service, name, args, execute, confirm, false)).rejects.toThrow("unavailable");
   for (const field of ["approve", "confirmed", "trustedHumanConfirmations"]) {
    await expect(callApple(service, name, { ...args, [field]: true }, execute, confirm, true)).rejects.toThrow("Unknown argument");
   }
  }
  expect(execute).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
 });
 it("passes injection-looking text as data, never inserts it in source", async () => {
  const title = `quote\"; Application('System Events'); // \\ <b>title</b>`;
  const execute = vi.fn(async () => "created");
  const confirm = vi.fn(async () => true);
  expect(await callApple("reminders", "create_reminder", { list: "Tasks", title }, execute, confirm, true)).toBe("created");
  expect(execute).toHaveBeenCalledWith("create_reminder", { list: "Tasks", title });
  expect(confirm.mock.calls[0]).toBeDefined();
  expect(appleScript("create_reminder")).not.toContain(title);
 });
 it("requires explicit confirmation before every mutation, even without client approval support", async () => {
  const execute = vi.fn(async () => "created");
  await expect(callApple("calendar", "create_event", { ...range, title: "Review", calendar: "Work" }, execute, async () => false, true)).rejects.toThrow("Nothing was created");
  expect(execute).not.toHaveBeenCalled();
  await expect(callApple("reminders", "create_reminder", { list: "Work", title: "Task" }, execute, async () => { throw new Error("confirmation failed"); }, true)).rejects.toThrow();
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
 it.skipIf(process.platform !== "darwin")("executes only after confirmation, with a mocked JXA subprocess", async () => {
  vi.mocked(execFile).mockImplementation(((_file: unknown, _args: unknown, _options: unknown, callback: (error: null, stdout: string) => void) => {
   callback(null, '{"created":true}');
  }) as typeof execFile);
  const args = { ...range, title: "Review", calendar: "Synthetic" };
  expect(await callApple("calendar", "create_event", args, executeApple, async () => true, true)).toBe('{"created":true}');
  expect(execFile).toHaveBeenCalledWith("/usr/bin/osascript", ["-l", "JavaScript", "-e", appleScript("create_event"), JSON.stringify(args)], expect.any(Object), expect.any(Function));
 });
});
