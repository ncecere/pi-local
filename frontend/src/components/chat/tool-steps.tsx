import type { UIMessage } from 'ai';
import {
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  Copy,
  FilePen,
  FileText,
  Globe,
  LoaderCircle,
  type LucideIcon,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import { useId, useState } from 'react';
import { toolOutputText } from '~/lib/chat-view';
import { formatDuration } from '~/lib/reply-meta';
import { cn } from '~/lib/utils';
import { isToolPart, summarizeToolPart, type ToolStepSummary } from '~/shared';

export type ToolPart = Record<string, unknown> & { type: string; toolCallId: string };

/** The longest output a step shows before "Show all". */
const OUTPUT_PREVIEW_CHARS = 4_000;

/** The tool parts of a message, with the summary every renderer shows. */
export function toolStepsOf(message: UIMessage): Array<{ part: ToolPart; step: ToolStepSummary }> {
  return message.parts.filter(isToolPart).map((part) => ({
    part: part as ToolPart,
    step: agentToolStep(part as ToolPart),
  }));
}

const INPUT_HINT_KEYS = [
  'command',
  'cmd',
  'path',
  'file_path',
  'filePath',
  'file',
  'url',
  'query',
  'pattern',
  'name',
] as const;

/** What a call acted on, from its arguments: the command, the file, the query. */
export function inputHint(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  for (const key of INPUT_HINT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').trim();
  }
  // Otherwise the first short text it was given ("Asia/Tokyo").
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim() && value.length <= 120)
      return value.replace(/\s+/g, ' ').trim();
  }
  return null;
}

const clip = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * A tool step as the conversation shows it. An agent's tools are its own
 * (bash, read, edit, MCP tools…), so the line names the tool and what it
 * acted on: "bash · ls -la", "read · src/main.ts".
 */
export function agentToolStep(part: ToolPart): ToolStepSummary {
  const step = summarizeToolPart(part);
  const hint = inputHint(part.input);
  const target = hint ? ` · ${clip(hint)}` : '';
  const summary =
    step.state === 'running'
      ? `${step.label}${target}`
      : step.state === 'error'
        ? `${step.label}${target} failed`
        : step.state === 'done'
          ? `${step.label}${target}`
          : step.summary;
  return { ...step, summary };
}

/**
 * An icon for what a tool does, read from its name: agents' tools are their
 * own (bash, read, edit, web_search, MCP tools…), so this is a guess, with a
 * wrench for anything it does not recognise.
 */
export function toolIconOf(name: string): LucideIcon {
  const id = name.toLowerCase();
  if (/web|fetch|http|url|brows|crawl/.test(id)) return Globe;
  if (/bash|shell|exec|terminal|command|run_|^run$|sh$/.test(id)) return SquareTerminal;
  if (/grep|search|find|glob|lookup|query/.test(id)) return Search;
  if (/write|edit|patch|create|update|apply|replace|delete|remove/.test(id)) return FilePen;
  if (/read|cat|view|open|file|^ls$|list/.test(id)) return FileText;
  if (/time|clock|date|calendar/.test(id)) return Clock;
  if (/memory|remember|recall|note/.test(id)) return Brain;
  return Wrench;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const formatInput = (input: unknown) => {
  try {
    return JSON.stringify(input ?? {}, null, 2);
  } catch {
    return String(input);
  }
};

/** Output that is JSON, indented; anything else as it came. */
export function prettyOutput(text: string): string {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        });
      }}
      className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-white/5 hover:text-[var(--text-primary)]"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/**
 * A call's inputs as people read them: a command as a terminal line, a few
 * plain values as name and value, anything else as JSON.
 */
function ToolInputs({ input }: { input: unknown }) {
  if (isRecord(input)) {
    const entries = Object.entries(input);
    if (entries.length === 0) return null;
    const command = input.command ?? input.cmd;
    if (typeof command === 'string' && entries.length <= 2) {
      return (
        <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/25 px-2.5 py-2 font-mono text-[var(--text-primary)]">
          <span className="select-none text-[var(--text-muted)]">$ </span>
          {command}
        </pre>
      );
    }
    const plain = entries.every(
      ([, value]) =>
        ['string', 'number', 'boolean'].includes(typeof value) && String(value).length <= 300,
    );
    if (plain && entries.length <= 8) {
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-[var(--text-muted)]">{key}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words font-mono text-[var(--text-primary)]">
                {String(value)}
              </dd>
            </div>
          ))}
        </dl>
      );
    }
  }
  return (
    <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono">
      {formatInput(input)}
    </pre>
  );
}

function ToolOutput({ part, step }: { part: ToolPart; step: ToolStepSummary }) {
  const [all, setAll] = useState(false);
  const raw = toolOutputText(part);
  if (step.state === 'denied')
    return (
      <p className="text-[var(--text-muted)]">Not run{step.reason ? `: ${step.reason}` : ''}.</p>
    );
  if (raw === null || raw === '')
    return (
      <p className="text-[var(--text-muted)]">
        {step.state === 'running'
          ? 'Running…'
          : step.state === 'error'
            ? 'The tool failed.'
            : 'No output.'}
      </p>
    );
  const text = step.state === 'running' ? raw : prettyOutput(raw);
  const long = text.length > OUTPUT_PREVIEW_CHARS;
  return (
    <>
      <pre
        className={cn(
          'max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/25 px-2.5 py-2 font-mono',
          step.state === 'error' && 'text-[var(--danger-on-tint)]',
        )}
      >
        {long && !all ? `${text.slice(0, OUTPUT_PREVIEW_CHARS)}…` : text}
      </pre>
      {long && (
        <button
          type="button"
          className="mt-1 text-[var(--text-muted)] underline hover:text-[var(--text-primary)]"
          onClick={() => setAll(!all)}
        >
          {all ? 'Show less' : `Show all (${text.length.toLocaleString('en-US')} characters)`}
        </button>
      )}
    </>
  );
}

/** How long a finished call ran, from the platform's start and end times; null when it does not say. */
export function toolDuration(part: ToolPart): number | null {
  const timing = part.toolMetadata as { startedAt?: unknown; endedAt?: unknown } | undefined;
  return typeof timing?.startedAt === 'number' &&
    typeof timing.endedAt === 'number' &&
    timing.endedAt >= timing.startedAt
    ? timing.endedAt - timing.startedAt
    : null;
}

/** What the tool acted on, for the row: the command, the file, the query. */
const hintOf = (part: ToolPart) => inputHint(part.input);

/** The icon at the start of a step's row: the tool's own, or a spinner while it runs. */
function StepIcon({ part, step }: { part: ToolPart; step: ToolStepSummary }) {
  if (step.state === 'running')
    return (
      <LoaderCircle
        className="size-4 shrink-0 text-[var(--text-secondary)] motion-safe:animate-spin"
        aria-hidden="true"
      />
    );
  const Icon =
    step.state === 'error' ? CircleAlert : toolIconOf(String(part.toolName ?? step.label));
  return (
    <Icon
      className={cn('size-4 shrink-0', step.state === 'error' && 'text-[var(--danger-on-tint)]')}
      aria-hidden="true"
    />
  );
}

/** One line for a step: icon, tool, what it acted on, and how it went. */
function StepLine({ part, step }: { part: ToolPart; step: ToolStepSummary }) {
  const hint = hintOf(part);
  const took = toolDuration(part);
  return (
    <>
      <StepIcon part={part} step={step} />
      <span className="shrink-0 font-medium text-[var(--text-secondary)]">{step.label}</span>
      {hint && (
        <span className="min-w-0 truncate font-mono text-[0.75rem]" title={hint}>
          {hint}
        </span>
      )}
      {step.state === 'error' && (
        <span className="shrink-0 text-[var(--danger-on-tint)]">failed</span>
      )}
      {took !== null && (
        <span className="shrink-0 text-[0.75rem] tabular-nums opacity-70" title="How long it ran">
          {formatDuration(took)}
        </span>
      )}
      {step.state === 'denied' && <span className="shrink-0">not run</span>}
    </>
  );
}

/** The latest few steps while the agent works, under the work block's header. */
export function LiveSteps({ parts }: { parts: ToolPart[] }) {
  return (
    <ul aria-hidden="true" className="mt-2 space-y-1.5" data-live-steps="">
      {parts.map((part) => (
        <li
          key={part.toolCallId}
          className="flex min-w-0 items-center gap-2 text-[0.8125rem] text-[var(--text-muted)] motion-safe:animate-[row-in_150ms_ease-out]"
        >
          <StepLine part={part} step={agentToolStep(part)} />
        </li>
      ))}
    </ul>
  );
}

/** One tool call: a one-line summary that expands to its inputs and output. */
export function ToolStepRow({ part, step }: { part: ToolPart; step: ToolStepSummary }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const output = toolOutputText(part);
  const hasInputs = isRecord(part.input) ? Object.keys(part.input).length > 0 : part.input != null;
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={step.summary}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 text-left text-[0.8125rem] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <StepLine part={part} step={step} />
        <span className="flex-1" />
        <ChevronDown
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          id={detailsId}
          className="mt-2 space-y-3 rounded-lg border border-[var(--border-subtle)] bg-black/10 px-3 py-2.5 text-xs text-[var(--text-secondary)]"
        >
          {hasInputs && (
            <div>
              <p className="mb-1.5 font-medium text-[var(--text-primary)]">Input</p>
              <ToolInputs input={part.input} />
            </div>
          )}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="font-medium text-[var(--text-primary)]">
                {step.state === 'running' ? 'Output so far' : 'Output'}
              </p>
              {output && <CopyButton text={output} label="Copy output" />}
            </div>
            <ToolOutput part={part} step={step} />
          </div>
        </div>
      )}
    </div>
  );
}
