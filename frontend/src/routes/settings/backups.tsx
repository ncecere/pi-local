import { Archive, FolderOpen, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { type Backup, type BackupList, errorMessage } from '~/api/client';
import { keyNames, REASON_LABEL, sizeLine } from '~/components/backups/backup-bits';
import { DeleteBackupDialog, RestoreBackupDialog } from '~/components/backups/backup-dialogs';
import { ErrorNotice } from '~/components/models/fields';
import { SettingsRow, SettingsSection } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { useChooseFolder } from '~/hooks/use-agent-manager';
import {
  useBackups,
  useCancelRestore,
  useCreateBackup,
  useRevealBackup,
  useSetBackupAuto,
} from '~/hooks/use-backups';
import { useCurrentUser } from '~/hooks/use-session';
import { formatDayTime } from '~/lib/dates';
import { usePageTitle } from '~/lib/document-title';
import { formatRelativeTime } from '~/lib/utils';

const WEEK = 7 * 24 * 3_600_000;

/** How the last restore went, for a week after. */
function LastRestoreNotice({ list }: { list: BackupList }) {
  const last = list.lastRestore;
  const key = `pai.restore.dismissed.${last?.id}.${last?.at}`;
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(key) === 'true');
  if (!last || dismissed || Date.now() - last.at > WEEK) return null;
  const dismiss = (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        localStorage.setItem(key, 'true');
        setDismissed(true);
      }}
    >
      Dismiss restore notice
    </Button>
  );
  if (!last.ok)
    return (
      <ErrorNotice>
        The last restore didn't happen. {last.error || 'Nothing was changed.'} {dismiss}
      </ErrorNotice>
    );
  return (
    <div role="status" className="rounded-lg bg-[var(--bg-control)] px-3 py-2 text-sm">
      Restored from a backup {formatRelativeTime(new Date(last.at))}. The data it replaced is in{' '}
      <span className="break-all font-mono text-xs">{last.movedTo}</span>; delete that folder when
      you're sure you don't need it. {dismiss}
    </div>
  );
}

function PendingNotice({ list }: { list: BackupList }) {
  const cancel = useCancelRestore();
  if (!list.pending) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--bg-control)] px-3 py-2 text-sm"
    >
      <p>
        Restore from{' '}
        <span className="font-mono text-xs">
          {list.backups.find((backup) => backup.id === list.pending?.id)?.file ?? list.pending.id}
        </span>
        .{' '}
        {list.canRestart
          ? 'A restore is under way: Pi Local is restarting.'
          : 'A restore is waiting. Quit Pi Local and open it again to finish it.'}
      </p>
      {list.pending.phase === 'pending' && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={cancel.isPending}
          onClick={() =>
            cancel.mutate(undefined, {
              onError: (error) => toast.error(errorMessage(error, 'It could not be cancelled.')),
            })
          }
        >
          Cancel the restore
        </Button>
      )}
    </div>
  );
}

function BackupRow({
  backup,
  onRestore,
  onDelete,
}: {
  backup: Backup;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const reveal = useRevealBackup();
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-[var(--border-subtle)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)]">
          {formatDayTime(new Date(backup.createdAt))}
          <span className="ml-2 rounded-md bg-[var(--bg-control)] px-1.5 py-0.5 text-xs font-normal text-[var(--text-secondary)]">
            {REASON_LABEL[backup.reason]}
          </span>
        </p>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {backup.readable ? sizeLine(backup) : 'This file can’t be read as a backup.'}
        </p>
        {backup.needsKeys.length > 0 && (
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Keys aren't in a backup. On another computer, enter them again for{' '}
            {keyNames(backup.needsKeys)}.
          </p>
        )}
        {backup.warnings.map((warning) => (
          <p key={warning} className="mt-1 text-xs text-[var(--text-muted)]">
            {warning}
          </p>
        ))}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={reveal.isPending}
          onClick={() =>
            reveal.mutate(backup.id, {
              onError: (error) => toast.error(errorMessage(error, 'Could not open the folder.')),
            })
          }
        >
          <FolderOpen />
          Show in Finder
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!backup.readable}
          onClick={onRestore}
        >
          <RotateCcw />
          Restore…
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Delete this backup"
          onClick={onDelete}
        >
          <Trash2 />
          Delete
        </Button>
      </div>
    </li>
  );
}

/** Settings → Backups: the backups of your data, making one, the daily one, and restoring. */
export function SettingsBackupsPage() {
  usePageTitle('Backups · Settings');
  const list = useBackups();
  const create = useCreateBackup();
  const setAuto = useSetBackupAuto();
  const chooseFolder = useChooseFolder();
  const folderDialog = useCurrentUser().features?.folderDialog === true;
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [deleting, setDeleting] = useState<Backup | null>(null);
  const data = list.data;
  const making = create.isPending || data?.running === true;

  const backUp = (folder?: string) =>
    create.mutate(folder, {
      onSuccess: (made) => toast(folder ? `Backed up to ${made.path}.` : 'Backed up.'),
      onError: (error) => toast.error(errorMessage(error, 'The backup could not be made.')),
    });

  return (
    <SettingsSection title="Backups" first>
      <p className="max-w-2xl text-sm text-[var(--text-muted)]">
        A backup is one zip of your agents (their settings, memory, conversations and the files in
        their own workspace folders), your templates and Pi Local's settings. Workspaces can be
        large, so a backup can be too: the size is shown below. Keys and other secrets stay in the
        keychain and aren't in it. A project folder an agent works in isn't either.
      </p>

      {list.isError && !data && (
        <ErrorNotice>{errorMessage(list.error, 'Backups could not be read.')}</ErrorNotice>
      )}

      {data && (
        <>
          <PendingNotice list={data} />
          <LastRestoreNotice key={`${data.lastRestore?.id}.${data.lastRestore?.at}`} list={data} />
          {data.autoError && (
            <ErrorNotice>The last automatic backup failed: {data.autoError}</ErrorNotice>
          )}

          <SettingsRow
            id="backup-auto"
            label="Back up every day"
            description={`Once a day, keeping the last ${data.keep}. An agent in the middle of a reply is left alone until there is a quiet moment. Manual backups are kept until you delete them. The newest 3 before-update backups are kept separately.`}
          >
            <Switch
              checked={data.auto}
              disabled={setAuto.isPending}
              aria-labelledby="backup-auto-label"
              aria-describedby="backup-auto-description"
              onCheckedChange={(on) =>
                setAuto.mutate(on, {
                  onError: (error) =>
                    toast.error(errorMessage(error, 'The setting could not be changed.')),
                })
              }
            />
          </SettingsRow>

          <SettingsRow
            id="backup-now"
            label="Back up now"
            description="Agents that are awake sleep for a moment while their conversations are copied, then wake up and carry on."
          >
            <div className="flex flex-wrap gap-2 sm:justify-end">
              <Button type="button" variant="primary" disabled={making} onClick={() => backUp()}>
                {making ? <Spinner className="size-4 text-current" /> : <Archive />}
                {making ? 'Backing up…' : 'Back up now'}
              </Button>
              {folderDialog && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={making || chooseFolder.isPending}
                  onClick={() =>
                    chooseFolder.mutate(undefined, {
                      onSuccess: (chosen) => {
                        if (chosen.path) backUp(chosen.path);
                      },
                      onError: (error) =>
                        toast.error(errorMessage(error, 'The folder could not be chosen.')),
                    })
                  }
                >
                  Back up to a folder…
                </Button>
              )}
            </div>
          </SettingsRow>
          {create.error && <ErrorNotice>{errorMessage(create.error)}</ErrorNotice>}

          {data.backups.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              No backups yet. They are kept in{' '}
              <span className="break-all font-mono text-xs">{data.folder}</span>.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Your backups</h3>
              <ul className="flex flex-col gap-2">
                {data.backups.map((backup) => (
                  <BackupRow
                    key={backup.id}
                    backup={backup}
                    onRestore={() => setRestoring(backup)}
                    onDelete={() => setDeleting(backup)}
                  />
                ))}
              </ul>
              <p className="text-xs text-[var(--text-muted)]">
                Kept in <span className="break-all font-mono">{data.folder}</span>. That is on this
                disk: copy a backup somewhere else too.
              </p>
            </div>
          )}

          {restoring && (
            <RestoreBackupDialog
              backup={restoring}
              canRestart={data.canRestart}
              onClose={() => setRestoring(null)}
            />
          )}
          {deleting && <DeleteBackupDialog backup={deleting} onClose={() => setDeleting(null)} />}
        </>
      )}
    </SettingsSection>
  );
}
