import { ChevronRight, RefreshCw } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, type WebSettings } from '~/api/client';
import { ErrorNotice, FIELD, RequestError } from '~/components/models/fields';
import { ExternalAnchor } from '~/components/onboarding/get-started';
import { SettingsSection } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import {
  useSaveWebSettings,
  useTestWebSearch,
  useWebSettings,
  type WebSettingsInput,
} from '~/hooks/use-web';
import { cn } from '~/lib/utils';

type Choice = WebSettings['provider'];

/**
 * Settings → Models → Web search: the search service agents' "Search the web"
 * uses (Brave suggested), its key and address, and a test search.
 */
export function WebSearchSection() {
  const settings = useWebSettings();
  const save = useSaveWebSettings();
  const test = useTestWebSearch();
  return (
    <SettingsSection title="Web search">
      <p className="-mt-2 text-sm text-[var(--text-muted)]">
        The service agents search the web with. Each agent's Tools tab says whether it may search.
        The key is kept in the system keychain.
      </p>
      {settings.isError ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorNotice>
            Web search settings could not be read: {errorMessage(settings.error)}
          </ErrorNotice>
          <Button type="button" variant="secondary" onClick={() => void settings.refetch()}>
            <RefreshCw />
            Try again
          </Button>
        </div>
      ) : !settings.data ? (
        <Spinner />
      ) : (
        <WebSearchForm
          // A save starts the form again from what was saved.
          key={`${settings.data.provider}|${settings.data.url}|${settings.data.hasKey}`}
          saved={settings.data}
          save={save}
          test={test}
        />
      )}
    </SettingsSection>
  );
}

function WebSearchForm({
  saved,
  save,
  test,
}: {
  saved: WebSettings;
  save: ReturnType<typeof useSaveWebSettings>;
  test: ReturnType<typeof useTestWebSearch>;
}) {
  const id = useId();
  const [choice, setChoice] = useState<Choice>(saved.provider);
  const [apiKey, setApiKey] = useState('');
  const [url, setUrl] = useState(saved.url);
  const [customOpen, setCustomOpen] = useState(saved.url !== '');
  const provider = saved.providers.find((candidate) => candidate.id === choice);
  // One key is stored, for the service chosen when it was saved.
  const keyStored = saved.hasKey && choice === saved.provider;

  const dirty =
    choice !== saved.provider ||
    (choice !== '' && (url.trim() !== saved.url || apiKey.trim() !== ''));
  const missingKey = Boolean(provider?.needsKey) && !apiKey.trim() && !keyStored;
  const missingUrl = Boolean(provider?.needsUrl) && !url.trim();

  const submit = () => {
    const body: WebSettingsInput =
      choice === ''
        ? { provider: '' }
        : {
            provider: choice,
            url: url.trim(),
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          };
    test.reset();
    void save.mutateAsync(body).then(
      () => toast(choice === '' ? 'Web search is off.' : 'Web search saved.'),
      () => undefined,
    );
  };

  const options: { id: Choice; label: string }[] = [
    ...saved.providers.map((candidate) => ({ id: candidate.id, label: candidate.name })),
    { id: '', label: 'Off' },
  ];

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !missingKey && !missingUrl && !save.isPending) submit();
      }}
    >
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 text-sm font-medium">Search service</legend>
        <div className="flex flex-wrap items-center gap-1.5">
          {options.map((option) => (
            <label
              key={option.id || 'off'}
              className={cn(
                'relative cursor-pointer rounded-full px-3 py-1 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent-bright)]',
                choice === option.id
                  ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                  : 'bg-[var(--bg-control)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              <input
                type="radio"
                name={`${id}-service`}
                className="absolute inset-0 size-full cursor-pointer appearance-none rounded-full opacity-0"
                checked={choice === option.id}
                onChange={() => {
                  setChoice(option.id);
                  save.reset();
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          {provider ? (
            <>
              {provider.note}{' '}
              {provider.signupUrl && (
                <ExternalAnchor href={provider.signupUrl}>
                  {provider.needsKey ? 'Get a key' : 'How to set it up'}
                </ExternalAnchor>
              )}
            </>
          ) : (
            "Agents can't search the web. Brave Search is a good start: it has a free plan."
          )}
        </p>
      </fieldset>

      {provider?.needsKey && (
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
            placeholder={keyStored ? '••••••••' : undefined}
            aria-describedby={`${id}-key-hint`}
            className={cn(FIELD, 'max-w-md')}
          />
          <p id={`${id}-key-hint`} className="text-xs text-[var(--text-muted)]">
            {keyStored
              ? 'A key is stored. Leave this empty to keep it.'
              : `Paste the key from ${provider.name}.`}
          </p>
        </div>
      )}

      {provider &&
        (provider.needsUrl ? (
          <UrlField
            id={`${id}-url`}
            label="Address"
            value={url}
            onChange={setUrl}
            hint={`Your ${provider.name}'s address, like https://search.example.com.`}
          />
        ) : (
          <div>
            <button
              type="button"
              aria-expanded={customOpen}
              aria-controls={`${id}-custom`}
              onClick={() => setCustomOpen(!customOpen)}
              className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <ChevronRight
                className={cn('size-4 transition-transform', customOpen && 'rotate-90')}
                aria-hidden="true"
              />
              Custom address
            </button>
            {customOpen && (
              <div id={`${id}-custom`} className="mt-3">
                <UrlField
                  id={`${id}-url`}
                  label="Address (optional)"
                  value={url}
                  onChange={setUrl}
                  hint={`For a self-hosted copy or a proxy. Leave empty to use ${provider.name} itself.`}
                />
              </div>
            )}
          </div>
        ))}

      <RequestError error={save.error} what="Web search" />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={!dirty || missingKey || missingUrl || save.isPending}
        >
          {save.isPending && <Spinner className="size-4 text-current" />}
          Save
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={saved.provider === '' || dirty || test.isPending}
          aria-describedby={`${id}-test-hint`}
          onClick={() => test.mutate(undefined)}
        >
          {test.isPending && <Spinner className="size-4 text-current" />}
          Test
        </Button>
        <span id={`${id}-test-hint`} className="text-xs text-[var(--text-muted)]">
          {saved.provider === ''
            ? 'Choose a service and save it to test it.'
            : dirty
              ? 'Save first, then test.'
              : 'Runs one search with the saved settings.'}
        </span>
      </div>

      {test.error ? (
        <ErrorNotice>{errorMessage(test.error, 'The test search failed.')}</ErrorNotice>
      ) : test.data ? (
        <section aria-label="Test results" className="flex flex-col gap-2">
          {test.data.results.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              It works, but the test search found nothing.
            </p>
          ) : (
            <>
              <p className="text-sm text-[var(--text-secondary)]">It works. The first results:</p>
              <ul className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-subtle)]">
                {test.data.results.slice(0, 3).map((result) => (
                  <li key={result.url} className="px-3 py-2 text-sm">
                    <ExternalAnchor href={result.url} className="font-medium">
                      {result.title || result.url}
                    </ExternalAnchor>
                    {result.snippet && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-[var(--text-muted)]">
                        {result.snippet}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : null}
    </form>
  );
}

function UrlField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type="url"
        inputMode="url"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder="https://search.example.com"
        aria-describedby={`${id}-hint`}
        className={cn(FIELD, 'max-w-md')}
      />
      <p id={`${id}-hint`} className="text-xs text-[var(--text-muted)]">
        {hint}
      </p>
    </div>
  );
}
