import { RefreshCw } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, type McpImportResult, type McpImportServer } from '~/api/client';
import { McpStatusBadge, McpTestResult, TrustWarning } from '~/components/mcp/server-bits';
import { ErrorNotice } from '~/components/models/fields';
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
import { useImportMcpServers, useMcpImportList } from '~/hooks/use-mcp';
import { useSecretsHome } from '~/hooks/use-session';
import { commandLine, IMPORT_PLACES, importKey, importRequests, importSourceName } from '~/lib/mcp';
import { cn, plural } from '~/lib/utils';

function ImportRow({
  server,
  checked,
  onChange,
}: {
  server: McpImportServer;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  const home = useSecretsHome();
  const blocked = server.exists || Boolean(server.unsupported);
  const what =
    server.transport === 'http'
      ? (server.url ?? '')
      : commandLine(server.command ?? '', server.args ?? []);
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked && !blocked}
        disabled={blocked}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={`${id}-what`}
        className="mt-0.5 size-4 shrink-0 accent-[var(--accent)] disabled:opacity-50"
      />
      <div className="min-w-0 flex-1">
        <label
          htmlFor={id}
          className={cn(
            'flex flex-wrap items-baseline gap-x-2 text-sm font-medium',
            blocked ? 'text-[var(--text-muted)]' : 'cursor-pointer',
          )}
        >
          {server.name}
          <span className="text-xs font-normal text-[var(--text-muted)]">
            {server.transport === 'http' ? 'remote server' : 'command'}
            {server.exists && ' · already added'}
          </span>
        </label>
        {server.unsupported && !server.exists && (
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            Can’t be imported: {server.unsupported}.
          </p>
        )}
        <p
          id={`${id}-what`}
          className="mt-1 whitespace-pre-wrap break-all font-mono text-xs text-[var(--text-secondary)]"
        >
          {what || '(no command)'}
        </p>
        {server.envNames.length > 0 && (
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {server.transport === 'http' ? 'Headers' : 'Environment'}:{' '}
            <span className="font-mono">{server.envNames.join(', ')}</span> (values are imported
            into {home})
          </p>
        )}
      </div>
    </li>
  );
}

function ImportResultView({ result }: { result: McpImportResult }) {
  return (
    <div className="flex flex-col gap-4">
      {result.servers.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Added</h3>
          <ul className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-subtle)]">
            {result.servers.map((server) => (
              <li key={server.slug} className="flex flex-col gap-2 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">
                    {server.name}{' '}
                    <span className="font-mono text-xs font-normal text-[var(--text-muted)]">
                      {server.slug}
                    </span>
                  </span>
                  <McpStatusBadge server={server} />
                </div>
                <McpTestResult server={server} showTools={false} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {result.skipped.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Skipped</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {result.skipped.map((skip) => (
              <li key={skip.name}>
                <span className="font-medium">{skip.name}</span>
                <span className="text-[var(--text-muted)]">: {skip.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {result.servers.length === 0 && result.skipped.length === 0 && (
        <p className="text-sm text-[var(--text-muted)]">Nothing was imported.</p>
      )}
    </div>
  );
}

/**
 * Import: the MCP servers Claude Desktop, Cursor and VS Code are set up with,
 * each shown in full (command and arguments, or URL, and its variables'
 * names), to pick from. Servers already here can't be picked again.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const home = useSecretsHome();
  const list = useMcpImportList(true);
  const importer = useImportMcpServers();
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [result, setResult] = useState<McpImportResult | null>(null);

  const sources = list.data?.sources ?? [];
  const found = sources.some((source) => source.servers.length > 0);
  const count = picked.size;

  const toggle = (key: string, on: boolean) =>
    setPicked((before) => {
      const next = new Set(before);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const submit = () =>
    importer.mutate(importRequests(picked), {
      onSuccess: (done) => {
        setResult(done);
        if (done.servers.length > 0) toast(`${plural(done.servers.length, 'server')} imported.`);
      },
    });

  let body: ReactNode;
  if (result) body = <ImportResultView result={result} />;
  else if (list.isError)
    body = (
      <div className="flex flex-col items-start gap-3">
        <ErrorNotice>Other apps’ settings couldn’t be read: {errorMessage(list.error)}</ErrorNotice>
        <Button type="button" variant="secondary" onClick={() => void list.refetch()}>
          <RefreshCw />
          Try again
        </Button>
      </div>
    );
  else if (!list.data)
    body = (
      <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <Spinner className="size-4" /> Looking in Claude Desktop, Cursor and VS Code…
      </p>
    );
  else if (!found) {
    // The paths the backend says it searched; this build's guess for an older backend.
    const searched = list.data.searched;
    const places =
      searched && searched.length > 0
        ? searched.map((path) => ({ id: placeOf(path), path }))
        : sources.length > 0
          ? sources
          : IMPORT_PLACES;
    body = (
      <div className="flex flex-col gap-2 text-sm">
        <p>No MCP servers were found. Pi Local looked in:</p>
        <ul className="flex flex-col gap-1.5">
          {places.map((place) => (
            <li key={`${place.id}-${place.path}`}>
              <span className="font-medium">{importSourceName(place.id)}</span>
              <span className="block break-all font-mono text-xs text-[var(--text-muted)]">
                {place.path}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  } else
    body = (
      <div className="flex flex-col gap-4">
        <TrustWarning>
          Importing a command starts it on this computer, as you, to test it — only import commands
          you trust.
        </TrustWarning>
        {sources.map((source) => (
          <section key={`${source.id}-${source.path}`} aria-label={importSourceName(source.id)}>
            <h3 className="text-sm font-semibold">{importSourceName(source.id)}</h3>
            <p className="mb-2 break-all font-mono text-xs text-[var(--text-muted)]">
              {source.path}
            </p>
            {source.servers.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">No servers in it.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-subtle)]">
                {source.servers.map((server) => {
                  const key = importKey(source.id, server.name);
                  return (
                    <ImportRow
                      key={key}
                      server={server}
                      checked={picked.has(key)}
                      onChange={(on) => toggle(key, on)}
                    />
                  );
                })}
              </ul>
            )}
          </section>
        ))}
        {importer.error ? <ErrorNotice>{errorMessage(importer.error)}</ErrorNotice> : null}
        {importer.isPending && (
          <p
            className="flex items-center gap-2 text-sm text-[var(--text-muted)]"
            aria-live="polite"
          >
            <Spinner className="size-4" /> Importing and testing each one. This can take a while.
          </p>
        )}
      </div>
    );

  return (
    <Dialog open onOpenChange={(open) => !open && !importer.isPending && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{result ? 'Imported' : 'Import MCP servers'}</DialogTitle>
          <DialogDescription>
            {result
              ? 'Choose which agents use them on each agent’s MCP tab.'
              : `From the settings of other apps on this computer. Their variable and header values come along, into ${home}.`}
          </DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter className="mt-2">
          {result ? (
            <Button type="button" variant="primary" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={onClose}
                disabled={importer.isPending}
              >
                {found ? 'Cancel' : 'Close'}
              </Button>
              {found && (
                <Button
                  type="button"
                  variant="primary"
                  disabled={count === 0 || importer.isPending}
                  onClick={submit}
                >
                  {importer.isPending && <Spinner className="size-4 text-current" />}
                  {count === 0 ? 'Import' : `Import ${plural(count, 'server')}`}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Which app a config file belongs to, by where it is. */
function placeOf(path: string): 'claude' | 'cursor' | 'vscode' {
  if (path.includes('Claude')) return 'claude';
  if (path.includes('.cursor')) return 'cursor';
  return 'vscode';
}
