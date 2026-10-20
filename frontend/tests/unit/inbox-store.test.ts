import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inboxActionsFor } from '../../src/hooks/use-inbox';
import {
  InboxStore,
  readThreadCache,
  THREAD_CACHE_LIMIT,
  writeThreadCache,
} from '../../src/lib/inbox-store';

/** A Storage that lives in memory, so two stores can share one "browser". */
function memory(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

let disk: Storage;
beforeEach(() => {
  disk = memory();
});

describe('InboxStore', () => {
  it('saves changes and reads them back in a new session', () => {
    const first = new InboxStore('tim', disk);
    first.set('a/1', { pinnedAt: 5 });
    expect(new InboxStore('tim', disk).get('a/1')).toMatchObject({ pinnedAt: 5 });
  });

  it('keeps people who share a browser apart', () => {
    new InboxStore('tim', disk).set('a/1', { pinnedAt: 5 });
    expect(new InboxStore('bob', disk).getSnapshot()).toEqual({});
  });

  it('forgets a conversation set to nothing, or to a meta with nothing in it', () => {
    const store = new InboxStore('tim', disk);
    store.set('a/1', { pinnedAt: 5 });
    store.set('a/1', { pinnedAt: undefined });
    // A removal is kept as an empty, stamped entry, so it reaches the person's other devices.
    expect(store.get('a/1')).toEqual({ _at: expect.any(Number) });
    store.set('a/2', { pinnedAt: 5 });
    store.set('a/2', undefined);
    expect(
      Object.values(store.getSnapshot()).every((meta) => Object.keys(meta).join() === '_at'),
    ).toBe(true);
    store.set('a/3', undefined); // nothing to remove: nothing recorded
    expect(store.get('a/3')).toBeUndefined();
  });

  it('notifies only when something changed, with a new snapshot each time', () => {
    const store = new InboxStore('tim', disk);
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    store.set('a/1', { pinnedAt: 5 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).not.toBe(before);
    store.set('a/1', { pinnedAt: 5 }); // the same again
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives unreadable or foreign saved data', () => {
    disk.setItem('pai.inbox.tim', '{not json');
    expect(new InboxStore('tim', disk).getSnapshot()).toEqual({});
    disk.setItem('pai.inbox.tim', JSON.stringify({ v: 99, threads: { 'a/1': {} } }));
    expect(new InboxStore('tim', disk).getSnapshot()).toEqual({});
  });

  it('works when storage is unavailable, for the life of the page', () => {
    const store = new InboxStore('tim', null);
    store.set('a/1', { pinnedAt: 5 });
    expect(store.get('a/1')).toMatchObject({ pinnedAt: 5 });
  });

  it('clears everything of a person', () => {
    const store = new InboxStore('tim', disk);
    store.set('a/1', { pinnedAt: 5 });
    store.clear();
    expect(store.getSnapshot()).toEqual({});
    expect(new InboxStore('tim', disk).getSnapshot()).toEqual({});
  });

  describe('prune', () => {
    const NOW = 1_000_000_000;
    const GRACE = 10 * 60_000;

    it('forgets old state of conversations the list no longer has', () => {
      const store = new InboxStore('tim', disk);
      store.set('a/gone', { visitedAt: NOW - GRACE - 1 });
      store.set('a/here', { visitedAt: NOW - GRACE - 1 });
      store.set('b/other', { visitedAt: NOW - GRACE - 1 });
      store.prune('a', new Set(['here']), NOW, GRACE);
      expect(Object.keys(store.getSnapshot()).sort()).toEqual(['a/here', 'b/other']);
    });

    it('keeps recent state: a new conversation may not be listed yet', () => {
      const store = new InboxStore('tim', disk);
      store.set('a/new', { workingSince: NOW - 1000 });
      store.prune('a', new Set(), NOW, GRACE);
      expect(store.get('a/new')).toBeDefined();
    });
  });
});

describe('between devices', () => {
  it('takes the later change of each conversation, and says when it holds newer ones', () => {
    const laptop = new InboxStore('tim', memory());
    const phone = new InboxStore('tim', memory());
    laptop.set('a/1', { pinnedAt: 1 });
    phone.set('a/2', { settledAt: 2 });
    expect(phone.merge(laptop.exportAll(), laptop.since)).toBe(true); // the phone has a/2, the laptop does not
    expect(laptop.merge(phone.exportAll(), phone.since)).toBe(false);
    expect(laptop.get('a/2')).toMatchObject({ settledAt: 2 });
    expect(phone.get('a/1')).toMatchObject({ pinnedAt: 1 });
  });

  it('carries a removal over, rather than bringing the old state back', async () => {
    const laptop = new InboxStore('tim', memory());
    const phone = new InboxStore('tim', memory());
    laptop.set('a/1', { pinnedAt: 1 });
    phone.merge(laptop.exportAll());
    await new Promise((resolve) => setTimeout(resolve, 2));
    phone.set('a/1', { pinnedAt: undefined }); // unpinned on the phone, later
    laptop.merge(phone.exportAll());
    expect(laptop.get('a/1')?.pinnedAt).toBeUndefined();
  });

  it('forgets removals once every device has had a month to learn of them', () => {
    const store = new InboxStore('tim', memory());
    store.set('a/1', { pinnedAt: 1 });
    store.set('a/1', undefined);
    expect(Object.keys(store.exportAll())).toEqual(['a/1']);
    expect(Object.keys(store.exportAll(Date.now() + 31 * 24 * 60 * 60 * 1000))).toEqual([]);
  });
});

describe('inboxActionsFor', () => {
  it('returns what was there before, so a change can be undone', () => {
    const store = new InboxStore('tim', disk);
    const actions = inboxActionsFor(store);
    actions.pin('a/1');
    const before = actions.settle('a/1');
    expect(before?.pinnedAt).toBeDefined();
    expect(store.get('a/1')?.settledAt).toBeDefined();
    actions.restore('a/1', before);
    // Everything but the change stamp, which is the time of the restore.
    expect({ ...store.get('a/1'), _at: 0 }).toEqual({ ...before, _at: 0 });
  });

  it('does not save a visit again and again while a conversation streams', () => {
    const store = new InboxStore('tim', disk);
    const listener = vi.fn();
    store.subscribe(listener);
    const actions = inboxActionsFor(store);
    actions.visit('a/1');
    for (let i = 0; i < 50; i++) actions.visit('a/1');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('sees a reply that finished while it was open, at once', () => {
    const store = new InboxStore('tim', disk);
    const actions = inboxActionsFor(store);
    actions.visit('a/1');
    actions.working('a/1');
    actions.finished('a/1', false);
    expect(store.get('a/1')).toMatchObject({ completedAt: expect.any(Number) });
    actions.visit('a/1'); // not throttled: there is something new to see
    const meta = store.get('a/1')!;
    expect(meta.visitedAt!).toBeGreaterThanOrEqual(meta.completedAt!);
  });
});

describe('when the inbox began', () => {
  it('is set once, kept, and the earliest of two devices wins', () => {
    const disk = new Map<string, string>();
    const storage = {
      getItem: (key: string) => disk.get(key) ?? null,
      setItem: (key: string, value: string) => void disk.set(key, value),
      removeItem: (key: string) => void disk.delete(key),
    } as unknown as Storage;
    const first = new InboxStore('tim', storage);
    const since = first.since;
    expect(new InboxStore('tim', storage).since).toBe(since); // kept across loads
    // The account knows an earlier start: it wins, and this browser keeps it.
    expect(first.merge({}, since - 1000)).toBe(false);
    expect(first.since).toBe(since - 1000);
    expect(new InboxStore('tim', storage).since).toBe(since - 1000);
    // The account knows none (or a later one): this browser's should be sent.
    expect(first.merge({}, undefined)).toBe(true);
    expect(first.merge({}, since + 5000)).toBe(true);
    expect(first.since).toBe(since - 1000);
  });
});

describe('the thread list kept for next time', () => {
  const thread = (i: number) =>
    ({
      threadId: `t${i}`,
      title: `T ${i}`,
      createdAt: i,
      updatedAt: i,
      busy: false,
      visibility: 'private',
      participants: [],
    }) as unknown as Parameters<typeof writeThreadCache>[2][number];

  beforeEach(() => localStorage.clear());

  it('keeps a short list whole, and the newest of a long one (it only lets the sidebar draw at once)', () => {
    writeThreadCache('u', 'a', [thread(1), thread(2)]);
    expect(readThreadCache('u', 'a')?.map((t) => t.threadId)).toEqual(['t1', 't2']);

    const many = Array.from({ length: 1000 }, (_, i) => thread(i));
    writeThreadCache('u', 'b', many);
    const kept = readThreadCache('u', 'b') ?? [];
    expect(kept).toHaveLength(THREAD_CACHE_LIMIT);
    expect(kept[0]?.threadId).toBe('t999');
    expect(kept.at(-1)?.threadId).toBe(`t${1000 - THREAD_CACHE_LIMIT}`);
    expect(many).toHaveLength(1000); // the list given is not changed
  });
});
