import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentLive,
  publishAgentLive,
  readAgentLive,
  signalsFor,
  subscribeAgentLive,
} from '../../src/components/agent/avatar/agent-live';
import { avatarStateOf } from '../../src/components/agent/avatar/states';

const quiet: AgentLive = {
  connected: true,
  busy: false,
  runningTool: false,
  reconnecting: false,
  failed: false,
};

describe('signalsFor', () => {
  it('treats an agent with a live stream as awake, however stale the list is', () => {
    const agent = { enabled: true, running: false };
    expect(avatarStateOf(signalsFor(agent))).toBe('asleep');
    expect(avatarStateOf(signalsFor(agent, quiet))).toBe('idle');
  });

  it('shows work, a lost connection and a failed reply from the live state', () => {
    const agent = { enabled: true, running: true };
    expect(avatarStateOf(signalsFor(agent, { ...quiet, busy: true }))).toBe('thinking');
    expect(avatarStateOf(signalsFor(agent, { ...quiet, busy: true, runningTool: true }))).toBe(
      'working',
    );
    expect(avatarStateOf(signalsFor(agent, { ...quiet, reconnecting: true }))).toBe('waiting');
    expect(avatarStateOf(signalsFor(agent, { ...quiet, failed: true }))).toBe('error');
  });

  it('keeps a disabled agent asleep', () => {
    expect(avatarStateOf(signalsFor({ enabled: false, running: false }, quiet))).toBe('asleep');
  });
});

describe('publishAgentLive', () => {
  afterEach(() => publishAgentLive('a1', null));

  it('notifies on a change, not on a repeat, and lets the agent go', () => {
    const listener = vi.fn();
    const stop = subscribeAgentLive(listener);
    publishAgentLive('a1', quiet);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readAgentLive('a1')).toEqual(quiet);

    publishAgentLive('a1', { ...quiet }); // the same: no re-render of every avatar
    expect(listener).toHaveBeenCalledTimes(1);

    publishAgentLive('a1', { ...quiet, busy: true });
    expect(listener).toHaveBeenCalledTimes(2);

    publishAgentLive('a1', null);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(readAgentLive('a1')).toBeUndefined();
    publishAgentLive('a1', null); // already gone
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
  });

  it('keeps one agent’s state apart from another’s', () => {
    publishAgentLive('a1', { ...quiet, busy: true });
    expect(readAgentLive('a2')).toBeUndefined();
    publishAgentLive('a1', null);
  });
});
