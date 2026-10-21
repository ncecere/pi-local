import { ArrowLeft, ChevronRight, KeyRound, Trash2 } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { toast } from 'sonner';
import type { Provider, ProviderKind, ProviderKindId, ProviderPreset } from '~/api/client';
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
import { Switch } from '~/components/ui/switch';
import { useCreateProvider, useDeleteProvider, useUpdateProvider } from '~/hooks/use-providers';
import { type HeaderRow, headersFromRows } from '~/lib/models';
import {
  ConfirmDialog,
  ErrorNotice,
  FIELD,
  Field,
  HeadersEditor,
  Optional,
  RequestError,
} from './fields';

const isKind = (kinds: readonly ProviderKind[], id: string): id is ProviderKindId =>
  kinds.some((kind) => kind.id === id);

function KindSelect({
  id,
  kinds,
  value,
  onChange,
}: {
  id: string;
  kinds: ProviderKind[];
  value: string;
  onChange: (kind: ProviderKindId) => void;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => isKind(kinds, event.target.value) && onChange(event.target.value)}
      aria-describedby={`${id}-hint`}
      className={FIELD}
    >
      {kinds.map((kind) => (
        <option key={kind.id} value={kind.id}>
          {kind.name}
        </option>
      ))}
    </select>
  );
}

/** Step one of adding a provider: what it is. */
function PresetPicker({
  presets,
  onPick,
}: {
  presets: ProviderPreset[];
  onPick: (preset: ProviderPreset) => void;
}) {
  return (
    <ul className="flex flex-col gap-2" aria-label="Kinds of provider">
      {presets.map((preset) => (
        <li key={preset.id}>
          <button
            type="button"
            onClick={() => onPick(preset)}
            className="flex w-full items-center gap-3 rounded-lg border border-[var(--border-subtle)] px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--bg-control)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-bright)]"
          >
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{preset.name}</span>
              {preset.note && (
                <span className="block text-xs text-[var(--text-muted)]">{preset.note}</span>
              )}
            </span>
            <ChevronRight className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The preset for any OpenAI-compatible server ("OpenAI-compatible"): it names no service. */
const GENERIC_PRESET = 'other';

/**
 * Adding a provider: pick a preset (which fills in its kind, address and
 * name), then name it, and give it a key and any extra headers.
 */
export function AddProviderDialog({
  kinds,
  presets,
  onClose,
  onCreated,
}: {
  kinds: ProviderKind[];
  presets: ProviderPreset[];
  onClose: () => void;
  onCreated: (provider: Provider) => void;
}) {
  const create = useCreateProvider();
  const id = useId();
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProviderKindId>(kinds[0]?.id ?? 'openai-compatible');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = (next: ProviderPreset) => {
    setPreset(next);
    // The generic preset names no service: the person names their server.
    setName(next.id === GENERIC_PRESET ? '' : next.name);
    if (isKind(kinds, next.kind)) setKind(next.kind);
    setBaseUrl(next.baseUrl);
    setProblem(null);
    create.reset();
  };

  const needsKey = preset?.needsKey ?? false;
  const defaultBaseUrl = kinds.find((candidate) => candidate.id === kind)?.defaultBaseUrl;
  const dirty = Boolean(preset) && (apiKey !== '' || headerRows.length > 0);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const headers = headersFromRows(headerRows);
    if (headers.error !== undefined) return setProblem(headers.error);
    setProblem(null);
    create.mutate(
      {
        name: name.trim(),
        kind,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(Object.keys(headers.headers).length > 0 ? { headers: headers.headers } : {}),
      },
      {
        onSuccess: (provider) => {
          toast(`${provider.name} added.`);
          onCreated(provider);
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto" confirmDiscard={dirty}>
        <DialogHeader>
          <DialogTitle>
            {preset && preset.id !== GENERIC_PRESET ? `Add ${preset.name}` : 'Add a provider'}
          </DialogTitle>
          <DialogDescription>
            {preset
              ? 'Its key and header values are kept in the system keychain, never shown again.'
              : 'Where your models come from: a model service, or a server on this computer or your network.'}
          </DialogDescription>
        </DialogHeader>
        {!preset ? (
          <>
            <PresetPicker presets={presets} onPick={pick} />
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field id={`${id}-name`} label="Name">
              <input
                id={`${id}-name`}
                maxLength={60}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={preset.id === GENERIC_PRESET ? 'My server' : undefined}
                className={FIELD}
              />
            </Field>
            <Field
              id={`${id}-kind`}
              label="API"
              hint="How Pi Local talks to it. The preset's choice is usually right."
            >
              <KindSelect id={`${id}-kind`} kinds={kinds} value={kind} onChange={setKind} />
            </Field>
            <Field
              id={`${id}-url`}
              label={<>Base URL {defaultBaseUrl && <Optional />}</>}
              hint={defaultBaseUrl ? `Leave empty for ${defaultBaseUrl}.` : undefined}
            >
              <input
                id={`${id}-url`}
                type="url"
                inputMode="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={defaultBaseUrl ?? 'http://localhost:8000/v1'}
                spellCheck={false}
                aria-describedby={defaultBaseUrl ? `${id}-url-hint` : undefined}
                className={FIELD}
              />
            </Field>
            <Field
              id={`${id}-key`}
              label={<>API key {!needsKey && <Optional />}</>}
              hint={
                needsKey
                  ? undefined
                  : 'Usually not needed for a server on this computer. Add one if yours asks for it.'
              }
            >
              <input
                id={`${id}-key`}
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="new-password"
                required={needsKey}
                aria-describedby={needsKey ? undefined : `${id}-key-hint`}
                className={FIELD}
              />
            </Field>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-1.5 text-sm font-medium">
                Extra headers <Optional />
              </legend>
              <HeadersEditor rows={headerRows} onChange={setHeaderRows} />
            </fieldset>
            {problem && <ErrorNotice>{problem}</ErrorNotice>}
            <RequestError error={create.error} what="This provider" />
            <DialogFooter className="mt-2 justify-between">
              <Button type="button" variant="ghost" onClick={() => setPreset(null)}>
                <ArrowLeft />
                Back
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!name.trim() || (needsKey && !apiKey.trim()) || create.isPending}
                >
                  {create.isPending && <Spinner className="size-4 text-current" />}
                  Add provider
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Changing a provider: its name and address, replacing or removing its key,
 * replacing its headers (their values are never shown), turning it off, or
 * deleting it.
 */
export function EditProviderDialog({
  provider,
  kinds,
  onClose,
}: {
  provider: Provider;
  kinds: ProviderKind[];
  onClose: () => void;
}) {
  const update = useUpdateProvider();
  const remove = useDeleteProvider();
  const id = useId();
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [enabled, setEnabled] = useState(provider.enabled);
  const [headerRows, setHeaderRows] = useState<HeaderRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const kindName = kinds.find((kind) => kind.id === provider.kind)?.name ?? provider.kind;
  const dirty =
    name !== provider.name ||
    baseUrl !== provider.baseUrl ||
    apiKey !== '' ||
    removeKey ||
    enabled !== provider.enabled ||
    headerRows !== null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    let headers: Record<string, string> | undefined;
    if (headerRows) {
      const parsed = headersFromRows(headerRows);
      if (parsed.error !== undefined) return setProblem(parsed.error);
      headers = parsed.headers;
    }
    setProblem(null);
    update.mutate(
      {
        id: provider.id,
        ...(name.trim() !== provider.name ? { name: name.trim() } : {}),
        ...(baseUrl.trim() !== provider.baseUrl ? { baseUrl: baseUrl.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : removeKey ? { apiKey: '' } : {}),
        ...(headers ? { headers } : {}),
        ...(enabled !== provider.enabled ? { enabled } : {}),
      },
      {
        onSuccess: (saved) => {
          toast(`${saved.name} saved.`);
          onClose();
        },
      },
    );
  };

  if (deleting)
    return (
      <ConfirmDialog
        title={`Delete ${provider.name}?`}
        description={`Its ${provider.models.length === 1 ? 'model' : `${provider.models.length} models`}, key and headers are removed from Pi Local. Agents must not be using any of its models.`}
        action="Delete provider"
        what={provider.name}
        onConfirm={async () => {
          await remove.mutateAsync(provider.id);
          toast(`${provider.name} deleted.`);
          onClose();
        }}
        onClose={() => setDeleting(false)}
      />
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto" confirmDiscard={dirty}>
        <DialogHeader>
          <DialogTitle>Edit {provider.name}</DialogTitle>
          <DialogDescription>
            {kindName} · <span className="font-mono text-xs">{provider.id}</span>. Agents using its
            models restart when you save.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field id={`${id}-name`} label="Name">
            <input
              id={`${id}-name`}
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={FIELD}
            />
          </Field>
          <Field id={`${id}-url`} label="Base URL">
            <input
              id={`${id}-url`}
              type="url"
              inputMode="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              spellCheck={false}
              className={FIELD}
            />
          </Field>
          <Field
            id={`${id}-key`}
            label={provider.hasKey ? 'Replace API key' : 'API key'}
            hint={
              removeKey ? (
                <>
                  The stored key is removed when you save.{' '}
                  <button
                    type="button"
                    className="text-[var(--accent-bright)] underline-offset-4 hover:underline"
                    onClick={() => setRemoveKey(false)}
                  >
                    Keep it
                  </button>
                </>
              ) : provider.hasKey ? (
                'A key is stored. Leave this empty to keep it.'
              ) : (
                'No key is stored.'
              )
            }
          >
            <div className="flex items-center gap-2">
              <input
                id={`${id}-key`}
                type="password"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  if (event.target.value) setRemoveKey(false);
                }}
                autoComplete="new-password"
                placeholder={provider.hasKey && !removeKey ? '••••••••' : ''}
                aria-describedby={`${id}-key-hint`}
                className={FIELD}
              />
              {provider.hasKey && !removeKey && (
                <Button
                  type="button"
                  variant="secondary"
                  className="h-10 shrink-0"
                  onClick={() => {
                    setApiKey('');
                    setRemoveKey(true);
                  }}
                >
                  <KeyRound />
                  Remove key
                </Button>
              )}
            </div>
          </Field>
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1.5 text-sm font-medium">Extra headers</legend>
            {headerRows ? (
              <>
                <p className="text-xs text-[var(--text-muted)]">
                  These replace all its headers when you save. Enter each value again; remove every
                  row to send none.
                </p>
                <HeadersEditor rows={headerRows} onChange={setHeaderRows} />
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setHeaderRows(null)}
                  >
                    Keep the current headers
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {provider.headerNames.length === 0 ? (
                  <span className="text-sm text-[var(--text-muted)]">None.</span>
                ) : (
                  <ul className="flex flex-wrap gap-1.5" aria-label="Current headers">
                    {provider.headerNames.map((header) => (
                      <li
                        key={header}
                        className="rounded-md bg-[var(--bg-control)] px-2 py-0.5 font-mono text-xs"
                      >
                        {header}
                      </li>
                    ))}
                  </ul>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setHeaderRows(
                      provider.headerNames.length > 0
                        ? provider.headerNames.map((header) => ({ name: header, value: '' }))
                        : [{ name: '', value: '' }],
                    )
                  }
                >
                  {provider.headerNames.length > 0 ? 'Replace headers' : 'Add headers'}
                </Button>
              </div>
            )}
          </fieldset>
          <div className="flex items-center justify-between gap-4">
            <span>
              <span id={`${id}-enabled-label`} className="block text-sm font-medium">
                Use this provider
              </span>
              <span id={`${id}-enabled-hint`} className="block text-xs text-[var(--text-muted)]">
                Turned off, its models are not offered, and agents on them don't start.
              </span>
            </span>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-labelledby={`${id}-enabled-label`}
              aria-describedby={`${id}-enabled-hint`}
            />
          </div>
          {problem && <ErrorNotice>{problem}</ErrorNotice>}
          <RequestError error={update.error} what={provider.name} />
          <DialogFooter className="mt-2 justify-between">
            <Button type="button" variant="ghost" onClick={() => setDeleting(true)}>
              <Trash2 />
              Delete
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={!name.trim() || !baseUrl.trim() || update.isPending}
              >
                {update.isPending && <Spinner className="size-4 text-current" />}
                Save
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
