import { Brain, ChevronDown, type LucideIcon, Wrench } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useId, useState } from 'react';
import {
  isReasoningOnly,
  type ReplyLayout,
  type WorkEntry,
} from '~/components/chat/message-content';
import {
  ReasoningNote,
  ReasoningPreview,
  ReasoningText,
} from '~/components/chat/message-reasoning';
import { agentToolStep, LiveSteps, type ToolPart, ToolStepRow } from '~/components/chat/tool-steps';

/** How many of the latest steps show under a working reply's header. */
const LIVE_STEPS = 3;

import { type WorkStep, workActivity, workSummary } from '~/components/chat/work-summary';
import { useMediaQuery } from '~/hooks/use-media-query';
import { cn } from '~/lib/utils';
import type { ToolStepSummary } from '~/shared';

/**
 * The disclosure every work block is: a header button (the label, an icon,
 * a chevron) and, expanded, its content. Collapsed by default; expanding or
 * collapsing is the person's choice and wins for the rest of the reply. While
 * the model thinks and the person has not chosen, `preview` shows a small
 * window of the latest reasoning under the header.
 */
export function WorkDisclosure({
  label,
  icon: Icon,
  active,
  kind,
  preview,
  live,
  headerRef,
  children,
}: {
  label: string;
  icon: LucideIcon;
  /** The model is working now: the icon pulses (unless motion is reduced). */
  active: boolean;
  /** `reasoning` for a reply's single reasoning run, `work` for the block. */
  kind: 'reasoning' | 'work';
  /** The latest reasoning while the model is thinking. */
  preview?: string;
  /** The latest steps while the agent works and the person has not opened the block. */
  live?: ReactNode;
  headerRef?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? false;
  const panelId = useId();
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  return (
    <div
      className={kind === 'reasoning' ? 'mb-6' : 'mb-4'}
      data-reply-group={kind}
      data-reasoning={kind === 'reasoning' ? (active ? 'thinking' : 'done') : undefined}
      data-work={kind === 'work' ? (active ? 'active' : 'done') : undefined}
    >
      <button
        ref={headerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setChoice(!open)}
        className="flex w-fit max-w-full items-center gap-2 text-left text-[0.8125rem] font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <Icon
          aria-hidden="true"
          data-thinking-indicator={active ? '' : undefined}
          className={cn('size-4 shrink-0', active && !reduceMotion && 'motion-safe:animate-pulse')}
        />
        <span className={cn('min-w-0 break-words', active && 'text-shimmer')}>{label}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-[var(--text-muted)] transition-transform motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>
      {live !== undefined && choice === null && live}
      {preview !== undefined && choice === null && (
        <ReasoningPreview text={preview} onExpand={() => setChoice(true)} />
      )}
      {open && <div id={panelId}>{children}</div>}
    </div>
  );
}

type Entry = WorkEntry<ToolPart>;

const workStepOf = (step: ToolStepSummary): WorkStep => ({
  toolId: step.toolId,
  label: step.label,
  state: step.state,
});

/**
 * Everything a reply did before its answer, as one block (v0.10.1).
 *
 * A reply with a single run of reasoning and no tool calls keeps the plain
 * "Reasoning" disclosure ("Thinking…" with its live window while it thinks).
 * Otherwise the header names the current activity while the model works
 * ("Thinking…", "Searching the web…", "Writing Sales chart…") and summarises
 * the work once the answer starts ("Thought · created an artifact"); expanded,
 * it is a timeline of the reasoning and tool calls in written order, with the
 * search made before the reply first ("Searched the web · 5 sources") and the
 * links tool calls returned last (v0.11: before, each was a disclosure of its
 * own above the block, so a reply has at most one). Both are
 * the same element, so a reply that goes on from reasoning to a tool call
 * keeps the person's choice and focus.
 *
 * Step changes, not tokens, are announced politely.
 */
export function WorkBlock({
  layout,
  streaming,
}: {
  messageId: string;
  layout: ReplyLayout<ToolPart>;
  streaming: boolean;
}) {
  const { work } = layout;
  const reasoningOnly = isReasoningOnly(work);
  const steps: WorkStep[] = work.flatMap((entry): WorkStep[] => {
    if (entry.type !== 'tool') return [];
    const step = workStepOf(agentToolStep(entry.part));
    // Still running once the reply has ended: it was stopped mid-way.
    return [!streaming && step.state === 'running' ? { ...step, state: 'stopped' } : step];
  });
  const hasReasoning = work.some((entry) => entry.type === 'reasoning');

  // What the agent is doing now; nothing once the answer has started or the reply ended.
  const thinking = streaming && layout.last === 'reasoning';
  let activity: ReturnType<typeof workActivity> | null = null;
  if (thinking) activity = workActivity({ type: 'reasoning' });
  else if (streaming && layout.last === 'tools' && layout.lastTool) {
    const step = agentToolStep(layout.lastTool);
    activity = { label: `${step.summary}…`, brief: `Using ${step.label}` };
  }

  const label = reasoningOnly
    ? thinking
      ? 'Thinking…'
      : 'Reasoning'
    : (activity?.label ?? workSummary({ reasoning: hasReasoning, steps }));
  const icon = steps.length === 0 && (hasReasoning || thinking) ? Brain : Wrench;
  const latest = work.at(-1);
  const preview = thinking && latest?.type === 'reasoning' ? latest.text : undefined;
  // While the agent works, its last few steps show under the header, so the
  // person sees what it is doing without opening the block.
  const recentTools =
    streaming && !reasoningOnly
      ? work.flatMap((entry) => (entry.type === 'tool' ? [entry.part] : [])).slice(-LIVE_STEPS)
      : [];

  // Announce each new activity of the block, never each token.
  const [announcement, setAnnouncement] = useState('');
  const brief = !reasoningOnly && activity ? activity.brief : '';
  useEffect(() => {
    if (brief) setAnnouncement(`${brief}…`);
  }, [brief]);

  return (
    <>
      <WorkDisclosure
        label={label}
        icon={icon}
        active={reasoningOnly ? thinking : activity !== null}
        kind={reasoningOnly ? 'reasoning' : 'work'}
        preview={preview}
        live={recentTools.length > 0 ? <LiveSteps parts={recentTools} /> : undefined}
      >
        {reasoningOnly && latest?.type === 'reasoning' ? (
          <>
            <ReasoningText text={latest.text} className="mt-4" />
            <ReasoningNote />
          </>
        ) : (
          <>
            <WorkTimeline entries={work} />
            {hasReasoning && <ReasoningNote />}
          </>
        )}
      </WorkDisclosure>
      {!reasoningOnly && (
        <span role="status" aria-live="polite" className="sr-only">
          {streaming ? announcement : ''}
        </span>
      )}
    </>
  );
}

function WorkTimeline({ entries }: { entries: readonly Entry[] }) {
  return (
    <ol
      aria-label="Steps"
      data-work-timeline=""
      className="mt-3 ml-2 space-y-3 border-l border-[var(--border-subtle)] pl-4"
    >
      {entries.map((entry) => {
        if (entry.type === 'reasoning')
          return (
            <li key={entry.key} className="relative min-w-0" data-work-entry="reasoning">
              <TimelineDot />
              <span className="sr-only">Reasoning: </span>
              <ReasoningText text={entry.text} />
            </li>
          );
        if (entry.type !== 'tool') return null;
        return (
          <li key={entry.key} className="relative min-w-0" data-work-entry="tool">
            <TimelineDot />
            <ToolStepRow part={entry.part} step={agentToolStep(entry.part)} />
          </li>
        );
      })}
    </ol>
  );
}

/** The mark on the timeline's line beside an entry; the entry itself says what it is. */
function TimelineDot() {
  return (
    <span
      aria-hidden="true"
      className="absolute top-2 -left-[1.3rem] size-2 rounded-full border border-[var(--border-strong)] bg-[var(--bg-app)]"
    />
  );
}
