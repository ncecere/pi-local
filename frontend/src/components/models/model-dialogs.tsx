import { RefreshCw } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { type DiscoveredModel, errorMessage, type Model, type Provider } from '~/api/client';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { useDiscoverModels, usePutModel } from '~/hooks/use-providers';
import {
  filterDiscovered,
  formatTokens,
  modelIdProblem,
  parsePrice,
  parseTokens,
} from '~/lib/models';
import { cn, plural } from '~/lib/utils';
import { ErrorNotice, FIELD, Field, Optional, RequestError } from './fields';

const CHECKBOX = 'size-4 accent-[var(--accent)]';

/**
 * Adding a model by its ID, or changing one: its name, limits, what it can
 * do, and its prices (for the usage page's cost estimate).
 */
export function ModelDialog({
  provider,
  model,
  onClose,
}: {
  provider: Provider;
  /** Null: a new model, by ID. */
  model: Model | null;
  onClose: () => void;
}) {
  const put = usePutModel();
  const id = useId();
  const [modelId, setModelId] = useState(model?.modelId ?? '');
  const [name, setName] = useState(model?.name ?? '');
  const [contextWindow, setContextWindow] = useState(String(model?.contextWindow ?? 128000));
  const [maxTokens, setMaxTokens] = useState(String(model?.maxTokens ?? 16000));
  const [reasoning, setReasoning] = useState(model?.reasoning ?? false);
  const [images, setImages] = useState(model?.images ?? false);
  const [inputPrice, setInputPrice] = useState(model?.inputPrice?.toString() ?? '');
  const [outputPrice, setOutputPrice] = useState(model?.outputPrice?.toString() ?? '');
  const [enabled, setEnabled] = useState(model?.enabled ?? true);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const id = modelId.trim();
    const idProblem = model ? null : modelIdProblem(id);
    if (idProblem) return setProblem(idProblem);
    if (!model && provider.models.some((existing) => existing.modelId === id))
      return setProblem(`${id} is already one of ${provider.name}'s models. Edit it instead.`);
    const context = parseTokens(contextWindow);
    const output = parseTokens(maxTokens);
    const input$ = parsePrice(inputPrice);
    const output$ = parsePrice(outputPrice);
    if (context === undefined) return setProblem('The context window must be a number of tokens.');
    if (output === undefined) return setProblem('The output limit must be a number of tokens.');
    if (input$ === undefined || output$ === undefined)
      return setProblem('A price must be a number of dollars, or empty.');
    setProblem(null);
    put.mutate(
      {
        provider: provider.id,
        modelId: model?.modelId ?? id,
        name: name.trim() || id,
        contextWindow: context,
        maxTokens: output,
        reasoning,
        images,
        inputPrice: input$,
        outputPrice: output$,
        enabled,
      },
      {
        onSuccess: (saved) => {
          toast(model ? `${saved.name} saved.` : `${saved.name} added.`);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {model ? `Edit ${model.name}` : `Add a model to ${provider.name}`}
          </DialogTitle>
          <DialogDescription>
            {model ? (
              <>
                <span className="font-mono text-xs">{model.modelId}</span>
                {model.usedBy > 0 &&
                  ` · used by ${plural(model.usedBy, 'agent')}, which restart when you save`}
              </>
            ) : (
              'By the ID its provider knows it by.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {!model && (
            <Field id={`${id}-model-id`} label="Model ID">
              <input
                id={`${id}-model-id`}
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                placeholder="gpt-4.1 or anthropic/claude-sonnet-4"
                spellCheck={false}
                autoComplete="off"
                className={cn(FIELD, 'font-mono text-xs')}
              />
            </Field>
          )}
          <Field
            id={`${id}-name`}
            label={<>Name {!model && <Optional />}</>}
            hint={model ? undefined : 'What agents and menus call it. Leave empty to use the ID.'}
          >
            <input
              id={`${id}-name`}
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-describedby={model ? undefined : `${id}-name-hint`}
              className={FIELD}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id={`${id}-context`} label="Context window" hint="Tokens, e.g. 128000 or 128k.">
              <input
                id={`${id}-context`}
                inputMode="numeric"
                value={contextWindow}
                onChange={(event) => setContextWindow(event.target.value)}
                aria-describedby={`${id}-context-hint`}
                className={FIELD}
              />
            </Field>
            <Field id={`${id}-max`} label="Output limit" hint="Most tokens in one reply.">
              <input
                id={`${id}-max`}
                inputMode="numeric"
                value={maxTokens}
                onChange={(event) => setMaxTokens(event.target.value)}
                aria-describedby={`${id}-max-hint`}
                className={FIELD}
              />
            </Field>
            <Field
              id={`${id}-in-price`}
              label={
                <>
                  Input price <Optional />
                </>
              }
              hint="US dollars per million tokens."
            >
              <input
                id={`${id}-in-price`}
                inputMode="decimal"
                value={inputPrice}
                onChange={(event) => setInputPrice(event.target.value)}
                placeholder="3.00"
                aria-describedby={`${id}-in-price-hint`}
                className={FIELD}
              />
            </Field>
            <Field
              id={`${id}-out-price`}
              label={
                <>
                  Output price <Optional />
                </>
              }
              hint="US dollars per million tokens."
            >
              <input
                id={`${id}-out-price`}
                inputMode="decimal"
                value={outputPrice}
                onChange={(event) => setOutputPrice(event.target.value)}
                placeholder="15.00"
                aria-describedby={`${id}-out-price-hint`}
                className={FIELD}
              />
            </Field>
          </div>
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1.5 text-sm font-medium">It can</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={reasoning}
                onChange={(event) => setReasoning(event.target.checked)}
                className={CHECKBOX}
              />
              Reason (think before it answers)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={images}
                onChange={(event) => setImages(event.target.checked)}
                className={CHECKBOX}
              />
              Read images
            </label>
            {model && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                  className={CHECKBOX}
                />
                Be used by agents (turned off, agents on it don't start)
              </label>
            )}
          </fieldset>
          {problem && <ErrorNotice>{problem}</ErrorNotice>}
          <RequestError error={put.error} what="This model" />
          <DialogFooter className="mt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={(!model && !modelId.trim()) || put.isPending}
            >
              {put.isPending && <Spinner className="size-4 text-current" />}
              {model ? 'Save' : 'Add model'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Rows drawn at first in a long discovery list, and added by "Show more". */
const DISCOVER_PAGE = 100;

/**
 * "Find models": the provider's own list of its models (often hundreds),
 * searchable, to add several at once.
 */
export function DiscoverDialog({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const discover = useDiscoverModels();
  const put = usePutModel();
  const id = useId();
  const [query, setQuery] = useState('');
  const [hideAdded, setHideAdded] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(DISCOVER_PAGE);
  const [adding, setAdding] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);

  const { mutate } = discover;
  useEffect(() => mutate(provider.id), [mutate, provider.id]);

  const found = discover.data?.models ?? [];
  const matching = filterDiscovered(found, query, hideAdded);
  const shown = matching.slice(0, limit);
  const hidden = matching.length - shown.length;
  const picked = found.filter((model) => chosen.has(model.modelId) && !model.added);

  const toggle = (modelId: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });

  const addPicked = async () => {
    setAdding(true);
    setFailures([]);
    const failed: string[] = [];
    // One at a time: each restarts nothing, but the store is small and local.
    for (const model of picked) {
      try {
        await put.mutateAsync({
          provider: provider.id,
          modelId: model.modelId,
          name: model.name || model.modelId,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        });
      } catch (error) {
        failed.push(`${model.modelId}: ${errorMessage(error)}`);
      }
    }
    setAdding(false);
    const added = picked.length - failed.length;
    if (added > 0) toast(`${plural(added, 'model')} added to ${provider.name}.`);
    if (failed.length === 0) onClose();
    else {
      setFailures(failed);
      setChosen(new Set());
      mutate(provider.id);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>Find {provider.name} models</DialogTitle>
          <DialogDescription>
            The models {provider.name} lists. Choose the ones your agents may use; you can change
            each one's details after.
          </DialogDescription>
        </DialogHeader>
        {discover.isPending ? (
          <div
            role="status"
            className="flex items-center gap-2 py-8 text-sm text-[var(--text-muted)]"
          >
            <Spinner />
            Asking {provider.name} for its models…
          </div>
        ) : discover.isError ? (
          <div className="flex flex-col items-start gap-3">
            <ErrorNotice>
              <p className="font-medium">Couldn't list {provider.name}'s models.</p>
              <p className="mt-0.5">{errorMessage(discover.error)}</p>
            </ErrorNotice>
            <Button type="button" variant="secondary" size="sm" onClick={() => mutate(provider.id)}>
              <RefreshCw />
              Try again
            </Button>
          </div>
        ) : found.length === 0 ? (
          <p className="py-6 text-sm text-[var(--text-muted)]">
            {provider.name} listed no models. You can still add one by its ID.
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(DISCOVER_PAGE);
                }}
                placeholder={`Search ${plural(found.length, 'model')}`}
                aria-label="Search models"
                aria-controls={`${id}-list`}
                className={cn(FIELD, 'max-w-xs flex-1')}
              />
              <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={hideAdded}
                  onChange={(event) => setHideAdded(event.target.checked)}
                  className={CHECKBOX}
                />
                Hide added
              </label>
            </div>
            <p aria-live="polite" className="text-xs text-[var(--text-muted)]">
              {query || hideAdded
                ? `${matching.length.toLocaleString('en-US')} ${matching.length === 1 ? 'match' : 'matches'}`
                : plural(found.length, 'model')}
              {picked.length > 0 && ` · ${picked.length} chosen`}
            </p>
            <ul
              id={`${id}-list`}
              aria-label={`${provider.name} models`}
              className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto rounded-xl border border-[var(--border-subtle)]"
            >
              {shown.map((model) => (
                <DiscoveredRow
                  key={model.modelId}
                  model={model}
                  checked={model.added || chosen.has(model.modelId)}
                  onToggle={() => toggle(model.modelId)}
                />
              ))}
              {shown.length === 0 && (
                <li className="px-4 py-3 text-sm text-[var(--text-muted)]">No models match.</li>
              )}
              {hidden > 0 && (
                <li className="px-4 py-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setLimit((current) => current + DISCOVER_PAGE)}
                  >
                    Show {Math.min(hidden, DISCOVER_PAGE)} more
                    <span className="text-[var(--text-muted)]">· {hidden} not shown</span>
                  </Button>
                </li>
              )}
            </ul>
          </div>
        )}
        {failures.length > 0 && (
          <ErrorNotice>
            <p className="font-medium">Some models weren't added:</p>
            <ul className="mt-1 list-disc pl-5">
              {failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          </ErrorNotice>
        )}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {picked.length > 0 ? 'Cancel' : 'Close'}
          </Button>
          {found.length > 0 && (
            <Button
              type="button"
              variant="primary"
              disabled={picked.length === 0 || adding}
              onClick={() => void addPicked()}
            >
              {adding && <Spinner className="size-4 text-current" />}
              {picked.length > 1 ? `Add ${picked.length} models` : 'Add model'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DiscoveredRow({
  model,
  checked,
  onToggle,
}: {
  model: DiscoveredModel;
  checked: boolean;
  onToggle: () => void;
}) {
  const named = model.name && model.name !== model.modelId;
  return (
    <li>
      <label
        className={cn(
          'flex items-center gap-3 px-4 py-2 text-sm',
          model.added ? 'cursor-default' : 'cursor-pointer hover:bg-[var(--bg-control)]',
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={model.added}
          onChange={onToggle}
          className={CHECKBOX}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{named ? model.name : model.modelId}</span>
          {named && (
            <span className="block truncate font-mono text-xs text-[var(--text-muted)]">
              {model.modelId}
            </span>
          )}
        </span>
        {model.contextWindow ? (
          <span className="shrink-0 text-xs text-[var(--text-muted)] tabular-nums">
            {formatTokens(model.contextWindow)} context
          </span>
        ) : null}
        {model.added && (
          <span className="shrink-0 rounded-md bg-[var(--bg-control)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">
            Added
          </span>
        )}
      </label>
    </li>
  );
}
