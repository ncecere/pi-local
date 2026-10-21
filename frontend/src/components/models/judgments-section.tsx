import { Download, RefreshCw } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, type JudgmentsInfo } from '~/api/client';
import { ErrorNotice, FIELD, RequestError } from '~/components/models/fields';
import { SettingsSection } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import {
  type JudgmentsInput,
  useJudgmentModels,
  useJudgments,
  useSaveJudgments,
  useTestJudgments,
} from '~/hooks/use-judgments';
import { cn } from '~/lib/utils';

/** What each use does; the ones without `ready` aren't built yet. */
const USE_TEXT: Record<string, { label: string; hint: string; ready?: true }> = {
  agentRouting: {
    label: 'Agent routing',
    hint: "Pick the right agent when you don't choose one.",
    ready: true,
  },
  toolPreselection: {
    label: 'Tool preselection',
    hint: 'Load the likely tools before an agent with many tools answers.',
    ready: true,
  },
  inbox: { label: 'Inbox', hint: 'Coming later.' },
  approvals: { label: 'Approvals', hint: 'Coming later.' },
  memory: { label: 'Memory', hint: 'Coming later.' },
  knowledge: { label: 'Knowledge', hint: 'Coming later.' },
  triggers: { label: 'Triggers', hint: 'Coming later.' },
};

const textOfUse = (use: string) =>
  USE_TEXT[use] ?? { label: use.replace(/([A-Z])/g, ' $1').toLowerCase(), hint: 'Coming later.' };

/**
 * Settings → Models → Fast judgments: the optional System One service
 * (TypeSafe Jev, or a self-hosted one) that makes quick decisions for the
 * app, its key, model and confidence threshold, and what it is used for.
 */
export function JudgmentsSection() {
  const info = useJudgments();
  return (
    <SettingsSection title="Fast judgments">
      <p className="-mt-2 text-sm text-[var(--text-muted)]">
        Optional. Quick decisions by a System One model (TypeSafe Jev). The text being judged is
        sent to the service below. The key is kept in the system keychain.
      </p>
      {info.isError ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorNotice>
            Fast judgments settings could not be read: {errorMessage(info.error)}
          </ErrorNotice>
          <Button type="button" variant="secondary" onClick={() => void info.refetch()}>
            <RefreshCw />
            Try again
          </Button>
        </div>
      ) : !info.data ? (
        <Spinner />
      ) : (
        <JudgmentsForm key={JSON.stringify(info.data.settings)} info={info.data} />
      )}
    </SettingsSection>
  );
}

function JudgmentsForm({ info }: { info: JudgmentsInfo }) {
  const id = useId();
  const { settings: saved } = info;
  const save = useSaveJudgments();
  const test = useTestJudgments();
  const models = useJudgmentModels();
  const [enabled, setEnabled] = useState(saved.enabled);
  const [url, setUrl] = useState(saved.url);
  const [model, setModel] = useState(saved.model);
  const [apiKey, setApiKey] = useState('');
  const [threshold, setThreshold] = useState(saved.threshold);
  const [uses, setUses] = useState<Record<string, boolean>>(saved.uses);

  const changedUses = info.uses.filter((use) => Boolean(uses[use]) !== Boolean(saved.uses[use]));
  const dirty =
    enabled !== saved.enabled ||
    url.trim() !== saved.url ||
    model.trim() !== saved.model ||
    apiKey.trim() !== '' ||
    threshold !== saved.threshold ||
    changedUses.length > 0;

  const submit = () => {
    const body: JudgmentsInput = {
      enabled,
      url: url.trim(),
      model: model.trim(),
      threshold,
      uses: Object.fromEntries(info.uses.map((use) => [use, Boolean(uses[use])])),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    };
    test.reset();
    void save.mutateAsync(body).then(
      (settings) => toast(settings.enabled ? 'Fast judgments saved.' : 'Fast judgments are off.'),
      () => undefined,
    );
  };

  const modelChoices = models.data
    ? [...new Set([...(model ? [model] : []), ...models.data])]
    : null;

  return (
    <form
      className="flex flex-col gap-5"
      // The service checks the fields (and a range's steps aren't worth a browser's complaint).
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !save.isPending) submit();
      }}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p id={`${id}-enabled-label`} className="text-sm font-medium">
            Enabled
          </p>
          <p id={`${id}-enabled-hint`} className="mt-0.5 text-xs text-[var(--text-muted)]">
            Off: nothing is sent, and the app decides as it does without it.
          </p>
        </div>
        <Switch
          checked={enabled}
          aria-labelledby={`${id}-enabled-label`}
          aria-describedby={`${id}-enabled-hint`}
          onCheckedChange={(on) => {
            setEnabled(on);
            save.reset();
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-url`} className="text-sm font-medium">
          Service address
        </label>
        <input
          id={`${id}-url`}
          type="url"
          inputMode="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={info.defaultUrl}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-url-hint`}
          className={cn(FIELD, 'max-w-md')}
        />
        <p id={`${id}-url-hint`} className="text-xs text-[var(--text-muted)]">
          TypeSafe's is {info.defaultUrl}. Change it for a self-hosted service.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-key`} className="text-sm font-medium">
          API key
        </label>
        <input
          id={`${id}-key`}
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={saved.hasKey ? '••••••••' : undefined}
          aria-describedby={`${id}-key-hint`}
          className={cn(FIELD, 'max-w-md')}
        />
        <p id={`${id}-key-hint`} className="text-xs text-[var(--text-muted)]">
          {saved.hasKey
            ? 'A key is stored. Leave this empty to keep it.'
            : 'Paste your TypeSafe API key. A self-hosted service may not need one.'}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-model`} className="text-sm font-medium">
          Model
        </label>
        <div className="flex max-w-md items-center gap-2">
          {modelChoices ? (
            <select
              id={`${id}-model`}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              aria-describedby={`${id}-model-hint`}
              className={cn(FIELD, 'flex-1')}
            >
              {modelChoices.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`${id}-model`}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={info.defaultModel}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`${id}-model-hint`}
              className={cn(FIELD, 'flex-1 font-mono text-xs')}
            />
          )}
          <Button
            type="button"
            variant="secondary"
            className="h-10 shrink-0"
            disabled={models.isPending}
            onClick={() => models.mutate()}
          >
            {models.isPending ? <Spinner className="size-4 text-current" /> : <Download />}
            Load models
          </Button>
        </div>
        <p id={`${id}-model-hint`} className="text-xs text-[var(--text-muted)]">
          Pinned, so answers don't change under you. The default is {info.defaultModel}.
        </p>
        {models.error ? (
          <ErrorNotice>{errorMessage(models.error, 'The models could not be loaded.')}</ErrorNotice>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-threshold`} className="text-sm font-medium">
          Confidence threshold
        </label>
        <div className="flex max-w-md items-center gap-3">
          <input
            id={`${id}-threshold`}
            type="range"
            min={0.5}
            max={0.99}
            step={0.01}
            value={threshold}
            onChange={(event) => setThreshold(Number(event.target.value))}
            aria-describedby={`${id}-threshold-hint`}
            className="flex-1 accent-[var(--accent)]"
          />
          <output htmlFor={`${id}-threshold`} className="w-10 text-right text-sm tabular-nums">
            {threshold.toFixed(2)}
          </output>
        </div>
        <p id={`${id}-threshold-hint`} className="text-xs text-[var(--text-muted)]">
          Less sure than this, and the app asks you instead of deciding.
        </p>
      </div>

      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-2 text-sm font-medium">Use it for</legend>
        {info.uses.map((use) => {
          const text = textOfUse(use);
          return (
            <div key={use} className="flex items-start justify-between gap-6">
              <div className="min-w-0">
                <p
                  id={`${id}-use-${use}-label`}
                  className={cn('text-sm', !text.ready && 'text-[var(--text-muted)]')}
                >
                  {text.label}
                </p>
                <p id={`${id}-use-${use}-hint`} className="mt-0.5 text-xs text-[var(--text-muted)]">
                  {text.hint}
                </p>
              </div>
              <Switch
                checked={text.ready ? Boolean(uses[use]) : false}
                disabled={!text.ready}
                aria-labelledby={`${id}-use-${use}-label`}
                aria-describedby={`${id}-use-${use}-hint`}
                onCheckedChange={(on) => setUses({ ...uses, [use]: on })}
              />
            </div>
          );
        })}
      </fieldset>

      <RequestError error={save.error} what="Fast judgments" />

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={!dirty || save.isPending}>
          {save.isPending && <Spinner className="size-4 text-current" />}
          Save
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={dirty || test.isPending}
          aria-describedby={`${id}-test-hint`}
          onClick={() => test.mutate()}
        >
          {test.isPending && <Spinner className="size-4 text-current" />}
          Test
        </Button>
        <span id={`${id}-test-hint`} className="text-xs text-[var(--text-muted)]">
          {dirty
            ? 'Save first, then test.'
            : 'Asks the service one question with the saved settings.'}
        </span>
      </div>

      {test.error ? (
        <ErrorNotice>{errorMessage(test.error, 'The test failed.')}</ErrorNotice>
      ) : test.data ? (
        <p role="status" className="text-sm text-[var(--text-secondary)]">
          It works: {test.data.model || 'the model'} answered.
        </p>
      ) : null}
    </form>
  );
}
