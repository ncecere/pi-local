import { FolderOpen } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '~/api/client';
import { FIELD } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useChooseFolder } from '~/hooks/use-agent-manager';
import { useFeature } from '~/hooks/use-session';
import { cn } from '~/lib/utils';

/**
 * A project folder's path: typed or pasted (always: a browser on the headless
 * server has no dialog), or picked with the native dialog in the desktop app
 * (`features.folderDialog`).
 */
export function ProjectFolderInput({
  id,
  value,
  onChange,
  placeholder = '/Users/you/code/project',
  invalid = false,
  describedBy,
  label = 'Project folder',
}: {
  id: string;
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
  /** For the Choose… button's accessible name. */
  label?: string;
}) {
  const hasDialog = useFeature('folderDialog');
  const choose = useChooseFolder();
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(FIELD, 'min-w-0 bg-[var(--bg-control)]/30 font-mono text-xs')}
      />
      {hasDialog && (
        <Button
          type="button"
          variant="secondary"
          className="h-10 shrink-0"
          disabled={choose.isPending}
          aria-label={`Choose ${label.toLowerCase()}`}
          onClick={() =>
            choose.mutate(undefined, {
              onSuccess: (chosen) => {
                if (chosen?.path) onChange(chosen.path);
              },
              onError: (error) =>
                toast.error(errorMessage(error, "The folder dialog couldn't be opened.")),
            })
          }
        >
          {choose.isPending ? <Spinner className="size-4 text-current" /> : <FolderOpen />}
          Choose…
        </Button>
      )}
    </div>
  );
}

/** The new-agent dialog's hint under the field. */
export const PROJECT_FOLDER_HINT: ReactNode =
  "The agent reads, edits and runs commands in this folder. It also follows the folder's AGENTS.md or CLAUDE.md. Leave empty to give it a folder of its own.";
