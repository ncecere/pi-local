import { Link } from '@tanstack/react-router';
import type { UIMessage } from 'ai';
import {
  ArrowUpRight,
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
  MessagesSquare,
  Search,
  ShieldAlert,
  SquareTerminal,
  Users,
  Wrench,
} from 'lucide-react';
import { useId, useState } from 'react';
import { ApprovalOutcome } from '~/components/chat/approval-card';
import { ToolDetailsView } from '~/components/chat/document-views';
import { useAgents } from '~/hooks/use-agents';
import { type AskStep, askStepOf, askSummary, type ListAgentsStep } from '~/lib/agent-asks';
import { approvalOutcome } from '~/lib/approvals';
import { approvalOf, toolDetailsOf, toolDetailsOmittedOf, toolOutputText } from '~/lib/chat-view';
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
  // Asking another agent reads as what it is: "Asked Ada", "Asking Ada".
  const ask = askStepOf(part);
  if (ask && (step.state === 'running' || step.state === 'done' || step.state === 'error'))
    return { ...step, summary: askSummary(ask, step.state) };
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
  const approval = approvalOf(part);
  if (step.state === 'awaiting-approval')
    return <p className="text-[var(--text-muted)]">Not run yet: it waits for your approval.</p>;
  if (step.state === 'denied')
    return (
      <p className="text-[var(--text-muted)]">
        Not run
        {approval && approval.status !== 'denied'
          ? ` (${approvalOutcome(approval).toLowerCase()})`
          : step.reason
            ? `: ${step.reason}`
            : ''}
        .
      </p>
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
  if (step.state === 'awaiting-approval')
    return <ShieldAlert className="size-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />;
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

/**
 * The ask a part is, with the asked agent named: the model may pass an ID
 * ("ag_…"), which the agent list turns into a name until the result says it.
 */
function useAskStep(part: ToolPart): AskStep | ListAgentsStep | null {
  const agents = useAgents().data;
  const ask = askStepOf(part);
  if (ask?.kind !== 'ask' || ask.target || !ask.agentName) return ask;
  const named = agents?.find((agent) => agent.id === ask.agentName)?.name;
  return named ? { ...ask, agentName: named } : ask;
}

/** An ask's line: who was asked, and the start of the message. */
function AskLine({
  part,
  step,
  ask,
}: {
  part: ToolPart;
  step: ToolStepSummary;
  ask: AskStep | ListAgentsStep;
}) {
  const took = toolDuration(part);
  const Icon = ask.kind === 'ask' ? MessagesSquare : Users;
  return (
    <>
      {step.state === 'running' ? (
        <LoaderCircle
          className="size-4 shrink-0 text-[var(--text-secondary)] motion-safe:animate-spin"
          aria-hidden="true"
        />
      ) : (
        <Icon
          className={cn(
            'size-4 shrink-0',
            step.state === 'error' && 'text-[var(--danger-on-tint)]',
          )}
          aria-hidden="true"
        />
      )}
      <span className="shrink-0 font-medium text-[var(--text-secondary)]">
        {askSummary(ask, step.state === 'error' ? 'done' : step.state)}
      </span>
      {ask.kind === 'ask' && ask.message && (
        <span className="min-w-0 truncate" title={ask.message}>
          {clip(ask.message.replace(/\s+/g, ' '), 100)}
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

/** An ask, expanded: the message sent, the reply, and the asked agent's conversation. */
function AskDetails({ ask, step }: { ask: AskStep; step: ToolStepSummary }) {
  const [all, setAll] = useState(false);
  const reply = ask.reply ?? '';
  const long = reply.length > OUTPUT_PREVIEW_CHARS;
  return (
    <>
      <div>
        <p className="mb-1.5 font-medium text-[var(--text-primary)]">
          Message{ask.agentName ? ` to ${ask.agentName}` : ''}
          {ask.conversation === 'new' && (
            <span className="font-normal text-[var(--text-muted)]"> (a new conversation)</span>
          )}
        </p>
        <p className="whitespace-pre-wrap break-words text-[0.8125rem] leading-relaxed text-[var(--text-primary)]">
          {ask.message ?? '—'}
        </p>
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <p className="font-medium text-[var(--text-primary)]">
            {step.state === 'error' ? 'What went wrong' : 'Reply'}
          </p>
          {reply && <CopyButton text={reply} label="Copy reply" />}
        </div>
        {step.state === 'running' ? (
          <p className="text-[var(--text-muted)]">Waiting for {ask.agentName ?? 'the agent'}…</p>
        ) : step.state === 'denied' ? (
          <p className="text-[var(--text-muted)]">
            Not asked{step.reason ? `: ${step.reason}` : ''}.
          </p>
        ) : reply ? (
          <>
            <p
              className={cn(
                'max-h-96 overflow-auto whitespace-pre-wrap break-words border-l-2 border-[var(--border-strong)] py-0.5 pl-3 text-[0.8125rem] leading-relaxed',
                step.state === 'error'
                  ? 'text-[var(--danger-on-tint)]'
                  : 'text-[var(--text-primary)]',
              )}
            >
              {long && !all ? `${reply.slice(0, OUTPUT_PREVIEW_CHARS)}…` : reply}
            </p>
            {long && (
              <button
                type="button"
                className="mt-1 text-[var(--text-muted)] underline hover:text-[var(--text-primary)]"
                onClick={() => setAll(!all)}
              >
                {all
                  ? 'Show less'
                  : `Show all (${reply.length.toLocaleString('en-US')} characters)`}
              </button>
            )}
          </>
        ) : (
          <p className="text-[var(--text-muted)]">No reply.</p>
        )}
      </div>
      {ask.target && (
        <Link
          to="/agents/$agentId/threads/$threadId"
          params={{ agentId: ask.target.agentId, threadId: ask.target.threadId }}
          className="inline-flex items-center gap-1 text-[var(--accent-bright)] underline-offset-4 hover:underline"
        >
          Open {ask.target.agentName}'s conversation
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </Link>
      )}
    </>
  );
}

/** One line for a step: icon, tool, what it acted on, and how it went. */
function StepLine({ part, step }: { part: ToolPart; step: ToolStepSummary }) {
  const ask = useAskStep(part);
  const approval = approvalOf(part);
  if (ask && !approval) return <AskLine part={part} step={step} ask={ask} />;
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
      {approval ? (
        <ApprovalOutcome approval={approval} className="shrink-0 max-w-[50%]" />
      ) : (
        step.state === 'denied' && <span className="shrink-0">not run</span>
      )}
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
  const ask = useAskStep(part);
  const approval = approvalOf(part);
  // How its request ended, when the summary doesn't already say it.
  const outcome =
    approval &&
    (approval.status === 'approved' ||
      approval.status === 'timed_out' ||
      approval.status === 'cancelled')
      ? `, ${approvalOutcome(approval).toLowerCase()}`
      : '';
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={
          (ask && step.state !== 'denied' && step.state !== 'awaiting-approval'
            ? askSummary(ask, step.state)
            : step.summary) + outcome
        }
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
          {ask?.kind === 'ask' ? (
            <AskDetails ask={ask} step={step} />
          ) : (
            <ToolStepBody part={part} step={step} output={output} hasInputs={hasInputs} />
          )}
        </div>
      )}
    </div>
  );
}

/** A tool call's inputs and output, as any tool shows them. */
function ToolStepBody({
  part,
  step,
  output,
  hasInputs,
}: {
  part: ToolPart;
  step: ToolStepSummary;
  output: string | null;
  hasInputs: boolean;
}) {
  return (
    <>
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
      <ToolDetails part={part} />
    </>
  );
}

/**
 * What the tool reported for apps besides its text (`details`), behind a
 * disclosure: drawn for the shapes the app knows (a research plan, a source,
 * a triage item), JSON otherwise. Details too large for the view are left out
 * by the runtime, and it says so.
 */
function ToolDetails({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const meta = part as { toolMetadata?: unknown };
  const details = toolDetailsOf(meta);
  const omitted = toolDetailsOmittedOf(meta);
  if (details === undefined && !omitted) return null;
  if (details === undefined)
    return (
      <p className="text-[var(--text-muted)]" data-tool-details-omitted="">
        The tool reported details too large to show here.
      </p>
    );
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 font-medium text-[var(--text-primary)] hover:underline"
      >
        Details
        <ChevronDown
          className={cn('size-3.5 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div id={id} className="mt-1.5">
          <ToolDetailsView toolName={String(part.toolName ?? '')} details={details} />
          {omitted && (
            <p className="mt-1 text-[var(--text-muted)]">
              Its latest details were too large to show.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
