import type { Agent, CatalogModel } from '~/api/client';
import { DEMO_MODEL_ID, splitModelId } from '~/lib/models';

/**
 * The model and thinking level a person picks for one conversation in the
 * composer (docs/api.md "Model per conversation"). `modelId` "" is the agent's
 * own model; `thinking` "" is the model's default, which is off.
 */
export interface ModelChoice {
  modelId: string;
  thinking: string;
}

export const NO_CHOICE: ModelChoice = { modelId: '', thinking: '' };

/** The thinking levels offered, in order. Off is "": the model's default. */
export const THINKING_OPTIONS = [
  { value: '', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const;

/** "off" and "" both mean the model's default. */
export const normalizeThinking = (thinking: string | null | undefined): string =>
  !thinking || thinking === 'off' ? '' : thinking;

/** A conversation's choice as the thread list carries it. */
export function choiceOf(
  thread: { modelId?: string | null; thinking?: string | null } | undefined,
): ModelChoice {
  return { modelId: thread?.modelId ?? '', thinking: normalizeThinking(thread?.thinking) };
}

/** The catalog models a person may choose: enabled ones, never the demo model. */
export function pickableModels(models: readonly CatalogModel[] | undefined): CatalogModel[] {
  return (models ?? []).filter(
    (model) =>
      model.enabled !== false &&
      model.id !== DEMO_MODEL_ID &&
      (model.provider ?? splitModelId(model.id)?.provider) !== 'demo',
  );
}

/**
 * The model that answers with this choice: the one chosen, or the agent's own.
 * Undefined when it isn't known (a new chat with Auto has no agent yet).
 */
export function effectiveModel(
  models: readonly CatalogModel[] | undefined,
  agentModel: Pick<NonNullable<Agent['model']>, 'id'> | null | undefined,
  modelId: string,
): CatalogModel | undefined {
  const id = modelId || agentModel?.id;
  return id ? models?.find((model) => model.id === id) : undefined;
}

/** What differs from the conversation's own: only these go with the message. */
export function changesTo(baseline: ModelChoice, choice: ModelChoice): Partial<ModelChoice> {
  return {
    ...(choice.modelId !== baseline.modelId ? { modelId: choice.modelId } : {}),
    ...(choice.thinking !== baseline.thinking ? { thinking: choice.thinking } : {}),
  };
}

/** "Strong · high": the button's text. Off isn't said: it is the default. */
export function choiceLabel(name: string, thinking: string, reasoning: boolean): string {
  return reasoning && thinking ? `${name} · ${thinking}` : name;
}
