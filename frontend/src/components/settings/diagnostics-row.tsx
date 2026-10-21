import { LifeBuoy } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '~/api/client';
import { SettingsRow } from '~/components/settings/settings-layout';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useSaveDiagnostics } from '~/hooks/use-backups';

/** Settings → About: the zip to send when something goes wrong. */
export function DiagnosticsRow() {
  const save = useSaveDiagnostics();
  return (
    <SettingsRow
      id="diagnostics"
      label="Diagnostics"
      description="A zip with versions, how Pi Local is set up, each agent's settings and the end of every log, to send when something goes wrong. Keys, tokens and passwords are removed. Conversations, memory and files aren't included."
    >
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={save.isPending}
        onClick={() =>
          save.mutate(undefined, {
            onSuccess: (saved) => {
              if (saved) toast(`Saved ${saved}.`);
            },
            onError: (error) =>
              toast.error(errorMessage(error, 'The diagnostics could not be saved.')),
          })
        }
      >
        {save.isPending ? <Spinner className="size-3.5 text-current" /> : <LifeBuoy />}
        Save diagnostics…
      </Button>
    </SettingsRow>
  );
}
