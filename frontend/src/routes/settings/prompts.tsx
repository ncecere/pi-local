import { Download, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, errorMessage, type LibraryPrompt } from '~/api/client';
import { ConfirmDialog, ErrorNotice, FIELD, Field, Optional } from '~/components/models/fields';
import { SettingsSection } from '~/components/settings/settings-layout';
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
import {
  useCreatePrompt,
  useDeletePrompt,
  useExportPrompts,
  useImportPrompts,
  usePrompts,
  useUpdatePrompt,
} from '~/hooks/use-prompts';
import { usePageTitle } from '~/lib/document-title';
import { placeholdersOf } from '~/lib/slash-commands';

const MAX_BODY = 20_000;

/** Add or change a prompt: its title, a line about it, and its text with {{blanks}} to fill in. */
function PromptDialog({ prompt, onClose }: { prompt: LibraryPrompt | null; onClose: () => void }) {
  const id = useId();
  const create = useCreatePrompt();
  const update = useUpdatePrompt();
  const [title, setTitle] = useState(prompt?.title ?? '');
  const [description, setDescription] = useState(prompt?.description ?? '');
  const [body, setBody] = useState(prompt?.body ?? '');
  const [error, setError] = useState<unknown>(null);
  const blanks = placeholdersOf(body);
  const busy = create.isPending || update.isPending;
  const ready = title.trim() !== '' && body.trim() !== '' && body.length <= MAX_BODY;

  async function save() {
    setError(null);
    const input = { title, description, body };
    try {
      if (prompt) await update.mutateAsync({ id: prompt.id, ...input });
      else await create.mutateAsync(input);
      toast(prompt ? 'Prompt saved.' : 'Prompt added.');
      onClose();
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        confirmDiscard={
          title !== (prompt?.title ?? '') ||
          description !== (prompt?.description ?? '') ||
          body !== (prompt?.body ?? '')
        }
        className="max-w-xl"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !busy) void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{prompt ? 'Edit prompt' : 'New prompt'}</DialogTitle>
            <DialogDescription>
              Type / at the start of a message to use it. Put {'{{name}}'} where something changes
              each time; you are asked for it when you use the prompt.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Field id={`${id}-title`} label="Title">
              <input
                id={`${id}-title`}
                className={FIELD}
                value={title}
                maxLength={100}
                onChange={(event) => setTitle(event.target.value)}
                autoFocus
              />
            </Field>
            <Field
              id={`${id}-description`}
              label={
                <>
                  What it is for <Optional />
                </>
              }
            >
              <input
                id={`${id}-description`}
                className={FIELD}
                value={description}
                maxLength={300}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field
              id={`${id}-body`}
              label="Text"
              hint={
                blanks.length > 0
                  ? `Blanks to fill in: ${blanks.join(', ')}`
                  : 'No blanks yet. Add some with {{name}}.'
              }
            >
              <textarea
                id={`${id}-body`}
                className="min-h-40 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)]/60 px-3 py-2 text-sm"
                value={body}
                rows={8}
                onChange={(event) => setBody(event.target.value)}
                aria-invalid={body.length > MAX_BODY || undefined}
              />
            </Field>
            {body.length > MAX_BODY && (
              <ErrorNotice>A prompt is at most 20,000 characters.</ErrorNotice>
            )}
            {error ? (
              <ErrorNotice>{errorMessage(error, 'The prompt could not be saved.')}</ErrorNotice>
            ) : null}
          </div>
          <DialogFooter className="mt-5">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!ready || busy}>
              {busy && <Spinner className="size-4 text-current" />}
              {prompt ? 'Save' : 'Add prompt'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PromptRow({
  prompt,
  onEdit,
  onDelete,
}: {
  prompt: LibraryPrompt;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)]">
          {prompt.title}{' '}
          <span className="ml-1 font-mono text-xs font-normal text-[var(--text-muted)]">
            /{prompt.id}
          </span>
        </p>
        {prompt.description && (
          <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{prompt.description}</p>
        )}
        <p className="mt-1 line-clamp-2 whitespace-pre-line text-sm text-[var(--text-muted)]">
          {prompt.body}
        </p>
        {prompt.placeholders.length > 0 && (
          <p className="mt-1.5 flex flex-wrap gap-1.5">
            {prompt.placeholders.map((name) => (
              <span
                key={name}
                className="rounded-md bg-[var(--bg-control)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-secondary)]"
              >
                {`{{${name}}}`}
              </span>
            ))}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={onEdit}
          aria-label={`Edit ${prompt.title}`}
        >
          <Pencil />
          Edit
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onDelete}
          aria-label={`Delete ${prompt.title}`}
        >
          <Trash2 />
          Delete
        </Button>
      </div>
    </li>
  );
}

/** Import: a Markdown file, or a zip an export made. Its bytes go as an ArrayBuffer (the desktop app drops Blobs). */
function ImportButton({ onError }: { onError: (error: unknown) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const importPrompts = useImportPrompts();
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".md,.markdown,.zip,text/markdown,application/zip"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="import-prompts"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          onError(null);
          importPrompts.mutate(file, {
            onSuccess: ({ prompts, skipped }) =>
              toast(
                `${prompts.length === 1 ? '1 prompt' : `${prompts.length} prompts`} imported${skipped > 0 ? `; ${skipped} ${skipped === 1 ? 'file was' : 'files were'} skipped` : ''}.`,
              ),
            onError,
          });
        }}
      />
      <Button
        variant="secondary"
        disabled={importPrompts.isPending}
        onClick={() => input.current?.click()}
      >
        {importPrompts.isPending ? <Spinner className="size-4 text-current" /> : <Upload />}
        Import
      </Button>
    </>
  );
}

/** Settings → Prompts: the prompt library. */
export function SettingsPromptsPage() {
  usePageTitle('Prompts · Settings');
  const prompts = usePrompts();
  const remove = useDeletePrompt();
  const exportAll = useExportPrompts();
  const [editing, setEditing] = useState<LibraryPrompt | 'new' | null>(null);
  const [deleting, setDeleting] = useState<LibraryPrompt | null>(null);
  const [importError, setImportError] = useState<unknown>(null);

  if (prompts.isPending)
    return (
      <div className="py-12">
        <Spinner className="mx-auto" />
      </div>
    );
  const list = prompts.data ?? [];

  return (
    <>
      <SettingsSection title="Prompts" first>
        <p className="-mt-2 max-w-2xl text-sm text-[var(--text-muted)]">
          Prompts you use often. Type / at the start of a message to find one, and fill in its
          blanks. They are plain Markdown files in Pi Local's prompts folder, so you can share them.
        </p>
        {prompts.isError && (
          <ErrorNotice>{errorMessage(prompts.error, 'Prompts could not be read.')}</ErrorNotice>
        )}
        {list.length === 0 && !prompts.isError && (
          <p className="rounded-xl border border-dashed border-[var(--border-subtle)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
            No prompts yet. Add one, or import a file.
          </p>
        )}
        {list.length > 0 && (
          <ul className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-xl border border-[var(--border-subtle)]">
            {list.map((prompt) => (
              <PromptRow
                key={prompt.id}
                prompt={prompt}
                onEdit={() => setEditing(prompt)}
                onDelete={() => setDeleting(prompt)}
              />
            ))}
          </ul>
        )}
        {importError ? (
          <ErrorNotice>
            {importError instanceof ApiError && importError.status === 400
              ? `That file can't be imported: ${importError.message}`
              : errorMessage(importError, 'Not imported.')}
          </ErrorNotice>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus />
            New prompt
          </Button>
          <ImportButton onError={setImportError} />
          <Button
            variant="secondary"
            disabled={list.length === 0 || exportAll.isPending}
            onClick={() =>
              exportAll.mutate(undefined, {
                onSuccess: (where) => where && toast(`Saved ${where}.`),
                onError: (error) =>
                  toast.error(errorMessage(error, 'The prompts could not be saved.')),
              })
            }
          >
            <Download />
            Export all
          </Button>
        </div>
      </SettingsSection>

      {editing && (
        <PromptDialog
          prompt={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.title}”?`}
          description="Its file is removed from the prompts folder."
          action="Delete"
          what="This prompt"
          onConfirm={() => remove.mutateAsync(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
