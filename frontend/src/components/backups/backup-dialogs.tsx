import { toast } from 'sonner';
import { type Backup, errorMessage } from '~/api/client';
import { keyNames, REASON_LABEL } from '~/components/backups/backup-bits';
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
import { useDeleteBackup, useRestoreBackup } from '~/hooks/use-backups';
import { formatDayTime } from '~/lib/dates';

const when = (backup: Backup) => formatDayTime(new Date(backup.createdAt));

/**
 * Restore asks first: it replaces everything the app holds (agents, conversations, settings) with what the backup
 * held, and it restarts the app to do it. Nothing is deleted: the current data is moved aside.
 */
export function RestoreBackupDialog({
  backup,
  canRestart,
  onClose,
}: {
  backup: Backup;
  canRestart: boolean;
  onClose: () => void;
}) {
  const restore = useRestoreBackup();
  const done = restore.data;
  return (
    <Dialog open onOpenChange={(open) => !open && !restore.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore the backup from {when(backup)}?</DialogTitle>
          <DialogDescription>
            Your agents, their conversations and files, your templates and Pi Local's settings go
            back to how they were then. Anything since is replaced.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
          <p>
            Your current data isn't deleted: it is moved to a <b>before-restore</b> folder inside
            the data folder, so you can get anything back. Delete that folder when you're sure.
          </p>
          <p>
            {canRestart
              ? 'Pi Local quits and opens again to do this; agents that are working stop and carry on afterwards.'
              : 'Pi Local has to be quit and opened again to finish the restore.'}
          </p>
          {backup.needsKeys.length > 0 && (
            <p>
              Keys stay in your keychain. On a different computer, type again the keys for{' '}
              {keyNames(backup.needsKeys)}.
            </p>
          )}
        </div>
        {done && (
          <p role="status" className="rounded-lg bg-[var(--bg-control)] px-3 py-2 text-sm">
            {done.restarting
              ? 'Restoring: Pi Local is restarting…'
              : 'The restore is ready. Quit Pi Local and open it again to finish it.'}
          </p>
        )}
        {restore.error && <ErrorNotice>{errorMessage(restore.error)}</ErrorNotice>}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={restore.isPending} onClick={onClose}>
            {done ? 'Close' : 'Cancel'}
          </Button>
          {!done && (
            <Button
              type="button"
              variant="primary"
              disabled={restore.isPending}
              onClick={() => restore.mutate(backup.id)}
            >
              {restore.isPending && <Spinner className="size-4 text-current" />}
              {canRestart ? 'Restore and restart' : 'Restore'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteBackupDialog({ backup, onClose }: { backup: Backup; onClose: () => void }) {
  const remove = useDeleteBackup();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this backup?</DialogTitle>
          <DialogDescription>
            {REASON_LABEL[backup.reason]}, {when(backup)}. The file is deleted for good.
          </DialogDescription>
        </DialogHeader>
        {remove.error && <ErrorNotice>{errorMessage(remove.error)}</ErrorNotice>}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(backup.id, {
                onSuccess: () => {
                  toast('Backup deleted.');
                  onClose();
                },
              })
            }
          >
            {remove.isPending && <Spinner className="size-4 text-current" />}
            Delete backup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
