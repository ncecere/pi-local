import { toolDetailsOf, toolOutputText } from '~/lib/chat-view';
import { type ToolStepState, toolIdOfPart } from '~/shared';

/**
 * A reply's tool steps in the words people use, for the agent's own tools:
 * "Asked you: Which day? · Answered "Monday"", "Updated the checklist",
 * "Notified you: Report ready", "Ran ls -la", "Read notes.md", "Wrote plan.md",
 * "Searched the web: otters". Anything else keeps the generic "Used <tool>".
 */

type PartLike = Record<string, unknown> & { type: string; toolMetadata?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : null;
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** What happened to a question the agent asked the person (`ask_person`). */
export type AskPersonOutcome =
  | { kind: 'answered'; answer: string | boolean }
  | { kind: 'declined' | 'expired' | 'withdrawn' };

/** An `ask_person` call as the transcript shows it: the question, and how it ended. */
export interface AskPersonStep {
  question: string | null;
  outcome: AskPersonOutcome | null;
}

/** The outcome from the result's `details` (`{question, outcome, answer?}`). */
function outcomeFromDetails(details: unknown): AskPersonOutcome | null {
  if (!isRecord(details)) return null;
  switch (details.outcome) {
    case 'answered':
      return typeof details.answer === 'string' || typeof details.answer === 'boolean'
        ? { kind: 'answered', answer: details.answer }
        : null;
    case 'declined':
    case 'expired':
    case 'withdrawn':
      return { kind: details.outcome };
    default:
      return null;
  }
}

/** The outcome from a result's text, for replies written before `details` existed. */
function outcomeFromText(text: string | null, yesNo: boolean): AskPersonOutcome | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const answered = /^They answered:\s*([\s\S]*)$/.exec(trimmed);
  if (answered) {
    const answer = (answered[1] ?? '').trim();
    const yes = /^(yes|no)\.?$/i.exec(answer);
    if (yesNo && yes) return { kind: 'answered', answer: yes[1]?.toLowerCase() === 'yes' };
    return { kind: 'answered', answer };
  }
  if (/^They declined to answer/i.test(trimmed)) return { kind: 'declined' };
  if (/^Nobody answered/i.test(trimmed)) return { kind: 'expired' };
  if (/^The question was withdrawn/i.test(trimmed)) return { kind: 'withdrawn' };
  return null;
}

/** The ask a finished or running `ask_person` part is; null for any other tool. */
export function askPersonStepOf(part: PartLike): AskPersonStep | null {
  if (toolIdOfPart(part) !== 'ask_person') return null;
  const input = isRecord(part.input) ? part.input : {};
  const details = toolDetailsOf(part);
  const running = part.state === 'input-available' || part.state === 'input-streaming';
  const finished = part.state === 'output-available' || part.state === 'output-error';
  const yesNo = input.yes_no === true && !Array.isArray(input.choices);
  const outcome = running
    ? null
    : (outcomeFromDetails(details) ??
      (finished ? outcomeFromText(toolOutputText(part), yesNo) : null));
  return {
    question: str(isRecord(details) ? details.question : null) ?? str(input.question),
    outcome,
  };
}

/** "Answered "Morning"", "Answered yes", "Declined", "No answer". */
export function askOutcomeLabel(outcome: AskPersonOutcome): string {
  switch (outcome.kind) {
    case 'answered':
      if (typeof outcome.answer === 'boolean') return `Answered ${outcome.answer ? 'yes' : 'no'}`;
      return outcome.answer.trim() ? `Answered "${clip(outcome.answer.trim(), 40)}"` : 'Answered';
    case 'declined':
      return 'Declined';
    case 'expired':
      return 'No answer';
    case 'withdrawn':
      return 'Withdrawn';
  }
}

/** The last part of a path: "notes.md" for "/work/docs/notes.md". */
function fileName(input: Record<string, unknown>): string | null {
  for (const key of ['path', 'file_path', 'filePath', 'file']) {
    const path = str(input[key]);
    if (path)
      return clip(
        path
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop() || path,
        60,
      );
  }
  return null;
}

/** A command on one line, as short as a row can show. */
function commandLine(input: Record<string, unknown>): string | null {
  const command = str(input.command) ?? str(input.cmd);
  return command ? clip(command, 60) : null;
}

/**
 * The step as one phrase: "Ran ls -la", "Asked you: Which day? · Declined".
 * Null for a tool that has no phrase of its own, or a step waiting for approval
 * or denied (the generic wording says that best).
 */
export function humanStepName(part: PartLike, state: ToolStepState): string | null {
  const tool = toolIdOfPart(part);
  const input = isRecord(part.input) ? part.input : {};
  const running = state === 'running';
  // Done: the past tense. Running, and failed ("Running ls failed"): the present.
  const at = (past: string, present: string, target: string | null, sep = ' ') => {
    const tail = target ? `${sep}${target}` : '';
    if (state === 'done') return `${past}${tail}`;
    if (running) return `${present}${tail}`;
    if (state === 'error') return `${present}${tail} failed`;
    return null;
  };

  switch (tool) {
    case 'ask_person': {
      const ask = askPersonStepOf(part);
      if (!ask) return null;
      const question = ask.question ? clip(ask.question, 80) : null;
      if (running) return question ? `Asking you: ${question}` : 'Asking you';
      const outcome =
        ask.outcome ?? (state === 'declined' ? ({ kind: 'declined' } as const) : null);
      if (!outcome) {
        if (state === 'error') return `Asking you${question ? `: ${question}` : ''} failed`;
        if (state !== 'done') return null;
        return question ? `Asked you: ${question}` : 'Asked you';
      }
      const asked = question ? `Asked you: ${question}` : 'Asked you';
      return `${asked} · ${askOutcomeLabel(outcome)}`;
    }
    case 'todo':
      return at('Updated the checklist', 'Updating the checklist', null);
    case 'notify_person': {
      const title = str(input.title);
      return at('Notified you', 'Notifying you', title ? clip(title, 60) : null, ': ');
    }
    case 'bash': {
      const command = commandLine(input);
      return at(
        command ? 'Ran' : 'Ran a command',
        command ? 'Running' : 'Running a command',
        command,
      );
    }
    case 'read': {
      const file = fileName(input);
      return at(file ? 'Read' : 'Read a file', file ? 'Reading' : 'Reading a file', file);
    }
    case 'write': {
      const file = fileName(input);
      return at(file ? 'Wrote' : 'Wrote a file', file ? 'Writing' : 'Writing a file', file);
    }
    case 'edit': {
      const file = fileName(input);
      return at(file ? 'Edited' : 'Edited a file', file ? 'Editing' : 'Editing a file', file);
    }
    case 'web_search': {
      const query = str(input.query);
      return at('Searched the web', 'Searching the web', query ? clip(query, 80) : null, ': ');
    }
    default:
      return null;
  }
}
