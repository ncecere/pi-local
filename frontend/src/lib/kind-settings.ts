import type { Agent } from '~/api/types';

/**
 * An agent kind's own settings (`Agent.kindSettings`), as the runtime reads
 * them (runtime/src/kinds/*.ts): fields left out take the runtime's defaults,
 * and a field it doesn't know makes the agent fail to start, so only these are
 * ever saved.
 */

export interface TriageSettings {
  /** MCP tools that list new or open items (names, or patterns with `*`). */
  listTools: string[];
  /** MCP tools that read one item. */
  readTools: string[];
  /** MCP tools that write: comment, label, close. */
  writeTools: string[];
  /** Ask a person before every write tool runs. */
  approveWrites: boolean;
}

export interface ResearcherSettings {
  /** Research in background subagents. */
  backgroundSubagents: boolean;
  /** The most steps a research plan may have, 1–20. */
  maxPlanSteps: number;
}

/** The runtime's defaults (runtime/src/kinds/triage.ts, researcher.ts). */
export const TRIAGE_DEFAULTS: TriageSettings = {
  listTools: [],
  readTools: [],
  writeTools: [],
  approveWrites: true,
};
export const RESEARCHER_DEFAULTS: ResearcherSettings = {
  backgroundSubagents: true,
  maxPlanSteps: 8,
};
export const MIN_PLAN_STEPS = 1;
export const MAX_PLAN_STEPS = 20;

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

export function readTriageSettings(raw: Agent['kindSettings'] | undefined): TriageSettings {
  const settings = raw ?? {};
  return {
    listTools: list(settings.listTools),
    readTools: list(settings.readTools),
    writeTools: list(settings.writeTools),
    approveWrites: flag(settings.approveWrites, TRIAGE_DEFAULTS.approveWrites),
  };
}

export function readResearcherSettings(raw: Agent['kindSettings'] | undefined): ResearcherSettings {
  const settings = raw ?? {};
  const steps = settings.maxPlanSteps;
  return {
    backgroundSubagents: flag(
      settings.backgroundSubagents,
      RESEARCHER_DEFAULTS.backgroundSubagents,
    ),
    maxPlanSteps:
      typeof steps === 'number' && Number.isInteger(steps)
        ? clampPlanSteps(steps)
        : RESEARCHER_DEFAULTS.maxPlanSteps,
  };
}

export const clampPlanSteps = (steps: number) =>
  Math.min(MAX_PLAN_STEPS, Math.max(MIN_PLAN_STEPS, Math.round(steps)));

/**
 * Tool names typed one per line or separated by commas: trimmed, each once,
 * in the order given ("github_*, github_get_issue").
 */
export function parseToolList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** A tool list as the field shows it: one per line. */
export const formatToolList = (tools: readonly string[]) => tools.join('\n');

/** Whether the kind has settings of its own (an assistant has none). */
export const hasKindSettings = (kind: Agent['agentKind']) =>
  kind === 'triage' || kind === 'researcher';
