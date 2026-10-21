import { useState } from 'react';
import { errorMessage } from '~/api/client';
import { ErrorNotice } from '~/components/models/fields';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  SCROLLING_DIALOG,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { type SkillScope, useSkillDetail, useSkillFile } from '~/hooks/use-skills';
import { cn } from '~/lib/utils';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A skill's other file, read when picked. */
function FileContent({ scope, name, path }: { scope: SkillScope; name: string; path: string }) {
  const file = useSkillFile(scope, name, path);
  if (file.isPending) return <Spinner className="mx-auto my-4" />;
  if (file.isError)
    return <ErrorNotice>{errorMessage(file.error, 'That file could not be shown.')}</ErrorNotice>;
  return (
    <>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--bg-inset)] p-3 font-mono text-xs">
        {file.data.content}
      </pre>
      {file.data.truncated && (
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Only the start of this file is shown.
        </p>
      )}
    </>
  );
}

/** A skill, to read: what it tells the agent, where it is, and its files. */
export function SkillViewDialog({
  scope,
  name,
  onClose,
}: {
  scope: SkillScope;
  name: string;
  onClose: () => void;
}) {
  const detail = useSkillDetail(scope, name);
  const [path, setPath] = useState<string | null>(null);
  const skill = detail.data;
  const others = (skill?.files ?? []).filter((file) => file.path !== 'SKILL.md');
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(SCROLLING_DIALOG, 'max-w-2xl')}>
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>{skill?.description ?? ' '}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {detail.isPending && <Spinner className="mx-auto my-6" />}
          {detail.isError && (
            <ErrorNotice>{errorMessage(detail.error, 'The skill could not be read.')}</ErrorNotice>
          )}
          {skill && (
            <div className="flex flex-col gap-4 pb-1">
              {skill.problem && <ErrorNotice>{skill.problem}</ErrorNotice>}
              <section aria-label="Instructions">
                <h3 className="mb-1.5 text-sm font-semibold">Instructions</h3>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--bg-inset)] p-3 font-mono text-xs">
                  {skill.body.trim() || 'SKILL.md has no instructions yet.'}
                </pre>
              </section>
              {others.length > 0 && (
                <section aria-label="Files">
                  <h3 className="mb-1.5 text-sm font-semibold">Files</h3>
                  <ul className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-subtle)]">
                    {others.map((file) => (
                      <li key={file.path}>
                        <button
                          type="button"
                          aria-expanded={path === file.path}
                          onClick={() => setPath(path === file.path ? null : file.path)}
                          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-[var(--bg-control)]"
                        >
                          <span className="min-w-0 truncate font-mono text-xs">{file.path}</span>
                          <span className="shrink-0 text-xs text-[var(--text-muted)]">
                            {formatBytes(file.size)}
                          </span>
                        </button>
                        {path === file.path && (
                          <div className="px-3 pb-3">
                            <FileContent scope={scope} name={name} path={file.path} />
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <p className="break-all text-xs text-[var(--text-muted)]">
                Folder: <span className="font-mono">{skill.folder}</span>
              </p>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
