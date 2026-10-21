import { Link } from '@tanstack/react-router';
import { Brain, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '~/api/client';
import type { ToolPart } from '~/components/chat/tool-steps';
import { type RememberResult, rememberResultOf, useUndoRemember } from '~/hooks/use-memory';
import { toolDetailsOf, toolOutputText } from '~/lib/chat-view';
import { cn } from '~/lib/utils';

/** What a finished `remember` call saved, or null: a call still running, failed or not understood. */
export function rememberOf(part: ToolPart): (RememberResult & { text: string }) | null {
  if (part.type !== 'dynamic-tool' || part.toolName !== 'remember') return null;
  if (part.state !== 'output-available') return null;
  // The details say what was saved; older replies only have the text.
  const result =
    rememberDetailsOf(toolDetailsOf(part as { toolMetadata?: unknown })) ??
    rememberResultOf(toolOutputText(part));
  if (!result) return null;
  const input = part.input as { text?: unknown } | undefined;
  const text = typeof input?.text === 'string' ? input.text.trim() : '';
  return { ...result, text };
}

function rememberDetailsOf(details: unknown): RememberResult | null {
  if (!details || typeof details !== 'object') return null;
  const { kind, id } = details as { kind?: unknown; id?: unknown };
  if (typeof id !== 'string' || !/^(um|an)_/.test(id)) return null;
  if (kind === 'note' || kind === 'known' || kind === 'suggested') return { kind, id };
  return null;
}

/** Memories undone in this window: a reply drawn again still says so. */
const undone = new Set<string>();

/**
 * A `remember` step, as the reply shows it: "Remembered: …", or
 * "Suggested: … · Review" (a suggestion waits in Settings → You), with Undo,
 * which deletes what was saved.
 */
export function RememberChip({ part, agentId }: { part: ToolPart; agentId?: string }) {
  const saved = rememberOf(part);
  const undo = useUndoRemember();
  const [gone, setGone] = useState(() => (saved ? undone.has(saved.id) : false));
  if (!saved) return null;
  const suggested = saved.kind === 'suggested';
  const label = suggested ? 'Suggested' : 'Remembered';
  const canUndo = saved.kind !== 'note' || Boolean(agentId);

  const markGone = () => {
    undone.add(saved.id);
    setGone(true);
  };

  return (
    <div
      className="mb-3 flex w-fit max-w-full items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-control)]/50 px-3 py-1 text-xs text-[var(--text-secondary)]"
      data-remember={saved.kind}
      data-memory-id={saved.id}
    >
      <Brain className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      {gone ? (
        <span className="text-[var(--text-muted)]">
          {suggested ? 'Suggestion removed' : 'Forgotten'}
          {saved.text && <span className="line-through">: {saved.text}</span>}
        </span>
      ) : (
        <>
          <span className={cn('min-w-0 truncate')} title={saved.text || undefined}>
            <span className="font-medium text-[var(--text-primary)]">{label}:</span>{' '}
            {saved.text || (saved.kind === 'note' ? 'a note' : 'something about you')}
          </span>
          {suggested && (
            <>
              <span aria-hidden="true">·</span>
              <Link
                to="/settings/you"
                className="shrink-0 font-medium text-[var(--accent-bright)] underline-offset-4 hover:underline"
              >
                Review
              </Link>
            </>
          )}
          {canUndo && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                disabled={undo.isPending}
                aria-label={`Undo: ${label.toLowerCase()} ${saved.text}`.trim()}
                onClick={() =>
                  undo.mutate(
                    { agentId, id: saved.id },
                    {
                      onSuccess: markGone,
                      onError: (error) => {
                        // Deleted already (in Settings, or by the agent): it's gone either way.
                        if (error instanceof ApiError && error.status === 404) markGone();
                        else toast.error(errorMessage(error, 'It could not be undone.'));
                      },
                    },
                  )
                }
                className="inline-flex shrink-0 items-center gap-1 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
              >
                <Undo2 className="size-3" aria-hidden="true" />
                Undo
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
