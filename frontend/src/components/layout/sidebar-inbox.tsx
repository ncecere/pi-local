import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Clock,
  Ellipsis,
  type LucideIcon,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  Undo2,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { Agent } from '~/api/client';
import { AgentAvatar } from '~/components/agent/agent-avatar';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Spinner } from '~/components/ui/spinner';
import { useDeleteThread, useRenameThread } from '~/hooks/use-agents';
import { type InboxActions, useInbox, useInboxActions } from '~/hooks/use-inbox';
import { searchable, useMessageSearch } from '~/hooks/use-message-search';
import { keepFocusWhenRemoved } from '~/lib/focus-return';
import {
  activityAt,
  type InboxEntry,
  needsAttention,
  type Sections,
  STATUS_LABEL,
  snoozePresets,
  type ThreadMeta,
  untilLabel,
} from '~/lib/inbox';
import { matchInboxShortcut } from '~/lib/inbox-shortcuts';
import { nextPage, PAGE_SIZE, visibleOf } from '~/lib/paging';
import { splitSnippet } from '~/lib/snippet';
import { cn } from '~/lib/utils';

/** Which shelves are open, remembered in this browser. They start closed. */
const SHELVES_KEY = 'pai.inbox.shelves';
function useShelf(id: string): [boolean, (open: boolean) => void] {
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(SHELVES_KEY) ?? '{}')[id] === true;
    } catch {
      return false;
    }
  };
  const [open, setOpen] = useState(read);
  return [
    open,
    (next) => {
      setOpen(next);
      try {
        const all = JSON.parse(localStorage.getItem(SHELVES_KEY) ?? '{}');
        localStorage.setItem(SHELVES_KEY, JSON.stringify({ ...all, [id]: next }));
      } catch {
        // Storage blocked: lasts for this page only.
      }
    },
  ];
}

/**
 * The sidebar: every conversation of every agent, sorted by what it needs.
 * Pinned, then Working, then the Inbox; Snoozed, Done and Archived are shelves
 * that start closed. A change says what it did, with Undo.
 */
export function SidebarInbox({ filter }: { filter: string }) {
  const inbox = useInbox();
  const actions = useInboxActions();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { agentId?: string; threadId?: string };
  const openKey = params.agentId && params.threadId ? `${params.agentId}/${params.threadId}` : null;
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const multi = inbox.agents.length > 1;
  const agents = new Map(inbox.agents.map((agent) => [agent.id, agent]));

  const query = filter.trim().toLowerCase();
  const show = (entry: InboxEntry) =>
    (!agentFilter || entry.agentId === agentFilter) &&
    (!query || entry.title.toLowerCase().includes(query));
  const sections: Sections = {
    pinned: inbox.sections.pinned.filter(show),
    working: inbox.sections.working.filter(show),
    inbox: inbox.sections.inbox.filter(show),
    snoozed: inbox.sections.snoozed.filter(show),
    done: inbox.sections.done.filter(show),
    archived: inbox.sections.archived.filter(show),
  };
  const active = [...sections.pinned, ...sections.working, ...sections.inbox];

  // Messages whose text holds the query (the messageSearch feature), beyond the titles that do.
  const messages = useMessageSearch(filter);
  const byKey = new Map(inbox.entries.map((entry) => [entry.key, entry]));
  const titled = new Set(
    [
      ...sections.pinned,
      ...sections.working,
      ...sections.inbox,
      ...sections.snoozed,
      ...sections.done,
      ...sections.archived,
    ].map((entry) => entry.key),
  );
  const inMessages = messages.hits
    .map((hit) => ({ hit, entry: byKey.get(`${hit.agentId}/${hit.threadId}`) }))
    .filter(
      (found): found is { hit: (typeof messages.hits)[number]; entry: InboxEntry } =>
        found.entry !== undefined && (!agentFilter || found.entry.agentId === agentFilter),
    );
  const messageOnly = inMessages.filter(({ entry }) => !titled.has(entry.key));

  /** Said, with a way back. */
  const undoable = (message: string, key: string, apply: () => ThreadMeta | undefined) => {
    const before = apply();
    toast(message, {
      duration: 6000,
      action: { label: 'Undo', onClick: () => actions.restore(key, before) },
    });
  };

  /** After finishing with the conversation on screen: the next one, or a new chat. */
  const advanceFrom = (entry: InboxEntry) => {
    if (openKey !== entry.key) return;
    const index = active.findIndex((candidate) => candidate.key === entry.key);
    const next = active
      .slice(index + 1)
      .concat(active.slice(0, Math.max(index, 0)))
      .find((c) => c.key !== entry.key);
    if (next)
      void navigate({
        to: '/agents/$agentId/threads/$threadId',
        params: { agentId: next.agentId, threadId: next.threadId },
      });
    else void navigate({ to: '/', search: { agent: entry.agentId } });
  };

  // Inbox shortcuts (lib/inbox-shortcuts.ts). The latest state is read through a ref.
  const latest = useRef({
    active,
    entries: inbox.entries,
    openKey,
    undoable,
    advanceFrom,
    actions,
    navigate,
    now: inbox.now,
  });
  latest.current = {
    active,
    entries: inbox.entries,
    openKey,
    undoable,
    advanceFrom,
    actions,
    navigate,
    now: inbox.now,
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const shortcut = matchInboxShortcut(event);
      if (!shortcut) return;
      const { active, entries, openKey, undoable, advanceFrom, actions, navigate, now } =
        latest.current;
      const open = entries.find((entry) => entry.key === openKey);
      const go = (entry: InboxEntry | undefined) =>
        entry &&
        void navigate({
          to: '/agents/$agentId/threads/$threadId',
          params: { agentId: entry.agentId, threadId: entry.threadId },
        });
      const at = active.findIndex((entry) => entry.key === openKey);
      event.preventDefault();
      if (shortcut === 'next') go(at < 0 ? active[0] : active[at + 1]);
      else if (shortcut === 'previous') go(at < 0 ? active.at(-1) : active[at - 1]);
      else if (shortcut === 'next-attention') {
        const after = [...active.slice(at + 1), ...active.slice(0, Math.max(at, 0))];
        const target = after.find((entry) => needsAttention(entry.meta, now));
        if (target) go(target);
        else toast('Nothing else needs you.');
      } else if (!open) toast('Open a conversation first.');
      else if (shortcut === 'settle') {
        if (open.status === 'working') return void toast('It is still working: stop it first.');
        undoable('Settled', open.key, () => actions.settle(open.key));
        advanceFrom(open);
      } else if (shortcut === 'pin')
        undoable(open.bucket === 'pinned' ? 'Unpinned' : 'Pinned', open.key, () =>
          open.bucket === 'pinned' ? actions.unpin(open.key) : actions.pin(open.key),
        );
      else if (shortcut === 'unread')
        undoable('Marked unread', open.key, () => actions.markUnread(open.key));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (inbox.loading)
    return (
      <div className="py-8">
        <Spinner className="mx-auto" />
      </div>
    );
  if (inbox.failed)
    return (
      <p className="px-2.5 py-1 text-xs text-[var(--text-muted)]">
        Conversations could not be loaded.
      </p>
    );
  if (inbox.agents.length === 0)
    return (
      <p className="px-2 py-8 text-center text-xs text-[var(--text-muted)]">
        Your agents will appear here.
      </p>
    );
  if (inbox.entries.length === 0)
    return (
      <p className="px-2 py-8 text-center text-xs text-[var(--text-muted)]">
        Your conversations will appear here.
      </p>
    );

  const row = (entry: InboxEntry) => {
    const agent = agents.get(entry.agentId);
    return agent ? (
      <li key={entry.key}>
        <InboxRow
          entry={entry}
          agent={agent}
          active={openKey === entry.key}
          showAgent={multi}
          now={inbox.now}
          actions={actions}
          undoable={undoable}
          advance={() => advanceFrom(entry)}
        />
      </li>
    ) : null;
  };
  const list = (entries: InboxEntry[], label: string) =>
    entries.length > 0 && (
      <PagedList
        entries={entries}
        label={label}
        openKey={openKey}
        resetKey={`${query}|${agentFilter ?? ''}`}
        row={row}
      />
    );

  return (
    <div className="flex flex-col gap-3">
      {multi && (
        <fieldset className="m-0 flex flex-wrap gap-1 border-0 p-0">
          <legend className="sr-only">Show conversations with</legend>
          {[
            { id: null, name: 'All' },
            ...inbox.agents.map((agent) => ({ id: agent.id, name: agent.name })),
          ].map((option) => (
            <button
              key={option.id ?? 'all'}
              type="button"
              aria-pressed={agentFilter === option.id}
              onClick={() => setAgentFilter(option.id)}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs transition-colors',
                agentFilter === option.id
                  ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                  : 'bg-[var(--bg-control)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              {option.name}
            </button>
          ))}
        </fieldset>
      )}

      {messages.enabled && searchable(filter) && (
        <section aria-labelledby="inbox-messages">
          <Heading id="inbox-messages">In messages</Heading>
          {messageOnly.length > 0 ? (
            <ul aria-label="Conversations whose messages match" className="flex flex-col gap-px">
              {messageOnly.map(({ hit, entry }) => (
                <li key={entry.key}>
                  <Link
                    to="/agents/$agentId/threads/$threadId"
                    params={{ agentId: entry.agentId, threadId: entry.threadId }}
                    aria-current={openKey === entry.key ? 'page' : undefined}
                    className="flex flex-col gap-0.5 rounded-md px-2.5 py-1.5 outline-none hover:bg-[var(--sidebar-row-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-bright)]"
                  >
                    <span dir="auto" className="truncate text-sm text-[var(--text-primary)]">
                      {entry.title}
                    </span>
                    <Snippet text={hit.snippet} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status" className="px-2.5 py-1.5 text-xs text-[var(--text-muted)]">
              {messages.pending ? 'Searching…' : 'No messages match.'}
            </p>
          )}
          <p className="px-2.5 pt-1 text-[0.6875rem] text-[var(--text-muted)]">
            Only conversations opened in this app are searched.
          </p>
        </section>
      )}
      {sections.pinned.length > 0 && (
        <section aria-labelledby="inbox-pinned">
          <Heading id="inbox-pinned">Pinned</Heading>
          {list(sections.pinned, 'Pinned conversations')}
        </section>
      )}
      {sections.working.length > 0 && (
        <section aria-labelledby="inbox-working">
          <Heading id="inbox-working">Working</Heading>
          {list(sections.working, 'Conversations the agent is working on')}
        </section>
      )}
      <section aria-labelledby="inbox-inbox">
        <Heading id="inbox-inbox">Inbox</Heading>
        {sections.inbox.length > 0 ? (
          list(sections.inbox, 'Inbox')
        ) : (
          <p className="px-2.5 py-1.5 text-xs text-[var(--text-muted)]">
            {query || agentFilter ? 'No conversations match.' : 'All caught up.'}
          </p>
        )}
      </section>

      <div className="flex flex-col gap-1">
        <Shelf
          id="snoozed"
          label="Snoozed"
          entries={sections.snoozed}
          openKey={openKey}
          forceOpen={query !== ''}
          render={list}
        />
        <Shelf
          id="done"
          label="Settled"
          entries={sections.done}
          openKey={openKey}
          forceOpen={query !== ''}
          render={list}
        />
        <Shelf
          id="archived"
          label="Archived"
          entries={sections.archived}
          openKey={openKey}
          forceOpen={query !== ''}
          render={list}
        />
      </div>
    </div>
  );
}

/**
 * A list drawn a page at a time (lib/paging.ts). The open conversation stays drawn wherever it is in the
 * list, and starting a search or choosing another agent starts again from the first page.
 */
function PagedList({
  entries,
  label,
  openKey,
  resetKey,
  row,
}: {
  entries: InboxEntry[];
  label: string;
  openKey: string | null;
  resetKey: string;
  row: (entry: InboxEntry) => ReactNode;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new search or agent starts from the first page
  useEffect(() => setLimit(PAGE_SIZE), [resetKey]);
  const shown = visibleOf(entries, limit, openKey);
  const hidden = entries.length - shown.length;
  return (
    <>
      <ul aria-label={label} className="flex flex-col gap-px">
        {shown.map(row)}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setLimit((current) => current + PAGE_SIZE)}
          className="mt-0.5 flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-row-hover)] hover:text-[var(--text-primary)]"
        >
          Show {nextPage(hidden)} more
          <span className="text-[var(--text-muted)]">· {hidden} not shown</span>
        </button>
      )}
    </>
  );
}

/** A line from a message, the words that matched in <mark> (lib/snippet.ts). */
function Snippet({ text }: { text: string }) {
  return (
    <span dir="auto" className="line-clamp-2 text-xs text-[var(--text-muted)]">
      {splitSnippet(text).map((part) =>
        part.match ? (
          <mark
            key={part.at}
            className="rounded-sm bg-[var(--accent-soft)] px-0.5 text-[var(--text-primary)]"
          >
            {part.text}
          </mark>
        ) : (
          <span key={part.at}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function Heading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-2 px-2">
      <h2 id={id} className="text-xs font-medium text-[var(--text-muted)]">
        {children}
      </h2>
      <span aria-hidden="true" className="h-px flex-1 bg-[var(--border-subtle)]" />
    </div>
  );
}

const STATUS_TONE: Record<NonNullable<InboxEntry['status']>, string> = {
  working: 'text-[var(--status-working)]',
  failed: 'text-[var(--danger)]',
  unread: 'text-[var(--success)]',
  woke: 'text-[var(--warning)]',
};

const STATUS_ICON: Record<NonNullable<InboxEntry['status']>, LucideIcon> = {
  working: CircleDashed,
  failed: CircleAlert,
  unread: CircleCheck,
  woke: AlarmClock,
};

/** "now", "5m", "3h", "2d": as t3code's rows say it. */
export function compactAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "12s", "4m", "1h 5m": how long the agent has been working, ticking. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="tabular-nums">{formatElapsed(now - since)}</span>;
}

/** A collapsible section. Closed, it still shows the conversation that is open, so it never vanishes from under you. */
function Shelf({
  id,
  label,
  entries,
  openKey,
  forceOpen = false,
  render,
}: {
  id: string;
  label: string;
  entries: InboxEntry[];
  openKey: string | null;
  /** A search is under way: what it found is shown, not hidden behind a closed shelf. */
  forceOpen?: boolean;
  render: (entries: InboxEntry[], label: string) => ReactNode;
}) {
  const [chosen, setOpen] = useShelf(id);
  const open = chosen || forceOpen;
  if (entries.length === 0) return null;
  const current = entries.filter((entry) => entry.key === openKey);
  const panel = `inbox-shelf-${id}`;
  return (
    <section aria-label={label}>
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <ChevronRight
            className={cn(
              'size-3 transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
            aria-hidden="true"
          />
          <span>
            {label}
            {!open && <span className="font-normal"> ({entries.length})</span>}
          </span>
          <span aria-hidden="true" className="h-px flex-1 bg-[var(--border-subtle)]" />
        </button>
      </h2>
      <div id={panel} className="mt-0.5">
        {open ? render(entries, label) : render(current, label)}
      </div>
    </section>
  );
}

/**
 * A row's corner (its status, a snooze's time left, when it was settled) gives way to the actions
 * that appear over it on hover or focus. On a touch screen, where "…" is always there, it keeps
 * clear of it instead: room for the button, so nothing is drawn over the text.
 */
const CORNER =
  'transition-opacity group-focus-within:opacity-0 group-hover:opacity-0 pointer-coarse:mr-7';

const ICON_BUTTON =
  'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-row-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40';

/** The status in a row's corner: an icon and a word, as t3code's. */
function StatusBadge({
  status,
  workingSince,
}: {
  status: NonNullable<InboxEntry['status']>;
  workingSince?: number;
}) {
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={cn('flex shrink-0 items-center gap-1 text-xs font-medium', STATUS_TONE[status])}
    >
      <Icon
        className={cn(
          'size-4',
          status === 'working' && 'motion-safe:animate-[spin_3s_linear_infinite]',
        )}
        aria-hidden="true"
      />
      {STATUS_LABEL[status]}
      {status === 'working' && workingSince !== undefined && (
        <span className="font-normal">
          <Elapsed since={workingSince} />
        </span>
      )}
    </span>
  );
}

const whenLabel = (until: number) =>
  new Date(until).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Names a conversation: the platform's title is the start of its first message. */
function RenameDialog({
  agentId,
  threadId,
  title,
  onClose,
}: {
  agentId: string;
  threadId: string;
  title: string;
  onClose: () => void;
}) {
  const rename = useRenameThread();
  const [value, setValue] = useState(title);
  const name = value.replace(/\s+/g, ' ').trim();
  const valid = name.length > 0 && name.length <= 200 && name !== title;
  const save = () => {
    if (!valid) return;
    rename.mutate(
      { agentId, threadId, title: name },
      { onError: () => toast.error("The conversation couldn't be renamed. Try again.") },
    );
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename conversation</DialogTitle>
          <DialogDescription>
            The name shows in your sidebar and search, on every device.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input
            aria-label="Conversation name"
            value={value}
            maxLength={200}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setValue(event.target.value)}
            className="h-10 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)]/60 px-3 text-sm"
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!valid}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Snooze until a time of the person's choosing. */
function CustomSnooze({
  onSnooze,
  onClose,
}: {
  onSnooze: (until: number) => void;
  onClose: () => void;
}) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const initial = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const local = (date: Date) =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const [value, setValue] = useState(local(initial));
  const until = new Date(value).getTime();
  const valid = Number.isFinite(until) && until > Date.now();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Snooze until…</DialogTitle>
          <DialogDescription>
            It comes back at this time, or sooner if the agent finishes or fails.
          </DialogDescription>
        </DialogHeader>
        <input
          type="datetime-local"
          aria-label="Snooze until"
          value={value}
          min={local(new Date())}
          onChange={(event) => setValue(event.target.value)}
          className="h-10 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)]/60 px-3 text-sm"
        />
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={() => onSnooze(until)}>
            Snooze
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SnoozeItems({
  now,
  onSnooze,
  onCustom,
}: {
  now: number;
  onSnooze: (until: number) => void;
  onCustom: () => void;
}) {
  return (
    <>
      {snoozePresets(new Date(now)).map((preset) => (
        <DropdownMenuItem
          key={preset.id}
          onSelect={() => onSnooze(preset.until)}
          className="justify-between gap-6"
        >
          {preset.label.replace(' morning', '')}
          <span className="text-xs text-[var(--text-muted)]">{whenLabel(preset.until)}</span>
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onCustom}>Custom…</DropdownMenuItem>
    </>
  );
}

function InboxRow({
  entry,
  agent,
  active,
  now,
  actions,
  undoable,
  advance,
}: {
  entry: InboxEntry;
  agent: Agent;
  active: boolean;
  /** Line 1 always names the agent, as t3code's rows name the project. */
  showAgent?: boolean;
  now: number;
  actions: InboxActions;
  undoable: (message: string, key: string, apply: () => ThreadMeta | undefined) => void;
  advance: () => void;
}) {
  const remove = useDeleteThread();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [custom, setCustom] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // Right-click opens the row's menu, as t3code's context menu.
  const [menuOpen, setMenuOpen] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirming) return;
    // The menu that asked is gone: keep focus on the question.
    confirmButton.current?.focus();
    const timer = setTimeout(() => setConfirming(false), 4_000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const { key, title, bucket, status, meta } = entry;
  const working = status === 'working';
  const pinned = bucket === 'pinned';
  const away = bucket === 'done' || bucket === 'snoozed' || bucket === 'archived';
  // The actions sit over the row's corner. They replace it while hovered or focused (CORNER), and
  // also while a menu from them is open or a delete is being confirmed.
  const covered = menuOpen || confirming;

  const settle = () => {
    undoable('Settled', key, () => actions.settle(key));
    advance();
  };
  const pin = () => undoable('Pinned', key, () => actions.pin(key));
  const unpin = () => undoable('Unpinned', key, () => actions.unpin(key));
  const snooze = (until: number) => {
    setCustom(false);
    undoable(`Snoozed until ${whenLabel(until)}`, key, () => actions.snooze(key, until));
    advance();
  };
  const archive = () => {
    undoable('Archived', key, () => actions.archive(key));
    advance();
  };
  const backToInbox = () => {
    if (bucket === 'archived') actions.unarchive(key);
    else if (bucket === 'snoozed') actions.wake(key);
    else actions.unsettle(key);
  };
  const del = (event: { currentTarget: HTMLElement }) => {
    const rowElement = event.currentTarget.closest<HTMLElement>('[data-focus-row]');
    if (rowElement) keepFocusWhenRemoved(rowElement);
    remove.mutate({ agentId: entry.agentId, threadId: entry.threadId });
    actions.restore(key, undefined);
    if (active) void navigate({ to: '/', search: { agent: entry.agentId } });
  };

  // The corner: a status, the time left on a snooze, or when it was settled.
  const corner =
    bucket === 'snoozed' && meta.snoozedUntil ? (
      <span className="shrink-0 text-xs text-[var(--status-working)] tabular-nums">
        {untilLabel(meta.snoozedUntil, now)}
      </span>
    ) : status ? (
      <StatusBadge status={status} workingSince={meta.workingSince} />
    ) : bucket === 'done' && meta.settledAt ? (
      <span className="shrink-0 text-xs text-[var(--text-muted)] tabular-nums">
        {compactAgo(meta.settledAt, now)}
      </span>
    ) : null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click is a mouse shortcut for the row's "…" button, which keyboards reach.
    <div
      data-focus-row=""
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
      className={cn(
        'group relative flex rounded-md motion-safe:animate-[row-in_150ms_ease-out]',
        'transition-[background-color,opacity] motion-reduce:transition-none',
        active ? 'bg-[var(--sidebar-row-active)]' : 'hover:bg-[var(--sidebar-row-hover)]',
        // Working rows recede until looked at, as in t3code.
        working && !active && 'opacity-70 focus-within:opacity-100 hover:opacity-100',
      )}
    >
      <Link
        to="/agents/$agentId/threads/$threadId"
        params={{ agentId: entry.agentId, threadId: entry.threadId }}
        aria-current={active ? 'page' : undefined}
        title={title}
        className={cn(
          'flex min-w-0 flex-1 rounded-md px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-bright)]',
          away ? 'h-9 items-center gap-2.5' : 'h-[4.875rem] flex-col justify-center gap-0.5 py-2',
        )}
      >
        {away ? (
          <>
            <span dir="auto" className="min-w-0 flex-1 truncate text-sm text-[var(--text-muted)]">
              {title}
            </span>
            <span className={cn(CORNER, covered && 'opacity-0')}>{corner}</span>
          </>
        ) : (
          <>
            {/* Line 1: whose conversation it is, and what it needs. */}
            <span className="flex h-5 min-w-0 items-center gap-1.5">
              {/* Still, like t3code's project icon; only work moves it. The corner says the rest. */}
              <AgentAvatar
                agent={agent}
                size={16}
                state={working ? 'working' : 'idle'}
                frozen={!working}
              />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-secondary)]">
                {agent.name}
              </span>
              <span
                className={cn(CORNER, 'flex shrink-0 items-center gap-1.5', covered && 'opacity-0')}
              >
                {pinned && <Pin className="size-3 text-[var(--text-muted)]" aria-label="Pinned" />}
                {corner}
              </span>
            </span>
            {/* Line 2: the title, brighter when there is something new in it. */}
            <span
              dir="auto"
              className={cn(
                'min-w-0 truncate text-sm',
                status === 'unread' || status === 'woke' || status === 'failed' || active
                  ? 'font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-primary)]/90',
              )}
            >
              {title}
            </span>
            {/* Line 3: when. */}
            <span className="truncate text-xs text-[var(--text-muted)] tabular-nums">
              {compactAgo(activityAt(meta, entry), now)}
            </span>
          </>
        )}
      </Link>

      <div
        className={cn(
          'pointer-events-none absolute right-1.5 flex items-center gap-0.5 opacity-0 transition-opacity motion-reduce:transition-none',
          away ? 'top-1/2 -translate-y-1/2' : 'top-2',
          'group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
          (confirming || menuOpen) && 'pointer-events-auto opacity-100',
          // Touch screens have no hover: the actions are always there.
          'pointer-coarse:pointer-events-auto pointer-coarse:opacity-100',
        )}
      >
        {confirming ? (
          <button
            ref={confirmButton}
            type="button"
            aria-label={`Confirm delete conversation: ${title}`}
            onClick={del}
            className="rounded-md bg-[var(--danger)]/20 px-2 py-0.5 text-xs font-medium text-[var(--danger-on-tint)] hover:bg-[var(--danger)]/30"
          >
            Delete
          </button>
        ) : (
          <>
            {bucket === 'snoozed' ? (
              <button
                type="button"
                aria-label={`Wake now: ${title}`}
                title="Wake now"
                onClick={backToInbox}
                className={ICON_BUTTON}
              >
                <AlarmClockOff className="size-3" />
              </button>
            ) : away ? (
              <button
                type="button"
                aria-label={`${bucket === 'archived' ? 'Restore' : 'Un-settle'}: ${title}`}
                title={bucket === 'archived' ? 'Restore' : 'Un-settle'}
                onClick={backToInbox}
                className={ICON_BUTTON}
              >
                <Undo2 className="size-3.5" />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  aria-label={`${pinned ? 'Unpin' : 'Pin'}: ${title}`}
                  title={pinned ? 'Unpin' : 'Pin'}
                  onClick={pinned ? unpin : pin}
                  className={cn(ICON_BUTTON, 'pointer-coarse:hidden')}
                >
                  {pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Snooze: ${title}`}
                      title="Snooze"
                      className={cn(ICON_BUTTON, 'pointer-coarse:hidden')}
                    >
                      <Clock className="size-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    <SnoozeItems now={now} onSnooze={snooze} onCustom={() => setCustom(true)} />
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  type="button"
                  aria-label={`Settle: ${title}`}
                  title={working ? 'Working: stop it first' : 'Settle'}
                  disabled={working}
                  onClick={settle}
                  className={cn(ICON_BUTTON, 'pointer-coarse:hidden')}
                >
                  <Check className="size-3.5" />
                  Settle
                </button>
              </>
            )}
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`More actions: ${title}`}
                  title="More"
                  className={ICON_BUTTON}
                >
                  <Ellipsis className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {away ? (
                  <DropdownMenuItem onSelect={backToInbox}>
                    {bucket === 'archived' ? (
                      <ArchiveRestore />
                    ) : bucket === 'snoozed' ? (
                      <AlarmClockOff />
                    ) : (
                      <Undo2 />
                    )}
                    {bucket === 'archived'
                      ? 'Restore'
                      : bucket === 'snoozed'
                        ? 'Wake now'
                        : 'Un-settle'}
                  </DropdownMenuItem>
                ) : (
                  <>
                    <DropdownMenuItem disabled={working} onSelect={settle}>
                      <Check />
                      Settle
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Clock />
                        Snooze
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-60">
                        <SnoozeItems now={now} onSnooze={snooze} onCustom={() => setCustom(true)} />
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuItem onSelect={pinned ? unpin : pin}>
                      {pinned ? <PinOff /> : <Pin />}
                      {pinned ? 'Unpin' : 'Pin'}
                    </DropdownMenuItem>
                  </>
                )}
                {bucket !== 'archived' && !working && (
                  <DropdownMenuItem onSelect={() => actions.markUnread(key)}>
                    <CircleDot />
                    Mark unread
                  </DropdownMenuItem>
                )}
                {bucket !== 'archived' && (
                  <DropdownMenuItem disabled={working} onSelect={archive}>
                    <Archive />
                    Archive
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setRenaming(true)}>
                  <Pencil />
                  Rename…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setConfirming(true)}>
                  <Trash2 />
                  Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
      {custom && <CustomSnooze onSnooze={snooze} onClose={() => setCustom(false)} />}
      {renaming && (
        <RenameDialog
          agentId={entry.agentId}
          threadId={entry.threadId}
          title={title}
          onClose={() => setRenaming(false)}
        />
      )}
    </div>
  );
}
