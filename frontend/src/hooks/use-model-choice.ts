import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFeature } from '~/hooks/use-session';
import { changesTo, type ModelChoice } from '~/lib/model-choice';

/**
 * The model and thinking level chosen in the composer, and what to send.
 *
 * `current` is what the conversation has now (its thread's `modelId` and
 * `thinking`; nothing in a new chat). A choice is local until a message goes
 * with it; only what differs from the conversation's own is sent, and once a
 * message carries it the conversation has it, so the next one leaves it out.
 *
 * `seed` starts a conversation opened from the new chat page with the choice
 * its first message carries; `commit` is called once that message was accepted.
 *
 * `scope` names what the choice belongs to (the new chat page's selected
 * agent): when it changes, the choice is dropped, so one agent's pick never
 * carries over to another.
 */
export function useModelChoice(current: ModelChoice, seed?: Partial<ModelChoice>, scope?: string) {
  const on = useFeature('modelPerConversation');
  /** What the person picked and no message has carried yet. */
  const [choice, setChoice] = useState<ModelChoice | null>(() =>
    seed && Object.keys(seed).length > 0 ? { ...current, ...seed } : null,
  );
  /** What messages carried, until the conversation's own record says the same. */
  const [carried, setCarried] = useState<Partial<ModelChoice> | null>(null);
  // A new scope starts from the baseline again (adjusted while rendering, so no stale choice is drawn).
  const [scopeSeen, setScopeSeen] = useState(scope);
  if (scopeSeen !== scope) {
    setScopeSeen(scope);
    setChoice(null);
  }

  const { modelId, thinking } = current;
  useEffect(() => {
    if (!carried) return;
    const synced =
      (carried.modelId === undefined || carried.modelId === modelId) &&
      (carried.thinking === undefined || carried.thinking === thinking);
    if (synced) setCarried(null);
  }, [carried, modelId, thinking]);

  const baseline = useMemo<ModelChoice>(
    () => ({
      modelId: carried?.modelId ?? modelId,
      thinking: carried?.thinking ?? thinking,
    }),
    [carried, modelId, thinking],
  );
  const shown = choice ?? baseline;
  const changes = useMemo(
    () => (on && choice ? changesTo(baseline, choice) : {}),
    [on, choice, baseline],
  );

  /** A model was picked. A model that can't think has no thinking level. */
  const pickModel = useCallback(
    (nextModelId: string, reasoning: boolean) =>
      setChoice({ modelId: nextModelId, thinking: reasoning ? shown.thinking : '' }),
    [shown.thinking],
  );
  const pickThinking = useCallback(
    (nextThinking: string) => setChoice({ modelId: shown.modelId, thinking: nextThinking }),
    [shown.modelId],
  );
  /** A message carried these: the conversation has them now. */
  const commit = useCallback((sent: Partial<ModelChoice>) => {
    if (Object.keys(sent).length === 0) return;
    setCarried((before) => ({ ...before, ...sent }));
    setChoice(null);
  }, []);

  return { shown, changes, pickModel, pickThinking, commit };
}
