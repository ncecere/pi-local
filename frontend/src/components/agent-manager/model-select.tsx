import type { Agent } from '~/api/client';
import { FIELD } from '~/components/models/fields';
import type { AgentCatalog } from '~/hooks/use-agents';
import { useUnpricedModels } from '~/hooks/use-providers';
import { groupModelsByProvider } from '~/lib/models';
import { cn } from '~/lib/utils';

/**
 * The model picker: the catalog's models grouped by provider. An agent whose
 * model was removed or turned off keeps it, shown as no longer available.
 */
export function ModelSelect({
  id,
  catalog,
  current,
  value,
  onChange,
  describedBy,
  disabled,
}: {
  id: string;
  catalog: AgentCatalog;
  /** The agent's model now. */
  current: Agent['model'];
  value: string;
  onChange: (modelId: string) => void;
  describedBy?: string;
  disabled?: boolean;
}) {
  const unpriced = useUnpricedModels();
  const missing =
    current && !catalog.models.some((model) => model.id === current.id) ? current : null;
  const groups = groupModelsByProvider(catalog.models);
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      aria-describedby={describedBy}
      className={cn(FIELD, 'max-w-md')}
    >
      {!value && <option value="">The default model</option>}
      {missing && (
        <option value={missing.id} disabled>
          {missing.name} (no longer available)
        </option>
      )}
      {groups.map((group) => (
        <optgroup key={group.key} label={group.label}>
          {group.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
              {unpriced.has(model.id) ? ' · cost not counted' : ''}
              {model.id === catalog.defaultModelId ? ' (default)' : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Whether the agent's model is gone from the catalog (it can't start until given another). */
export function modelMissing(agent: Pick<Agent, 'model'>, catalog: AgentCatalog): boolean {
  return Boolean(agent.model && !catalog.models.some((model) => model.id === agent.model?.id));
}
