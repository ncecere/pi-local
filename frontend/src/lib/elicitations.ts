import type {
  ElicitationContent,
  ElicitationField,
  ElicitationSchema,
  McpElicitation,
} from '~/api/types';

/**
 * MCP elicitations (docs/api.md, "MCP elicitation"): an MCP server asking the
 * person something during a tool call, with a small form. Pure, so the rules
 * can be tested: the pending list, the form's values and what Accept sends.
 */

// ── The pending list (`['elicitations']`) ───────────────────────────────────────────────────

/** The pending list with one change applied: a pending one added or updated, any other removed. */
export function applyElicitationEvent(
  list: McpElicitation[] | undefined,
  elicitation: McpElicitation,
): McpElicitation[] | undefined {
  if (!list) return list;
  const others = list.filter((candidate) => candidate.id !== elicitation.id);
  if (elicitation.state !== 'pending') return others.length === list.length ? list : others;
  return [...others, elicitation].sort((a, b) => a.createdAt - b.createdAt);
}

/** Pending ones by conversation key (`agentId/threadId`), oldest first; those without a thread are left out. */
export function elicitationsByThread(
  list: readonly McpElicitation[] | undefined,
): Map<string, McpElicitation[]> {
  const out = new Map<string, McpElicitation[]>();
  for (const elicitation of [...(list ?? [])].sort((a, b) => a.createdAt - b.createdAt)) {
    if (elicitation.state !== 'pending' || !elicitation.threadId) continue;
    const key = `${elicitation.agentId}/${elicitation.threadId}`;
    out.set(key, [...(out.get(key) ?? []), elicitation]);
  }
  return out;
}

/** Whether a parsed event looks like an elicitation (the stream is the backend's, but still). */
export function isElicitation(value: unknown): value is McpElicitation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.agentId === 'string' &&
    typeof record.state === 'string' &&
    typeof record.message === 'string' &&
    Boolean(record.requestedSchema) &&
    typeof record.requestedSchema === 'object'
  );
}

/** The first line of a question's message, clipped: what a toast says under its title. */
export function firstLineOf(message: string, max = 100): string {
  const line =
    message
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One line for an elicitation in a list: "Microsoft 365: Send this email to …". */
export function elicitationHeadline(elicitation: Pick<McpElicitation, 'serverName' | 'message'>) {
  const line =
    elicitation.message
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean) ?? '';
  const text = line ? `${elicitation.serverName}: ${line}` : `${elicitation.serverName} asks`;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** "Expires in 14 min", "Expires in 2 h", "Expired": how long until it stops waiting. */
export function expiresLabel(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'Expired';
  if (ms < 60_000) return 'Expires in less than a minute';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `Expires in ${minutes} min`;
  return `Expires in ${Math.round(minutes / 60)} h`;
}

// ── The form ────────────────────────────────────────────────────────────────────────────────

/** A form's values as the fields hold them: text for strings and numbers, booleans for checkboxes. */
export type FormValues = Record<string, string | boolean>;

/** The fields of a schema, in its order. */
export function fieldsOf(schema: ElicitationSchema | undefined): [string, ElicitationField][] {
  const properties = schema?.properties;
  return properties && typeof properties === 'object' ? Object.entries(properties) : [];
}

export const isRequired = (schema: ElicitationSchema | undefined, name: string) =>
  Boolean(schema?.required?.includes(name));

/**
 * The yes-or-no confirmation servers ask before acting (m365's `send`, tdx's
 * `approve`): exactly one field, a boolean. Its name, or null.
 */
export function confirmField(schema: ElicitationSchema | undefined): string | null {
  const fields = fieldsOf(schema);
  const only = fields[0];
  return fields.length === 1 && only && only[1].type === 'boolean' ? only[0] : null;
}

/**
 * An agent's own question (`ask_person`): an elicitation from the agent itself,
 * not from an MCP server. Its card reads "{agent} asks you".
 */
export const isAgentQuestion = (elicitation: Pick<McpElicitation, 'server' | 'tool'>) =>
  elicitation.server === 'agent' && elicitation.tool === 'ask_person';

/**
 * A question with one required field that is a choice from a list (the agent's
 * `choices`): its name and the options, each with the label people read.
 */
export function choiceField(
  schema: ElicitationSchema | undefined,
): { name: string; options: { value: string; label: string }[] } | null {
  const fields = fieldsOf(schema);
  const only = fields[0];
  if (fields.length !== 1 || !only) return null;
  const [name, field] = only;
  if (field.type !== 'string' || !field.enum || field.enum.length === 0) return null;
  const names = field.enumNames?.length === field.enum.length ? field.enumNames : null;
  return {
    name,
    options: field.enum.map((value, index) => ({ value, label: names?.[index] || value })),
  };
}

/** A field's name for people: its title, or its key. */
export const fieldLabel = (name: string, field: ElicitationField) => field.title?.trim() || name;

/** The values a form starts with: each field's default (a valid one), or empty. */
export function initialValues(schema: ElicitationSchema | undefined): FormValues {
  const values: FormValues = {};
  for (const [name, field] of fieldsOf(schema)) {
    const given = field.default;
    if (field.type === 'boolean') values[name] = given === true;
    else if (field.type === 'string')
      values[name] =
        typeof given === 'string' && (!field.enum || field.enum.includes(given)) ? given : '';
    else values[name] = typeof given === 'number' && Number.isFinite(given) ? String(given) : '';
  }
  return values;
}

const isEmpty = (value: string | boolean | undefined) =>
  value === undefined || (typeof value === 'string' && value.trim() === '');

/** Required fields still empty (a checkbox is never empty: unticked is false). */
export function missingRequired(schema: ElicitationSchema | undefined, values: FormValues) {
  return fieldsOf(schema)
    .filter(
      ([name, field]) =>
        isRequired(schema, name) && field.type !== 'boolean' && isEmpty(values[name]),
    )
    .map(([name]) => name);
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** Why a field's value would be refused, or null. Empty values are judged by `missingRequired`. */
function fieldError(field: ElicitationField, value: string | boolean): string | null {
  if (field.type === 'boolean' || typeof value !== 'string') return null;
  if (field.type === 'string') {
    if (field.enum && !field.enum.includes(value)) return 'Choose one of the options.';
    if (field.minLength !== undefined && value.length < field.minLength)
      return `At least ${field.minLength} character${field.minLength === 1 ? '' : 's'}.`;
    if (field.maxLength !== undefined && value.length > field.maxLength)
      return `At most ${field.maxLength} characters.`;
    if (field.format === 'email' && !EMAIL.test(value.trim())) return 'Enter an email address.';
    if (field.format === 'uri') {
      try {
        new URL(value.trim());
      } catch {
        return 'Enter a full address, such as https://example.com.';
      }
    }
    return null;
  }
  const number = Number(value.trim());
  if (!Number.isFinite(number)) return 'Enter a number.';
  if (field.type === 'integer' && !Number.isInteger(number)) return 'Enter a whole number.';
  if (field.minimum !== undefined && number < field.minimum) return `At least ${field.minimum}.`;
  if (field.maximum !== undefined && number > field.maximum) return `At most ${field.maximum}.`;
  return null;
}

/**
 * What Accept sends: each field's value, typed (numbers as numbers), with
 * empty optional fields left out; or why not, by field.
 */
export function contentOf(
  schema: ElicitationSchema | undefined,
  values: FormValues,
): { content: ElicitationContent; errors: Record<string, string> } {
  const content: ElicitationContent = {};
  const errors: Record<string, string> = {};
  for (const [name, field] of fieldsOf(schema)) {
    const value = values[name];
    if (field.type === 'boolean') {
      content[name] = value === true;
      continue;
    }
    if (isEmpty(value)) {
      if (isRequired(schema, name)) errors[name] = 'Required.';
      continue;
    }
    const text = String(value);
    const error = fieldError(field, text);
    if (error) errors[name] = error;
    else content[name] = field.type === 'string' ? text : Number(text.trim());
  }
  return { content, errors };
}
