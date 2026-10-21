import { ChevronDown } from 'lucide-react';
import { memo, useMemo } from 'react';
import type { Agent } from '~/api/client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { FOCUS_RING } from '~/components/ui/focus-ring';
import { useAgentCatalog } from '~/hooks/use-agents';
import { useFeature } from '~/hooks/use-session';
import {
  choiceLabel,
  effectiveModel,
  type ModelChoice,
  pickableModels,
  THINKING_OPTIONS,
} from '~/lib/model-choice';
import { groupModelsByProvider } from '~/lib/models';
import { cn } from '~/lib/utils';

/** The menu's value for "the agent's own model" (a radio item needs a non-empty one). */
const AGENT_MODEL = '__agent';
/** Off is the model's default, "" in the API. */
const OFF = 'off';

/**
 * The model and thinking level for this conversation, in the composer: a
 * compact button ("Strong · high") that opens the choices. It is the person's
 * own choice; nothing picks a model for them. Shown only while
 * `features.modelPerConversation` is on. Thinking is offered only for a model
 * that can think.
 */
export const ModelPicker = memo(function ModelPicker({
  value,
  agentModel,
  onModel,
  onThinking,
  disabled = false,
}: {
  value: ModelChoice;
  /** The agent's own model, when the agent is known (not with Auto in a new chat). */
  agentModel?: Agent['model'];
  onModel: (modelId: string, reasoning: boolean) => void;
  onThinking: (thinking: string) => void;
  disabled?: boolean;
}) {
  const on = useFeature('modelPerConversation');
  const catalog = useAgentCatalog(on);
  // The catalog says which models can think (`reasoning`).
  const catalogModels = catalog.data?.models;
  const models = useMemo(() => pickableModels(catalogModels), [catalogModels]);
  // The agent's own model is the first choice ("Agent's model (X)"): not listed again under its provider.
  const agentModelId = agentModel?.id;
  const groups = useMemo(
    () => groupModelsByProvider(models.filter((model) => model.id !== agentModelId)),
    [models, agentModelId],
  );
  if (!on || !catalogModels) return null;

  const chosen = value.modelId ? models.find((model) => model.id === value.modelId) : undefined;
  // A choice whose model can't be used any more: it falls back to the agent's at the next message.
  const gone = value.modelId !== '' && !chosen;
  const effective = gone ? undefined : effectiveModel(catalogModels, agentModel, value.modelId);
  const reasoning = effective?.reasoning === true;
  const name = gone
    ? (agentModel?.name ?? "Agent's model")
    : value.modelId
      ? (chosen?.name ?? value.modelId)
      : (agentModel?.name ?? "Agent's model");
  const label = choiceLabel(name, value.thinking, reasoning);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        title="Model for this conversation"
        aria-label={`Model for this conversation: ${label}`}
        className={cn(
          'inline-flex h-8 min-w-0 max-w-[14rem] items-center gap-1 whitespace-nowrap rounded-lg px-2 text-[0.8125rem] font-medium',
          'text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          FOCUS_RING,
        )}
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        side="top"
        collisionPadding={16}
        className="w-64 max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto"
      >
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={
            gone || !value.modelId || value.modelId === agentModelId ? AGENT_MODEL : value.modelId
          }
          onValueChange={(next) => {
            const id = next === AGENT_MODEL ? '' : next;
            const model = id
              ? models.find((candidate) => candidate.id === id)
              : effectiveModel(catalogModels, agentModel, '');
            onModel(id, model?.reasoning === true);
          }}
        >
          <DropdownMenuRadioItem value={AGENT_MODEL}>
            <span className="min-w-0 flex-1 truncate">
              {agentModel ? `Agent's model (${agentModel.name})` : "Agent's model"}
            </span>
          </DropdownMenuRadioItem>
          {groups.map((group) => (
            <DropdownMenuGroup key={group.key} aria-label={group.label}>
              <DropdownMenuLabel className="pt-2.5">{group.label}</DropdownMenuLabel>
              {group.models.map((model) => (
                <DropdownMenuRadioItem key={model.id} value={model.id}>
                  <span className="min-w-0 flex-1 truncate">{model.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuRadioGroup>

        {reasoning && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Thinking</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={value.thinking || OFF}
              onValueChange={(next) => onThinking(next === OFF ? '' : next)}
            >
              {THINKING_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.label} value={option.value || OFF}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
