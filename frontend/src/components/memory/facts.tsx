import { Link } from '@tanstack/react-router';
import { Check, Pencil, Pin, PinOff, Plus, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, type Fact } from '~/api/client';
import { FIELD, RequestError } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useAgent, useAgentThreads } from '~/hooks/use-agents';
import { useAddFact, useDeleteFact, useUpdateFact } from '~/hooks/use-memory';
import { categoryLabel, groupFacts } from '~/lib/memory';
import { cn } from '~/lib/utils';

const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const LINK =
  'text-[var(--text-secondary)] underline decoration-[var(--border-strong)] underline-offset-4 hover:text-[var(--text-primary)] hover:decoration-current';

/** Where a fact came from: "Saved by Hardac · in Trip planning", or "Added by you". */
export function FactOrigin({ fact }: { fact: Fact }) {
  const agentId = fact.sourceAgent ?? undefined;
  const agent = useAgent(agentId);
  const threads = useAgentThreads(agentId, Boolean(agent && fact.sourceThread));
  if (!agentId) return <span>Added by you</span>;
  const title = threads.data?.find((thread) => thread.threadId === fact.sourceThread)?.title;
  return (
    <span>
      Saved by {agent?.name ?? 'an agent that was deleted'}
      {agent && fact.sourceThread && (
        <>
          {' · in '}
          <Link
            to="/agents/$agentId/threads/$threadId"
            params={{ agentId: agent.id, threadId: fact.sourceThread }}
            className={LINK}
          >
            {title || 'Open'}
          </Link>
        </>
      )}
    </span>
  );
}

function ExternalBadge({ fact }: { fact: Fact }) {
  if (fact.trust !== 'external') return null;
  return (
    <span
      title="It came from a web page, an email, a file or a tool's result, not from you. Agents don't see it until you accept it, and it never joins what they always know."
      className="rounded-full bg-[var(--warning)]/15 px-2 py-0.5 text-[0.6875rem] font-medium text-[var(--warning)]"
    >
      From outside text
    </span>
  );
}

/** A fact's text and category, being changed. */
function FactEditor({
  fact,
  categories,
  saveLabel,
  busy,
  error,
  onSave,
  onCancel,
}: {
  fact: Fact;
  categories: readonly string[];
  saveLabel: string;
  busy: boolean;
  error: unknown;
  onSave: (change: { text: string; category: string }) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [text, setText] = useState(fact.text);
  const [category, setCategory] = useState(fact.category);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() && !busy) onSave({ text: text.trim(), category });
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor={`${id}-category`} className="sr-only">
          Category
        </label>
        <select
          id={`${id}-category`}
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className={cn(FIELD, 'sm:w-40')}
        >
          {categories.map((candidate) => (
            <option key={candidate} value={candidate}>
              {categoryLabel(candidate)}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-text`} className="sr-only">
          What it says
        </label>
        <input
          id={`${id}-text`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={500}
          // biome-ignore lint/a11y/noAutofocus: the person just chose to edit it
          autoFocus
          className={cn(FIELD, 'flex-1')}
        />
      </div>
      <RequestError error={error} what="It" />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={!text.trim() || busy}>
          {busy && <Spinner className="size-3.5 text-current" />}
          {saveLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A known fact: its text, where it came from, and pin, edit and delete. */
function FactRow({ fact, categories }: { fact: Fact; categories: readonly string[] }) {
  const [editing, setEditing] = useState(false);
  const update = useUpdateFact();
  const remove = useDeleteFact();
  const add = useAddFact();
  const name = `"${clip(fact.text)}"`;
  // Deleting is for good on the server; Undo adds the same fact again (pinned as it was).
  // The row is gone by then, so the outcome is read from the promises, not from this component.
  const restore = () =>
    void add.mutateAsync({ category: fact.category, text: fact.text, pinned: fact.pinned }).then(
      () => toast('Restored.'),
      (error) => toast.error(errorMessage(error, 'Not restored.')),
    );
  if (editing)
    return (
      <li className="px-4 py-3">
        <FactEditor
          fact={fact}
          categories={categories}
          saveLabel="Save"
          busy={update.isPending}
          error={update.error}
          onCancel={() => {
            setEditing(false);
            update.reset();
          }}
          onSave={(change) =>
            void update.mutateAsync({ id: fact.id, ...change }).then(
              () => {
                setEditing(false);
                toast('Saved.');
              },
              () => undefined,
            )
          }
        />
      </li>
    );
  return (
    <li className="flex items-start gap-3 px-4 py-3" data-fact-id={fact.id}>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-[var(--text-primary)]">
          {fact.pinned && (
            <Pin
              className="mr-1.5 inline size-3.5 -translate-y-px text-[var(--accent-bright)]"
              aria-label="Pinned"
            />
          )}
          {fact.text}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">
          <FactOrigin fact={fact} />
          <ExternalBadge fact={fact} />
        </p>
      </div>
      <div className="flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={fact.pinned ? `Unpin ${name}` : `Pin ${name}`}
          aria-pressed={fact.pinned}
          title={fact.pinned ? 'Unpin' : 'Pin: agents always see it first'}
          disabled={update.isPending}
          onClick={() =>
            update.mutate(
              { id: fact.id, pinned: !fact.pinned },
              { onError: (error) => toast.error(errorMessage(error, 'Not changed.')) },
            )
          }
        >
          {fact.pinned ? <PinOff /> : <Pin />}
        </Button>
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
            void remove.mutateAsync(fact.id).then(
              () =>
                toast('Deleted.', { duration: 8000, action: { label: 'Undo', onClick: restore } }),
              (error) => toast.error(errorMessage(error, 'Not deleted.')),
            )
          }
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

/** Known facts, by category. */
export function FactList({
  facts,
  categories,
}: {
  facts: readonly Fact[];
  categories: readonly string[];
}) {
  const groups = groupFacts(facts, categories);
  if (groups.length === 0)
    return (
      <p className="text-sm text-[var(--text-muted)]">
        Nothing yet. Tell an agent something about yourself, or add it below.
      </p>
    );
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <section key={group.category} aria-label={categoryLabel(group.category)}>
          <h3 className="mb-2 text-sm font-semibold">{categoryLabel(group.category)}</h3>
          <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
            {group.facts.map((fact) => (
              <FactRow key={fact.id} fact={fact} categories={categories} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** A suggestion: accept it, change it and accept it, or dismiss it. */
function SuggestionRow({ fact, categories }: { fact: Fact; categories: readonly string[] }) {
  const [editing, setEditing] = useState(false);
  const update = useUpdateFact();
  const remove = useDeleteFact();
  const name = `"${clip(fact.text)}"`;
  const accept = (change: { text?: string; category?: string } = {}) =>
    void update.mutateAsync({ id: fact.id, ...change, accept: true }).then(
      () => toast('Accepted. Agents know it now.'),
      (error) => {
        if (!editing) toast.error(errorMessage(error, 'Not accepted.'));
      },
    );
  if (editing)
    return (
      <li className="px-4 py-3">
        <FactEditor
          fact={fact}
          categories={categories}
          saveLabel="Save and accept"
          busy={update.isPending}
          error={update.error}
          onCancel={() => {
            setEditing(false);
            update.reset();
          }}
          onSave={(change) => accept(change)}
        />
      </li>
    );
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start" data-fact-id={fact.id}>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-[var(--text-primary)]">{fact.text}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">
          <span>{categoryLabel(fact.category)}</span>
          <span aria-hidden="true">·</span>
          <FactOrigin fact={fact} />
          <ExternalBadge fact={fact} />
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="primary"
          aria-label={`Accept ${name}`}
          disabled={update.isPending || remove.isPending}
          onClick={() => accept()}
        >
          <Check />
          Accept
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          aria-label={`Edit then accept ${name}`}
          disabled={update.isPending || remove.isPending}
          onClick={() => setEditing(true)}
        >
          <Pencil />
          Edit then accept
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Dismiss ${name}`}
          disabled={update.isPending || remove.isPending}
          onClick={() =>
            remove.mutate(fact.id, {
              onSuccess: () => toast('Dismissed.'),
              onError: (error) => toast.error(errorMessage(error, 'Not dismissed.')),
            })
          }
        >
          <X />
          Dismiss
        </Button>
      </div>
    </li>
  );
}

export function SuggestionList({
  facts,
  categories,
}: {
  facts: readonly Fact[];
  categories: readonly string[];
}) {
  return (
    <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--accent-bright)]/30 bg-[var(--accent)]/5">
      {[...facts]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((fact) => (
          <SuggestionRow key={fact.id} fact={fact} categories={categories} />
        ))}
    </ul>
  );
}

/** Something the person adds about themselves: known at once. */
export function AddFactForm({ categories }: { categories: readonly string[] }) {
  const id = useId();
  const [category, setCategory] = useState(categories[0] ?? 'preferences');
  const [text, setText] = useState('');
  const add = useAddFact();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const value = text.trim();
        if (!value || add.isPending) return;
        void add.mutateAsync({ category, text: value }).then(
          () => {
            setText('');
            toast('Added.');
          },
          () => undefined,
        );
      }}
    >
      <p className="text-sm font-medium">Add something</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor={`${id}-category`} className="sr-only">
          Category
        </label>
        <select
          id={`${id}-category`}
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className={cn(FIELD, 'sm:w-40')}
        >
          {categories.map((candidate) => (
            <option key={candidate} value={candidate}>
              {categoryLabel(candidate)}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-text`} className="sr-only">
          Something about you
        </label>
        <input
          id={`${id}-text`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Prefers meetings after 10 a.m."
          maxLength={500}
          className={cn(FIELD, 'flex-1')}
        />
        <Button
          type="submit"
          variant="secondary"
          className="h-10"
          disabled={!text.trim() || add.isPending}
        >
          {add.isPending ? <Spinner className="size-4 text-current" /> : <Plus />}
          Add
        </Button>
      </div>
      <RequestError error={add.error} what="It" />
    </form>
  );
}
