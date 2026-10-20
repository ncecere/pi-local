import { ChevronRight, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, type Model, type Provider, type ProviderKind } from '~/api/client';
import { ConfirmDialog, ErrorNotice } from '~/components/models/fields';
import { DiscoverDialog, ModelDialog } from '~/components/models/model-dialogs';
import { AddProviderDialog, EditProviderDialog } from '~/components/models/provider-dialogs';
import { SettingsRow, SettingsSection } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { type AgentCatalog, useAgentCatalog } from '~/hooks/use-agents';
import {
  useDeleteModel,
  useProviders,
  usePutModel,
  useSetDefaultModel,
  useUpdateProvider,
} from '~/hooks/use-providers';
import { usePageTitle } from '~/lib/document-title';
import { formatPrice, formatTokens, groupModelsByProvider, kindName } from '~/lib/models';
import { cn, plural } from '~/lib/utils';

/** The model new agents get, from every model agents may use (and the demo model). */
function DefaultModel({
  catalog,
  defaultModelId,
}: {
  catalog: AgentCatalog;
  defaultModelId: string | null;
}) {
  const id = useId();
  const setDefault = useSetDefaultModel();
  const value = defaultModelId ?? '';
  const known = catalog.models.some((model) => model.id === value);
  return (
    <SettingsRow
      id={id}
      label="Default model"
      description="The model new agents start with. Each agent's own model is in Settings → Agents."
    >
      <div className="flex items-center gap-2">
        {setDefault.isPending && <Spinner />}
        <select
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-description`}
          value={value}
          disabled={setDefault.isPending}
          onChange={(event) =>
            setDefault.mutate(event.target.value, {
              onSuccess: () => toast('Default model changed.'),
              onError: (error) => toast.error(errorMessage(error, 'Not changed.')),
            })
          }
          className="h-10 w-full min-w-56 max-w-xs rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)]/60 px-3 text-sm"
        >
          {!known && (
            <option value={value} disabled>
              {value ? `${value} (not available)` : 'Choose a model'}
            </option>
          )}
          {groupModelsByProvider(catalog.models).map((group) => (
            <optgroup key={group.key} label={group.label}>
              {group.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    </SettingsRow>
  );
}

function modelFacts(model: Model): string {
  const facts = [
    `${formatTokens(model.contextWindow)} context`,
    `${formatTokens(model.maxTokens)} out`,
  ];
  if (model.reasoning) facts.push('reasoning');
  if (model.images) facts.push('images');
  if (model.inputPrice !== null || model.outputPrice !== null)
    facts.push(`${formatPrice(model.inputPrice)} in / ${formatPrice(model.outputPrice)} out per M`);
  return facts.join(' · ');
}

function ModelRow({
  provider,
  model,
  onEdit,
  onRemove,
}: {
  provider: Provider;
  model: Model;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const put = usePutModel();
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              'truncate text-sm font-medium',
              !model.enabled && 'text-[var(--text-muted)]',
            )}
          >
            {model.name}
          </span>
          {model.name !== model.modelId && (
            <span className="truncate font-mono text-xs text-[var(--text-muted)]">
              {model.modelId}
            </span>
          )}
        </span>
        <span className="block truncate text-xs text-[var(--text-muted)]">
          {modelFacts(model)}
          {model.usedBy > 0 && ` · used by ${plural(model.usedBy, 'agent')}`}
          {!model.enabled && ' · off'}
        </span>
      </span>
      <Switch
        checked={model.enabled}
        disabled={put.isPending || !provider.enabled}
        aria-label={`Let agents use ${model.name}`}
        onCheckedChange={(enabled) =>
          put.mutate(
            { provider: provider.id, modelId: model.modelId, enabled },
            {
              onSuccess: () => {
                if (!enabled && model.usedBy > 0)
                  toast(
                    `${model.name} is off. ${plural(model.usedBy, 'agent')} on it won't start until given another model.`,
                  );
              },
              onError: (error) => toast.error(errorMessage(error, 'Not changed.')),
            },
          )
        }
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Edit ${model.name}`}
        title="Edit"
        onClick={onEdit}
      >
        <Pencil />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${model.name}`}
        title="Remove"
        onClick={onRemove}
      >
        <Trash2 />
      </Button>
    </li>
  );
}

function ProviderCard({
  provider,
  kinds,
  expanded,
  onToggle,
  onEdit,
  onDiscover,
  onAddModel,
  onEditModel,
  onRemoveModel,
}: {
  provider: Provider;
  kinds: ProviderKind[];
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDiscover: () => void;
  onAddModel: () => void;
  onEditModel: (model: Model) => void;
  onRemoveModel: (model: Model) => void;
}) {
  const id = useId();
  const update = useUpdateProvider();
  const enabledModels = provider.models.filter((model) => model.enabled).length;
  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`${id}-models`}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-bright)]"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'size-4 shrink-0 text-[var(--text-muted)] transition-transform motion-reduce:transition-none',
              expanded && 'rotate-90',
            )}
          />
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block truncate text-sm font-medium',
                !provider.enabled && 'text-[var(--text-muted)]',
              )}
            >
              {provider.name}
              <span className="sr-only">
                , {plural(provider.models.length, 'model')}
                {provider.enabled ? '' : ', off'}
              </span>
            </span>
            <span className="block truncate text-xs text-[var(--text-muted)]">
              {kindName(kinds, provider.kind)} · {provider.baseUrl} ·{' '}
              {provider.hasKey ? 'key stored' : 'no key'}
              {provider.headerNames.length > 0 &&
                ` · ${plural(provider.headerNames.length, 'header')}`}
            </span>
          </span>
          <span aria-hidden className="shrink-0 text-xs text-[var(--text-muted)] tabular-nums">
            {provider.models.length === 0
              ? 'no models'
              : enabledModels === provider.models.length
                ? plural(provider.models.length, 'model')
                : `${enabledModels} of ${provider.models.length} on`}
          </span>
        </button>
        <Switch
          checked={provider.enabled}
          disabled={update.isPending}
          aria-label={`Use ${provider.name}`}
          onCheckedChange={(enabled) =>
            update.mutate(
              { id: provider.id, enabled },
              { onError: (error) => toast.error(errorMessage(error, 'Not changed.')) },
            )
          }
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit ${provider.name}`}
          title="Edit"
          onClick={onEdit}
        >
          <Pencil />
        </Button>
      </div>
      <section
        id={`${id}-models`}
        aria-label={`${provider.name} models`}
        hidden={!expanded}
        className="border-t border-[var(--border-subtle)] bg-[var(--bg-inset)]/40"
      >
        {expanded && (
          <>
            {provider.models.length === 0 ? (
              <p className="px-4 pt-3 text-sm text-[var(--text-muted)]">
                No models yet. Find the ones {provider.name} offers, or add one by its ID.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border-subtle)]">
                {provider.models.map((model) => (
                  <ModelRow
                    key={model.id}
                    provider={provider}
                    model={model}
                    onEdit={() => onEditModel(model)}
                    onRemove={() => onRemoveModel(model)}
                  />
                ))}
              </ul>
            )}
            <div
              className={cn(
                'flex flex-wrap gap-2 px-4 py-3',
                provider.models.length > 0 && 'border-t border-[var(--border-subtle)]',
              )}
            >
              <Button type="button" variant="secondary" size="sm" onClick={onDiscover}>
                <Search />
                Find models
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={onAddModel}>
                <Plus />
                Add model by ID
              </Button>
            </div>
          </>
        )}
      </section>
    </li>
  );
}

type Open =
  | { kind: 'add-provider' }
  | { kind: 'edit-provider'; providerId: string }
  | { kind: 'discover'; providerId: string }
  | { kind: 'model'; providerId: string; modelId: string | null }
  | { kind: 'remove-model'; providerId: string; modelId: string };

/**
 * Settings → Models: the model services (providers) and which of their
 * models agents may use, with each model's limits and prices, and the model
 * new agents get.
 */
export function SettingsModelsPage() {
  usePageTitle('Models · Settings');
  const providers = useProviders();
  const catalog = useAgentCatalog();
  const removeModel = useDeleteModel();
  const [open, setOpen] = useState<Open | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const close = () => setOpen(null);

  if (providers.isError)
    return (
      <SettingsSection title="Models" first>
        <ErrorNotice>Models could not be read: {errorMessage(providers.error)}</ErrorNotice>
        <div>
          <Button type="button" variant="secondary" onClick={() => void providers.refetch()}>
            <RefreshCw />
            Try again
          </Button>
        </div>
      </SettingsSection>
    );
  if (!providers.data || !catalog.data)
    return (
      <div className="py-12">
        <Spinner className="mx-auto" />
      </div>
    );

  const { kinds, presets, providers: list } = providers.data;
  const defaultModelId = providers.data.defaultModelId ?? catalog.data.defaultModelId;
  // The dialogs follow the live data: a provider or model deleted meanwhile closes its dialog.
  const providerOf = (providerId: string) => list.find((provider) => provider.id === providerId);
  const current = open && 'providerId' in open ? providerOf(open.providerId) : undefined;
  const modelOf = (modelId: string | null) =>
    modelId ? current?.models.find((model) => model.modelId === modelId) : undefined;
  const expand = (providerId: string) => setExpanded((before) => new Set(before).add(providerId));

  return (
    <>
      <SettingsSection title="Models" first>
        <DefaultModel catalog={catalog.data} defaultModelId={defaultModelId} />
      </SettingsSection>

      <SettingsSection title="Providers">
        <p className="-mt-2 text-sm text-[var(--text-muted)]">
          The services your agents' models come from: an account at OpenAI or Anthropic, or a model
          server such as Ollama or LM Studio. Keys are kept in the system keychain.
        </p>
        {list.length > 0 ? (
          <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
            {list.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                kinds={kinds}
                expanded={expanded.has(provider.id)}
                onToggle={() =>
                  setExpanded((before) => {
                    const next = new Set(before);
                    if (next.has(provider.id)) next.delete(provider.id);
                    else next.add(provider.id);
                    return next;
                  })
                }
                onEdit={() => setOpen({ kind: 'edit-provider', providerId: provider.id })}
                onDiscover={() => setOpen({ kind: 'discover', providerId: provider.id })}
                onAddModel={() =>
                  setOpen({ kind: 'model', providerId: provider.id, modelId: null })
                }
                onEditModel={(model) =>
                  setOpen({ kind: 'model', providerId: provider.id, modelId: model.modelId })
                }
                onRemoveModel={(model) =>
                  setOpen({ kind: 'remove-model', providerId: provider.id, modelId: model.modelId })
                }
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">
            None yet. Until you add one, agents use the demo model, which only echoes.
          </p>
        )}
        <div>
          <Button
            type="button"
            variant="primary"
            disabled={presets.length === 0}
            onClick={() => setOpen({ kind: 'add-provider' })}
          >
            <Plus />
            Add provider
          </Button>
        </div>
      </SettingsSection>

      {open?.kind === 'add-provider' && (
        <AddProviderDialog
          kinds={kinds}
          presets={presets}
          onClose={close}
          onCreated={(provider) => {
            expand(provider.id);
            // Straight on to its models.
            setOpen({ kind: 'discover', providerId: provider.id });
          }}
        />
      )}
      {open?.kind === 'edit-provider' && current && (
        <EditProviderDialog provider={current} kinds={kinds} onClose={close} />
      )}
      {open?.kind === 'discover' && current && (
        <DiscoverDialog provider={current} onClose={close} />
      )}
      {open?.kind === 'model' && current && (open.modelId === null || modelOf(open.modelId)) && (
        <ModelDialog provider={current} model={modelOf(open.modelId) ?? null} onClose={close} />
      )}
      {open?.kind === 'remove-model' &&
        current &&
        (() => {
          const model = modelOf(open.modelId);
          if (!model) return null;
          return (
            <ConfirmDialog
              title={`Remove ${model.name}?`}
              description={
                model.usedBy > 0
                  ? `${plural(model.usedBy, 'agent')} use it. Give them another model first.`
                  : `Agents can no longer choose it. You can add it again later.`
              }
              action="Remove"
              what={model.name}
              onConfirm={async () => {
                await removeModel.mutateAsync({ provider: current.id, modelId: model.modelId });
                toast(`${model.name} removed.`);
              }}
              onClose={close}
            />
          );
        })()}
    </>
  );
}
