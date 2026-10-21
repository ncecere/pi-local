import { Link } from '@tanstack/react-router';
import { Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { type Agent, errorMessage, type MemoryNote } from '~/api/client';
import { Panel } from '~/components/agent-manager/panel';
import { AgentMemoryAccess } from '~/components/memory/memory-access';
import { ConfirmDialog, ErrorNotice, FIELD, RequestError } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import {
  memoryOf,
  useAddNote,
  useAgentNotes,
  useDeleteNote,
  useResetNotes,
  useUpdateNote,
  useYou,
} from '~/hooks/use-memory';
import { DEFAULT_SHAREABLE } from '~/lib/memory';
import { cn } from '~/lib/utils';

const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

const LINK = 'text-[var(--accent-bright)] underline-offset-4 hover:underline';

/**
 * Settings → Agents → an agent → Memory: whether it remembers, what it sees
 * about the person, and its own notes about its job (newest first).
 */
export function MemoryTab({ agent }: { agent: Agent }) {
  const you = useYou();
  const shareable = you.data?.shareable ?? DEFAULT_SHAREABLE;
  const off = memoryOf(agent).off;
  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Memory"
        description={
          <>
            What {agent.name} knows about you comes from{' '}
            <Link to="/settings/you" className={LINK}>
              Settings → You
            </Link>
            . It also keeps notes about its own work: what works, what to avoid, where things are.
            Both stay on this computer and go only to its model provider.
          </>
        }
      >
        <AgentMemoryAccess agent={agent} shareable={shareable} />
      </Panel>
      <NotesPanel agent={agent} off={off} />
    </div>
  );
}

function NotesPanel({ agent, off }: { agent: Agent; off: boolean }) {
  const notes = useAgentNotes(agent.id);
  const reset = useResetNotes();
  const [resetting, setResetting] = useState(false);
  const count = notes.data?.length ?? 0;
  return (
    <Panel
      title="Its notes"
      description={
        off
          ? "Memory is off: it keeps these but doesn't read them or add to them."
          : `What ${agent.name} learned about its job. It reads them in every conversation.`
      }
      actions={
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={count === 0}
          onClick={() => setResetting(true)}
        >
          <RotateCcw />
          Reset memory
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <AddNoteForm agentId={agent.id} />
        {notes.isError ? (
          <ErrorNotice>{errorMessage(notes.error, 'Its notes could not be read.')}</ErrorNotice>
        ) : !notes.data ? (
          <Spinner />
        ) : notes.data.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No notes yet.</p>
        ) : (
          <ul
            aria-label="Notes"
            className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]"
          >
            {notes.data.map((note) => (
              <NoteRow key={note.id} agentId={agent.id} note={note} />
            ))}
          </ul>
        )}
      </div>
      {resetting && (
        <ConfirmDialog
          title={`Reset ${agent.name}'s memory?`}
          description={`It forgets all ${count === 1 ? 'its note' : `${count} of its notes`}. What it knows about you stays (Settings → You). This can't be undone.`}
          action="Reset memory"
          what="Its memory"
          onConfirm={async () => {
            await reset.mutateAsync({ agentId: agent.id });
            toast(`${agent.name}'s notes are reset.`);
          }}
          onClose={() => setResetting(false)}
        />
      )}
    </Panel>
  );
}

function AddNoteForm({ agentId }: { agentId: string }) {
  const id = useId();
  const [text, setText] = useState('');
  const add = useAddNote();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const value = text.trim();
        if (!value || add.isPending) return;
        void add.mutateAsync({ agentId, text: value }).then(
          () => {
            setText('');
            toast('Note added.');
          },
          () => undefined,
        );
      }}
    >
      <label htmlFor={`${id}-text`} className="sr-only">
        New note
      </label>
      <div className="flex gap-2">
        <input
          id={`${id}-text`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="The weekly report is due Fridays at noon."
          maxLength={1000}
          className={cn(FIELD, 'flex-1')}
        />
        <Button
          type="submit"
          variant="secondary"
          className="h-10 shrink-0"
          disabled={!text.trim() || add.isPending}
        >
          {add.isPending ? <Spinner className="size-4 text-current" /> : <Plus />}
          Add note
        </Button>
      </div>
      <RequestError error={add.error} what="The note" />
    </form>
  );
}

function NoteRow({ agentId, note }: { agentId: string; note: MemoryNote }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const update = useUpdateNote();
  const remove = useDeleteNote();
  const name = `"${clip(note.text)}"`;
  if (editing)
    return (
      <li className="px-4 py-3">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = text.trim();
            if (!value || update.isPending) return;
            void update.mutateAsync({ agentId, id: note.id, text: value }).then(
              () => {
                setEditing(false);
                toast('Note saved.');
              },
              () => undefined,
            );
          }}
        >
          <label htmlFor={`${id}-edit`} className="sr-only">
            Note
          </label>
          <input
            id={`${id}-edit`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={1000}
            // biome-ignore lint/a11y/noAutofocus: the person just chose to edit it
            autoFocus
            className={FIELD}
          />
          <RequestError error={update.error} what="The note" />
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!text.trim() || update.isPending}
            >
              {update.isPending && <Spinner className="size-3.5 text-current" />}
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setText(note.text);
                setEditing(false);
                update.reset();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </li>
    );
  return (
    <li className="flex items-start gap-3 px-4 py-3" data-note-id={note.id}>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-[var(--text-primary)]">{note.text}</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          {dateFormat.format(new Date(note.updatedAt))}
          {note.thread && (
            <>
              {' · '}
              <Link
                to="/agents/$agentId/threads/$threadId"
                params={{ agentId, threadId: note.thread }}
                className="underline decoration-[var(--border-strong)] underline-offset-4 hover:text-[var(--text-primary)]"
              >
                Open the conversation
              </Link>
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit ${name}`}
          title="Edit"
          onClick={() => setEditing(true)}
        >
          <Pencil />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${name}`}
          title="Delete"
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(
              { agentId, id: note.id },
              {
                onSuccess: () => toast('Note deleted.'),
                onError: (error) => toast.error(errorMessage(error, 'Not deleted.')),
              },
            )
          }
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}
