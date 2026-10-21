import { Link, useNavigate } from '@tanstack/react-router';
import { Check, ExternalLink, Plus } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import type { DetectedServer, Provider, ProviderPreset } from '~/api/client';
import { FIELD, RequestError } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useAgentCatalog, useAgents } from '~/hooks/use-agents';
import { useDetectedServers, useProviders, useSetupProvider } from '~/hooks/use-providers';
import { useSecretsHome } from '~/hooks/use-session';
import { DEMO_MODEL_ID, filterDiscovered, onlyDemoModel, splitModelId } from '~/lib/models';
import { useSkipModel } from '~/lib/onboarding';
import { cn, plural } from '~/lib/utils';
import { AgentDialog } from '~/routes/settings/agents';

const LINK = 'text-[var(--accent-bright)] underline-offset-4 hover:underline';

/** A link to another site; the desktop app opens it in the person's browser. */
export function ExternalAnchor({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('inline-flex items-center gap-1', LINK, className)}
    >
      {children}
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  );
}

/** "A, B or C". */
function joinOr(items: ReactNode[]): ReactNode[] {
  return items.flatMap((item, index) => {
    if (index === 0) return [item];
    return [index === items.length - 1 ? ' or ' : ', ', item];
  });
}

function Step({
  number,
  title,
  done,
  children,
}: {
  number: number;
  title: string;
  done: boolean;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3.5 py-4 first:pt-0 last:pb-0">
      <span
        aria-hidden="true"
        className={cn(
          'mt-px flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
          done
            ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
            : 'border border-[var(--border-strong)] text-[var(--text-secondary)]',
        )}
      >
        {done ? <Check className="size-3.5" /> : number}
      </span>
      <div className="min-w-0 flex-1">
        <h3
          className={cn('text-[0.9375rem] font-semibold', done && 'text-[var(--text-secondary)]')}
        >
          <span className="sr-only">Step {number}: </span>
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </h3>
        <div className="mt-1 text-sm text-[var(--text-muted)]">{children}</div>
      </div>
    </li>
  );
}

/** A local server's models, ready to use in one click. */
function DetectedRow({
  server,
  pending,
  onUse,
}: {
  server: DetectedServer;
  pending: boolean;
  onUse: () => void;
}) {
  if (server.models.length === 0)
    return (
      <li className="py-1.5">
        {server.name} is running but has no models yet.{' '}
        {server.preset === 'ollama' ? (
          <>
            Pull one (<code className="font-mono text-xs">ollama pull llama3.2</code>).
          </>
        ) : (
          `Download one in ${server.name}.`
        )}
      </li>
    );
  return (
    <li className="flex flex-wrap items-center gap-3 py-1.5">
      <span className="min-w-0 flex-1 text-[var(--text-secondary)]">
        {server.name} is running · {plural(server.models.length, 'model')}
      </span>
      <Button type="button" variant="primary" size="sm" disabled={pending} onClick={onUse}>
        {pending && <Spinner className="size-3.5 text-current" />}
        Use {server.name}
      </Button>
    </li>
  );
}

/** Model servers on this computer: each not set up yet, with a button to use it. */
function FoundHere({ presets }: { presets: ProviderPreset[] }) {
  const detect = useDetectedServers();
  const setup = useSetupProvider();
  const servers = (detect.data ?? []).filter((server) => server.provider === null);
  const downloads = presets.filter((preset) => preset.local && preset.signupUrl);

  return (
    <section aria-label="Found on this computer" className="mt-3">
      <h4 className="text-xs font-semibold text-[var(--text-secondary)]">Found on this computer</h4>
      {detect.isPending ? (
        <p className="mt-1.5 flex items-center gap-2">
          <Spinner />
          Looking for model servers on this computer…
        </p>
      ) : servers.length > 0 ? (
        <ul className="mt-1">
          {servers.map((server) => (
            <DetectedRow
              key={server.preset}
              server={server}
              pending={setup.isPending && setup.variables?.preset === server.preset}
              onUse={() => setup.mutate({ preset: server.preset })}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-1.5">
          No local model server found.{' '}
          {downloads.length > 0
            ? joinOr(
                downloads.map((preset) => (
                  <ExternalAnchor key={preset.id} href={preset.signupUrl ?? ''}>
                    {preset.name}
                  </ExternalAnchor>
                )),
              )
            : 'Ollama or LM Studio'}{' '}
          run models free on this computer.
        </p>
      )}
      {setup.error ? (
        <div className="mt-2">
          <RequestError error={setup.error} what="This server" />
        </div>
      ) : null}
    </section>
  );
}

/** A provider account: its key, then which of its models agents may use. */
function KeyedProvider({ preset, existing }: { preset: ProviderPreset; existing?: Provider }) {
  const id = useId();
  const home = useSecretsHome();
  const connect = useSetupProvider();
  const choose = useSetupProvider();
  const [apiKey, setApiKey] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  // A key turned down just now may be the stored one: then it isn't offered as one to use.
  const keyStored = (existing?.hasKey ?? false) && !connect.error;

  if (!connect.data) {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      const key = apiKey.trim();
      connect.mutate({ preset: preset.id, ...(key ? { apiKey: key } : {}) });
    };
    return (
      <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
        <label htmlFor={`${id}-key`} className="text-sm font-medium text-[var(--text-primary)]">
          {preset.name} API key
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id={`${id}-key`}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={keyStored ? '••••••••' : undefined}
            aria-describedby={`${id}-key-hint`}
            className={cn(FIELD, 'min-w-0 flex-1')}
          />
          <Button
            type="submit"
            variant="primary"
            className="h-10"
            disabled={connect.isPending || (!apiKey.trim() && !keyStored)}
          >
            {connect.isPending && <Spinner className="size-4 text-current" />}
            Connect
          </Button>
        </div>
        <p id={`${id}-key-hint`} className="text-xs">
          {keyStored ? 'A key is stored. Leave this empty to use it. ' : `Kept in ${home}. `}
          {preset.signupUrl && <ExternalAnchor href={preset.signupUrl}>Get a key</ExternalAnchor>}
        </p>
        <RequestError error={connect.error} what={preset.name} />
      </form>
    );
  }

  const available = connect.data.available;
  const shown = filterDiscovered(available, query);
  const MAX_SHOWN = 100;
  const toggle = (modelId: string, on: boolean) =>
    setPicked((before) =>
      on ? [...before, modelId] : before.filter((candidate) => candidate !== modelId),
    );

  return (
    <div className="mt-3 flex flex-col gap-2">
      <p className="text-[var(--text-secondary)]">
        Connected to {preset.name}. Choose the models your agents may use; the first becomes the
        default.
      </p>
      {available.length === 0 ? (
        <p>{preset.name} lists no models for this key.</p>
      ) : (
        <>
          <input
            type="search"
            aria-label="Search models"
            placeholder="Search models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={FIELD}
          />
          <ul
            aria-label={`${preset.name} models`}
            className="max-h-64 overflow-y-auto rounded-lg border border-[var(--border-subtle)] py-1"
          >
            {shown.slice(0, MAX_SHOWN).map((model) => (
              <li key={model.modelId}>
                <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-[var(--bg-control)]">
                  <input
                    type="checkbox"
                    checked={picked.includes(model.modelId)}
                    onChange={(event) => toggle(model.modelId, event.target.checked)}
                  />
                  <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                    {model.name}
                  </span>
                  {model.name !== model.modelId && (
                    <span className="truncate font-mono text-xs">{model.modelId}</span>
                  )}
                </label>
              </li>
            ))}
            {shown.length === 0 && <li className="px-3 py-1.5">No model matches.</li>}
            {shown.length > MAX_SHOWN && (
              <li className="px-3 py-1.5 text-xs">
                {shown.length - MAX_SHOWN} more. Search to narrow the list.
              </li>
            )}
          </ul>
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="primary"
          disabled={picked.length === 0 || choose.isPending}
          onClick={() => choose.mutate({ preset: preset.id, models: picked })}
        >
          {choose.isPending && <Spinner className="size-4 text-current" />}
          Use these
        </Button>
        {picked.length > 0 && (
          <span aria-live="polite">{plural(picked.length, 'model')} chosen</span>
        )}
      </div>
      <RequestError error={choose.error} what={preset.name} />
    </div>
  );
}

/** Step 1, open: a server on this computer, a provider account, or the demo model. */
function ConnectModel({ onSkip }: { onSkip: () => void }) {
  const providers = useProviders();
  const [chosen, setChosen] = useState<string | null>(null);
  const presets = providers.data?.presets ?? [];
  // Accounts that need only a key: OpenAI, Anthropic, OpenRouter.
  const keyed = presets.filter((preset) => !preset.local && preset.needsKey && preset.signupUrl);
  const current = keyed.find((preset) => preset.id === chosen);

  return (
    <>
      <p>Agents need a model to think with. Use one on this computer, or a provider account.</p>
      <FoundHere presets={presets} />
      {keyed.length > 0 && (
        <section aria-label="Use a provider" className="mt-4">
          <h4 className="text-xs font-semibold text-[var(--text-secondary)]">Use a provider</h4>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {keyed.map((preset) => (
              <Button
                key={preset.id}
                type="button"
                variant={preset.id === chosen ? 'accent' : 'secondary'}
                size="sm"
                aria-pressed={preset.id === chosen}
                onClick={() => setChosen(preset.id === chosen ? null : preset.id)}
              >
                {preset.name}
              </Button>
            ))}
          </div>
          {current && (
            <KeyedProvider
              key={current.id}
              preset={current}
              existing={providers.data?.providers.find((provider) => provider.id === current.id)}
            />
          )}
        </section>
      )}
      <p className="mt-4">
        CLIProxyAPI, LiteLLM or another OpenAI-compatible server? Add it in{' '}
        <Link to="/settings/models" className={LINK}>
          Settings → Models
        </Link>
        . Or{' '}
        <button type="button" className={LINK} onClick={onSkip}>
          try the demo model
        </button>
        .
      </p>
    </>
  );
}

/**
 * First run, on the home page: connect a model, then make an agent. Shows
 * while either is left to do; done steps are ticked and listed first.
 */
export function GetStarted({ className }: { className?: string }) {
  const agents = useAgents();
  const catalog = useAgentCatalog(agents.isSuccess);
  const [skipped, setSkipped] = useSkipModel();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  if (!agents.isSuccess || !catalog.data) return null;

  const hasAgent = agents.data.length > 0;
  const hasModel = !onlyDemoModel(catalog.data.models);
  const modelDone = hasModel || skipped;
  // The New agent dialog stays until it closes, even once the agent is made.
  if (hasAgent && modelDone && !creating) return null;
  const canMake = catalog.data.limit > catalog.data.used && catalog.data.templates.length > 0;

  const defaultId = catalog.data.defaultModelId;
  const defaultName =
    defaultId && defaultId !== DEMO_MODEL_ID
      ? (catalog.data.models.find((model) => model.id === defaultId)?.name ??
        splitModelId(defaultId)?.modelId ??
        defaultId)
      : null;

  const modelStep = (
    <Step key="model" number={1} title="Connect a model" done={modelDone}>
      {hasModel ? (
        <p>Connected.{defaultName && ` Default model: ${defaultName}`}</p>
      ) : skipped ? (
        <p>
          Using the demo model, which gives scripted answers.{' '}
          <button type="button" className={LINK} onClick={() => setSkipped(false)}>
            Connect a model
          </button>
        </p>
      ) : (
        <ConnectModel onSkip={() => setSkipped(true)} />
      )}
    </Step>
  );
  const agentStep = (
    <Step key="agent" number={2} title="Make your first agent" done={hasAgent}>
      {hasAgent ? (
        <p>You have an agent.</p>
      ) : (
        <>
          <p>An agent has its own instructions, memory and conversations.</p>
          <div className="mt-3">
            {modelDone ? (
              <Button
                type="button"
                variant="primary"
                disabled={!canMake}
                onClick={() => setCreating(true)}
              >
                <Plus />
                Make an agent
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="primary" disabled>
                  <Plus />
                  Make an agent
                </Button>
                <span>Connect a model first, or try the demo model.</span>
              </div>
            )}
          </div>
        </>
      )}
    </Step>
  );

  return (
    <section
      aria-labelledby="get-started-title"
      className={cn(
        'rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/30 p-5 text-left',
        className,
      )}
    >
      <h2 id="get-started-title" className="text-base font-bold">
        Get started
      </h2>
      <ol className="mt-4 divide-y divide-[var(--border-subtle)]">
        {/* Done first, so progress shows at the top. */}
        {hasAgent && !modelDone ? [agentStep, modelStep] : [modelStep, agentStep]}
      </ol>
      {creating && (
        <AgentDialog
          agent={null}
          catalog={catalog.data}
          onClose={() => setCreating(false)}
          onCreated={(agent) => void navigate({ to: '/', search: { agent: agent.id } })}
        />
      )}
    </section>
  );
}
