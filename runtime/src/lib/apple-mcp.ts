// Pi Local's bundled Apple MCP server. No third-party install, shell, eval of user text, or data access at startup.
// JXA receives validated data as a separate argv JSON value; all source below is static.
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";

export type AppleService = "calendar" | "reminders" | "notes";
type Args = Record<string, unknown>;
type Tool = { name: string; description: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean }; inputSchema: unknown };
const fields = { limit: { type: "integer", minimum: 1, maximum: 100 } };
const text = { type: "string", minLength: 1, maxLength: 200 };
function tool(name: string, description: string, properties: Args, required: string[], write = false): Tool {
 return { name, description, annotations: { readOnlyHint: !write, destructiveHint: write }, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
export function appleTools(service: AppleService): Tool[] {
 switch (service) {
  case "calendar": return [
   tool("calendar", "Read events starting in an explicit ISO date range (at most 31 days and 100 results). Does not expand recurring instances. macOS may ask for Automation access.", { start: text, end: text, calendar: text, ...fields }, ["start", "end"]),
   tool("create_event", "Create one event in a named calendar. Always asks the person to confirm; never sends invitations.", { calendar: text, title: text, start: text, end: text }, ["calendar", "title", "start", "end"], true),
  ];
  case "reminders": return [
   tool("list_reminders", "Read up to 100 incomplete reminders, optionally in a named list.", { list: text, ...fields }, []),
   tool("create_reminder", "Create one reminder in a named list, after the person confirms.", { list: text, title: text }, ["list", "title"], true),
  ];
  case "notes": return [tool("search_notes", "Search note titles and return short plain-text excerpts (not HTML), at most 100 notes.", { query: text, ...fields }, ["query"])];
 }
}
function stringArg(a: Args, key: string): string {
 const v = a[key];
 if (typeof v !== "string" || !v.trim() || v.length > 200 || /[\u0000-\u001f]/.test(v)) throw new Error(`${key} must be 1–200 characters on one line.`);
 return v;
}
export function validateAppleArgs(service: AppleService, name: string, value: unknown): Args {
 const t = appleTools(service).find((t) => t.name === name);
 if (!t || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unknown tool or invalid arguments.");
 const schema = t.inputSchema as { properties: Args; required: string[] };
 const a = value as Args;
 for (const key of Object.keys(a)) if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unknown argument: ${key}`);
 for (const key of schema.required) stringArg(a, key);
 for (const key of Object.keys(schema.properties)) if (key !== "limit" && a[key] !== undefined) stringArg(a, key);
 if (a.limit !== undefined && (!Number.isInteger(a.limit) || Number(a.limit) < 1 || Number(a.limit) > 100)) throw new Error("limit must be 1–100.");
 if (a.start !== undefined) {
  for (const key of ["start", "end"]) if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(String(a[key])) || !Number.isFinite(Date.parse(String(a[key])))) throw new Error(`${key} needs an ISO date and explicit timezone.`);
  const span = Date.parse(String(a.end)) - Date.parse(String(a.start));
  if (span <= 0 || span > 31 * 86_400_000) throw new Error("Use a positive date range of at most 31 days.");
 }
 return { ...a, ...(schema.properties.limit ? { limit: a.limit ?? 20 } : {}) };
}

const scripts: Record<string, string> = {
 calendar: `var app = Application('Calendar');
 var from = new Date(a.start), to = new Date(a.end);
 var calendars = a.calendar ? app.calendars.whose({name:a.calendar})() : app.calendars();
 var out = [];
 for (var c of calendars.slice(0,20)) {
  var events = c.events.whose({_and:[{startDate:{_greaterThanEquals:from}},{startDate:{_lessThan:to}}]})();
  for (var e of events.slice(0,a.limit-out.length)) out.push({calendar:c.name(),title:e.summary(),start:e.startDate().toISOString(),end:e.endDate().toISOString()});
  if(out.length >= a.limit) break;
 }
 return JSON.stringify({events:out,limit:a.limit,recurringInstancesExpanded:false,notice:'Bounded results; not an exhaustive availability check.'});`,
 create_event: `var app = Application('Calendar');
 var targets = app.calendars.whose({name:a.calendar})();
 if(targets.length !== 1) throw new Error('Choose one uniquely named calendar.');
 var event = app.Event({summary:a.title,startDate:new Date(a.start),endDate:new Date(a.end)});
 targets[0].events.push(event);
 return JSON.stringify({created:true,title:a.title});`,
 list_reminders: `var app = Application('Reminders');
 var lists = a.list ? app.lists.whose({name:a.list})() : app.lists();
 var out = [];
 for(var l of lists.slice(0,20)) {
  for(var r of l.reminders.whose({completed:false})().slice(0,a.limit-out.length)) out.push({list:l.name(),title:r.name()});
  if(out.length >= a.limit) break;
 }
 return JSON.stringify({reminders:out,limit:a.limit});`,
 create_reminder: `var app = Application('Reminders');
 var targets = app.lists.whose({name:a.list})();
 if(targets.length !== 1) throw new Error('Choose one uniquely named reminder list.');
 targets[0].reminders.push(app.Reminder({name:a.title}));
 return JSON.stringify({created:true,title:a.title});`,
 search_notes: `var app = Application('Notes');
 var notes = app.notes.whose({name:{_contains:a.query}})().slice(0,a.limit);
 return JSON.stringify({notes:notes.map(function(n){return {title:n.name(),text:n.plaintext().slice(0,2000)};}),limit:a.limit});`,
};
export function appleScript(name: string): string {
 const body = scripts[name];
 if (!body) throw new Error("Unknown Apple tool.");
 return `function run(argv) { var a = JSON.parse(argv[0]);\n${body}\n}`;
}
export async function executeApple(name: string, args: Args): Promise<string> {
 if (process.platform !== "darwin") throw new Error("Apple connections need macOS.");
 return new Promise((resolve, reject) => {
  execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", appleScript(name), JSON.stringify(args)], { timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
   if (error) reject(new Error("The Apple app did not finish. Check Automation permissions in System Settings → Privacy & Security, and the calendar or list name. Do not retry a creation until you check whether it was saved."));
   else resolve(stdout.trim());
  });
 });
}
export async function callApple(
 service: AppleService, name: string, value: unknown,
 execute: (name: string, args: Args) => Promise<string>,
 confirm: (message: string) => Promise<boolean>,
): Promise<string> {
 const args = validateAppleArgs(service, name, value);
 if (name.startsWith("create_")) {
  const approved = await confirm(`Create this in ${service === "calendar" ? "Apple Calendar" : "Apple Reminders"}?\n${JSON.stringify(args, null, 2)}`);
  if (!approved) throw new Error("Nothing was created: confirmation was not given.");
 }
 return execute(name, args);
}

// Minimal newline JSON-RPC stdio server. Tool listing never starts an Apple application.
export async function runAppleMcp(service: string | undefined): Promise<void> {
 if (service !== "calendar" && service !== "reminders" && service !== "notes") throw new Error("Choose calendar, reminders or notes.");
 if (process.platform !== "darwin") throw new Error("Apple connections need macOS.");
 const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
 let elicitation = false, next = 0, active = 0;
 const waiting = new Map<string, (answer: Record<string, unknown>) => void>();
 const confirm = async (message: string): Promise<boolean> => {
  if (!elicitation) return false; // Fail closed even under a trusting approval profile.
  const id = `apple-confirm-${++next}`;
  return new Promise((resolve) => {
   const timer = setTimeout(() => { waiting.delete(id); resolve(false); }, 15 * 60_000);
   waiting.set(id, (answer) => {
    clearTimeout(timer); waiting.delete(id);
    const r = answer.result as { action?: string; content?: { approve?: boolean } } | undefined;
    resolve(r?.action === "accept" && r.content?.approve === true);
   });
   send({ jsonrpc: "2.0", id, method: "elicitation/create", params: { mode: "form", message, requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Create it", default: false } }, required: ["approve"] } } });
  });
 };
 const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
 lines.on("close", () => { for (const reply of waiting.values()) reply({}); });
 lines.on("line", (line) => {
  if (Buffer.byteLength(line) > 256 * 1024) return;
  let msg: { id?: string | number; method?: string; params?: Record<string, unknown> };
  try { msg = JSON.parse(line); } catch { send({jsonrpc:"2.0",id:null,error:{code:-32700,message:"Invalid JSON"}}); return; }
  if (!msg || typeof msg !== "object" || msg.id === undefined) return;
  if (!msg.method) { waiting.get(String(msg.id))?.(msg as Record<string, unknown>); return; }
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
   case "initialize": {
    const caps = msg.params?.capabilities as { elicitation?: unknown } | undefined;
    elicitation = !!caps?.elicitation;
    reply({ protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: `pi-local-apple-${service}`, version: "1" } }); break;
   }
   case "ping": reply({}); break;
   case "tools/list": reply({ tools: appleTools(service) }); break;
   case "tools/call": {
    if (active >= 8) { reply({isError:true,content:[{type:"text",text:"Too many Apple calls; wait for the current calls."}]}); break; }
    active++;
    void callApple(service, String(msg.params?.name), msg.params?.arguments ?? {}, executeApple, confirm)
     .then((text) => reply({ content: [{ type: "text", text }] }))
     .catch((error: Error) => reply({ isError: true, content: [{ type: "text", text: error.message }] }))
     .finally(() => { active--; });
    break;
   }
   default: send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Unknown method" } });
  }
 });
}
