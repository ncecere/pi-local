import { Download, ExternalLink, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage, type UpdateStage, type UpdateStatus } from '~/api/client';
import { MARKDOWN_PROSE, Markdown } from '~/components/chat/markdown';
import { ErrorNotice } from '~/components/models/fields';
import { SettingsRow, SettingsSection } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import {
  installing,
  updatesUnsupported,
  useCheckForUpdate,
  useInstallUpdate,
  useSetUpdateAutoCheck,
  useUpdateStatus,
} from '~/hooks/use-update';
import { formatRelativeTime } from '~/lib/utils';

const STAGE_TEXT: Record<Exclude<UpdateStage, 'failed'>, string> = {
  downloading: 'Downloading…',
  verifying: 'Checking the signature…',
  installing: 'Installing…',
  restarting: 'Restarting…',
};

/** "No releases yet" from the backend's "no releases yet". */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What the row says first: an install's stage, an update, the error, or that all is well. */
export function updateHeadline(status: UpdateStatus): string {
  if (status.stage === 'failed') return 'The update failed';
  if (status.stage) return STAGE_TEXT[status.stage];
  if (status.available && status.latest) return `Version ${status.latest.version} is available`;
  if (status.error) return sentence(status.error);
  if (status.checkedAt === null) return 'Not checked yet';
  return 'Pi Local is up to date';
}

function versionsLine(status: UpdateStatus): string {
  const parts = [`This is version ${status.current}.`];
  if (status.latest && status.latest.version !== status.current)
    parts.push(`The latest is ${status.latest.version}.`);
  if (status.checkedAt !== null)
    parts.push(`Checked ${formatRelativeTime(new Date(status.checkedAt))}.`);
  return parts.join(' ');
}

/**
 * Settings → About → Updates: this version and the latest release on GitHub,
 * its notes, and installing it (or a link to download it, where this copy
 * can't replace itself). Hidden where there are no updates at all (501).
 */
export function UpdatesSection() {
  const status = useUpdateStatus();
  const check = useCheckForUpdate();
  const install = useInstallUpdate();
  const setAutoCheck = useSetUpdateAutoCheck();

  if (updatesUnsupported(status.error)) return null;
  if (!status.data) {
    if (!status.isError) return null;
    return (
      <SettingsSection title="Updates">
        <ErrorNotice>{errorMessage(status.error, "Updates couldn't be read.")}</ErrorNotice>
      </SettingsSection>
    );
  }

  const data = status.data;
  const busy = installing(data.stage);
  const failed = data.stage === 'failed';
  const disabled = busy || check.isPending || install.isPending;
  const showNotes = data.available && data.latest && data.latest.notes.trim() !== '';
  // A failed check's error is the headline when there is nothing else to say; otherwise it shows under it.
  const errorIsHeadline = !data.stage && !(data.available && data.latest);
  const shownError = errorIsHeadline ? null : data.error;
  const requestError = check.error ?? install.error;

  return (
    <SettingsSection title="Updates">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <p
            id="update-status-label"
            aria-live="polite"
            className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]"
          >
            {busy && <Spinner className="size-4" />}
            {updateHeadline(data)}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">
            {versionsLine(data)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              install.reset();
              check.mutate();
            }}
          >
            {check.isPending ? <Spinner className="size-3.5 text-current" /> : <RefreshCw />}
            Check now
          </Button>
        </div>
      </div>

      {shownError && <ErrorNotice>{shownError}</ErrorNotice>}
      {requestError && <ErrorNotice>{errorMessage(requestError)}</ErrorNotice>}

      {data.available && data.latest && (
        <div className="flex flex-col gap-3">
          {showNotes && (
            <section
              aria-label={`What's new in ${data.latest.version}`}
              className="max-h-72 overflow-y-auto rounded-xl border border-[var(--border-subtle)] px-4 py-3 text-sm leading-relaxed text-[var(--text-secondary)]"
            >
              <Markdown className={MARKDOWN_PROSE} math={false} skipHtml>
                {data.latest.notes}
              </Markdown>
            </section>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {data.canInstall ? (
              <Button
                type="button"
                variant="primary"
                disabled={disabled}
                onClick={() => {
                  check.reset();
                  install.mutate();
                }}
              >
                {install.isPending || busy ? (
                  <Spinner className="size-4 text-current" />
                ) : (
                  <Download />
                )}
                {failed ? 'Try again' : 'Install and restart'}
              </Button>
            ) : (
              data.installBlocked && (
                <p className="text-sm text-[var(--text-secondary)]">{data.installBlocked}</p>
              )
            )}
            {!data.canInstall && data.latest.url && (
              <a
                href={data.latest.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--accent-bright)] underline-offset-4 hover:underline"
              >
                Download from GitHub
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      )}

      <SettingsRow
        id="update-auto-check"
        label="Check for updates automatically"
        description="Pi Local looks for a new version now and then, and tells you here when there is one."
      >
        <Switch
          checked={data.autoCheck}
          disabled={setAutoCheck.isPending}
          aria-labelledby="update-auto-check-label"
          aria-describedby="update-auto-check-description"
          onCheckedChange={(on) =>
            setAutoCheck.mutate(on, {
              onError: (error) =>
                toast.error(errorMessage(error, 'The setting could not be changed.')),
            })
          }
        />
      </SettingsRow>
    </SettingsSection>
  );
}
