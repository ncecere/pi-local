import { describe, expect, it } from 'vitest';
import { matchInboxShortcut } from '../../src/lib/inbox-shortcuts';

const press = (
  code: string,
  mods: { alt?: boolean; shift?: boolean; meta?: boolean; ctrl?: boolean } = {},
) =>
  matchInboxShortcut({
    code,
    altKey: mods.alt ?? true,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
  });

describe('matchInboxShortcut', () => {
  it('moves between conversations with ⌥↑ and ⌥↓, and to the next that needs you with ⌥⇧↓', () => {
    expect(press('ArrowUp')).toBe('previous');
    expect(press('ArrowDown')).toBe('next');
    expect(press('ArrowDown', { shift: true })).toBe('next-attention');
  });

  it('settles, pins and marks unread with ⌥⇧S, ⌥⇧P, ⌥⇧U', () => {
    expect(press('KeyS', { shift: true })).toBe('settle');
    expect(press('KeyP', { shift: true })).toBe('pin');
    expect(press('KeyU', { shift: true })).toBe('unread');
  });

  it('leaves everything else alone: no ⌥, ⌥ without ⇧ for letters, or with ⌘/Ctrl', () => {
    expect(press('ArrowDown', { alt: false })).toBeNull();
    expect(press('KeyS')).toBeNull(); // ⌥S types ß on a Mac
    expect(press('KeyS', { shift: true, meta: true })).toBeNull();
    expect(press('ArrowDown', { ctrl: true })).toBeNull();
    expect(press('KeyX', { shift: true })).toBeNull();
  });
});
