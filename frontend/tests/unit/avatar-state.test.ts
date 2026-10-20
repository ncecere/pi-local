import { describe, expect, it } from 'vitest';
import {
  AVATAR_STATES,
  type AvatarSignals,
  avatarStateOf,
  finishedWork,
  STATE_INFO,
} from '../../src/components/agent/avatar/states';

const base: AvatarSignals = { enabled: true, running: true };

describe('avatarStateOf', () => {
  it('rests as idle when awake, and asleep when hibernating or disabled', () => {
    expect(avatarStateOf(base)).toBe('idle');
    expect(avatarStateOf({ ...base, running: false })).toBe('asleep');
    expect(avatarStateOf({ ...base, enabled: false })).toBe('asleep');
  });

  it('thinks while busy, and works while a tool runs', () => {
    expect(avatarStateOf({ ...base, busy: true })).toBe('thinking');
    expect(avatarStateOf({ ...base, busy: true, runningTool: true })).toBe('working');
  });

  it('wakes a hibernating agent that is busy: it is working, not asleep', () => {
    expect(avatarStateOf({ ...base, running: false, busy: true })).toBe('thinking');
  });

  it('orders what matters most: failure, reconnecting, work, unread, rest', () => {
    const all = {
      ...base,
      busy: true,
      runningTool: true,
      reconnecting: true,
      failed: true,
      unread: true,
    };
    expect(avatarStateOf(all)).toBe('error');
    expect(avatarStateOf({ ...all, failed: false })).toBe('waiting');
    expect(avatarStateOf({ ...all, failed: false, reconnecting: false })).toBe('working');
    expect(avatarStateOf({ ...all, failed: false, reconnecting: false, busy: false })).toBe(
      'attention',
    );
  });
});

describe('finishedWork', () => {
  it('is true when busy work ends at rest or waiting for you', () => {
    expect(finishedWork('thinking', 'idle')).toBe(true);
    expect(finishedWork('working', 'attention')).toBe(true);
    expect(finishedWork('working', 'asleep')).toBe(true);
  });

  it('is false for everything else', () => {
    expect(finishedWork('idle', 'thinking')).toBe(false);
    expect(finishedWork('thinking', 'working')).toBe(false);
    expect(finishedWork('working', 'error')).toBe(false);
    expect(finishedWork('waiting', 'idle')).toBe(false);
    expect(finishedWork('idle', 'idle')).toBe(false);
  });
});

describe('states', () => {
  it('describes every state', () => {
    for (const state of AVATAR_STATES) {
      expect(STATE_INFO[state].label).toBeTruthy();
      expect(STATE_INFO[state].when).toBeTruthy();
    }
  });
});
