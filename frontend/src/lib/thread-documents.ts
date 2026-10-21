/**
 * The documents agents expose for a conversation (docs/api.md "Documents"),
 * read defensively: their shapes are the runtime's (runtime/src/kinds/
 * researcher.ts and triage.ts), and anything that does not fit them is shown
 * as JSON instead.
 */

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'skipped';
export interface PlanStep {
  id: string;
  text: string;
  status: PlanStepStatus | string;
  subagent: string;
  note: string;
}
/** `research.plan`. */
export interface ResearchPlan {
  question: string;
  steps: PlanStep[];
}

export interface ResearchSource {
  url: string;
  title: string;
  supports: string[];
  step: string;
}
/** `research.sources`. */
export interface ResearchSources {
  sources: ResearchSource[];
}

export type TriageStatus = 'new' | 'triaged' | 'drafted' | 'waiting_approval' | 'done' | 'skipped';
export interface TriageItem {
  id: string;
  title: string;
  url: string;
  status: TriageStatus | string;
  decision: string;
  labels: string[];
  reply: string;
  summary: string;
  links: string[];
  seenAt?: number;
  updatedAt?: number;
}
/** `triage.queue`. */
export interface TriageQueue {
  items: TriageItem[];
}

export type TodoStatus = 'pending' | 'doing' | 'done';
export interface TodoItem {
  text: string;
  status: TodoStatus | string;
}
/** `todo`: the conversation's checklist, written by the agent's `todo` tool. */
export interface TodoList {
  items: TodoItem[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** A research plan, or null when the value is not one. */
export function asResearchPlan(value: unknown): ResearchPlan | null {
  if (!isRecord(value) || !Array.isArray(value.steps)) return null;
  if (!value.steps.every((step) => isRecord(step) && typeof step.text === 'string')) return null;
  return {
    question: str(value.question),
    steps: (value.steps as Record<string, unknown>[]).map((step, index) => ({
      id: str(step.id) || `s${index + 1}`,
      text: str(step.text),
      status: str(step.status) || 'pending',
      subagent: str(step.subagent),
      note: str(step.note),
    })),
  };
}

/** One source, or null. */
export function asResearchSource(value: unknown): ResearchSource | null {
  if (!isRecord(value) || typeof value.url !== 'string') return null;
  return {
    url: value.url,
    title: str(value.title),
    supports: strings(value.supports),
    step: str(value.step),
  };
}

/** The sources list, or null. */
export function asResearchSources(value: unknown): ResearchSources | null {
  if (!isRecord(value) || !Array.isArray(value.sources)) return null;
  const sources = value.sources.map(asResearchSource);
  if (sources.some((source) => source === null)) return null;
  return { sources: sources as ResearchSource[] };
}

/** One triage item, or null. */
export function asTriageItem(value: unknown): TriageItem | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  return {
    id: value.id,
    title: str(value.title),
    url: str(value.url),
    status: str(value.status) || 'new',
    decision: str(value.decision),
    labels: strings(value.labels),
    reply: str(value.reply),
    summary: str(value.summary),
    links: strings(value.links),
    ...(typeof value.seenAt === 'number' ? { seenAt: value.seenAt } : {}),
    ...(typeof value.updatedAt === 'number' ? { updatedAt: value.updatedAt } : {}),
  };
}

/** The triage queue, or null. */
export function asTriageQueue(value: unknown): TriageQueue | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const items = value.items.map(asTriageItem);
  if (items.some((item) => item === null)) return null;
  return { items: items as TriageItem[] };
}

/** Counts by status, as `triage_*` tools report them in their details; null when not that. */
export function asStatusCounts(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || !entries.every(([, count]) => typeof count === 'number')) return null;
  return value as Record<string, number>;
}

/** The checklist, or null when the value is not one. */
export function asTodoList(value: unknown): TodoList | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  if (!value.items.every((item) => isRecord(item) && typeof item.text === 'string')) return null;
  return {
    items: (value.items as Record<string, unknown>[]).map((item) => ({
      text: str(item.text),
      status: str(item.status) || 'pending',
    })),
  };
}

const TITLES: Record<string, string> = {
  'research.plan': 'Research plan',
  'research.sources': 'Sources',
  'triage.queue': 'Triage queue',
  todo: 'Checklist',
};

/** A document's name as people read it: known kinds by name, others as their kind. */
export const documentTitle = (kind: string) => TITLES[kind] ?? kind;

/** Known kinds first, in a fixed order; the rest by name. */
export function sortDocumentKinds(kinds: readonly string[]): string[] {
  const order = Object.keys(TITLES);
  return [...kinds].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== ib) return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
    return a.localeCompare(b);
  });
}

/** A status as people read it: "waiting_approval" → "Waiting for approval". */
export function statusLabel(status: string): string {
  if (status === 'waiting_approval') return 'Waiting for approval';
  const words = status.replace(/[_-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Unknown';
}

/** Formatted JSON for anything, never throwing. */
export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A link is shown as a link only when it is http(s). */
export const isWebUrl = (url: string) => /^https?:\/\/\S+$/i.test(url);
