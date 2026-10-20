import { describe, expect, it } from 'vitest';
import { formatClock, formatDuration, formatTokens, replyInfo } from '../../src/lib/reply-meta';

describe('formatTokens', () => {
  it('reads as people say it', () => {
    expect(
      [0, 840, 999, 1_000, 1_234, 9_949, 12_400, 999_000, 1_200_000].map(formatTokens),
    ).toEqual(['0', '840', '999', '1.0k', '1.2k', '9.9k', '12k', '999k', '1.2M']);
  });
});

describe('formatDuration', () => {
  it('is milliseconds under a second, tenths under ten, whole seconds under a minute, then minutes and hours', () => {
    expect(
      [40, 56, 999, 1_000, 2_340, 9_990, 12_400, 59_400, 65_000, 3_599_000, 3_720_000].map(
        formatDuration,
      ),
    ).toEqual([
      '40 ms',
      '56 ms',
      '999 ms',
      '1.0 s',
      '2.3 s',
      '10.0 s',
      '12 s',
      '59 s',
      '1m 05s',
      '59m 59s',
      '1h 02m',
    ]);
  });
});

describe('formatClock', () => {
  const now = new Date(2026, 9, 18, 16, 0).getTime();
  it('is the time today, and the date with it on another day', () => {
    expect(formatClock(new Date(2026, 9, 18, 9, 5).getTime(), now, 'en-US')).toBe('9:05 AM');
    expect(formatClock(new Date(2026, 9, 17, 21, 30).getTime(), now, 'en-US')).toBe(
      'Oct 17, 9:30 PM',
    );
  });
});

describe('replyInfo', () => {
  const now = new Date(2026, 9, 18, 16, 0).getTime();
  const at = new Date(2026, 9, 18, 15, 31).getTime();

  it('puts the time, model and tokens on one line, and the detail in the title', () => {
    const info = replyInfo(
      {
        at,
        model: 'gpt-oss-120b',
        usage: { input: 900, output: 340, cacheRead: 100, cacheWrite: 0, total: 1_340 },
      },
      now,
      'en-US',
    );
    expect(info?.text).toBe('3:31 PM · gpt-oss-120b · 1.3k tokens');
    expect(info?.title).toContain('Written by gpt-oss-120b');
    expect(info?.title).toContain('900 in, 340 out, 100 read from cache');
  });

  it('shows only what the platform said, and nothing when it said nothing', () => {
    expect(replyInfo({ at }, now, 'en-US')?.text).toBe('3:31 PM');
    expect(replyInfo({ model: 'm' }, now)?.text).toBe('m');
    expect(replyInfo({}, now)).toBeNull();
    expect(replyInfo(undefined, now)).toBeNull();
    expect(
      replyInfo({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, now),
    ).toBeNull();
  });
});

import { toolDuration } from '../../src/components/chat/tool-steps';

describe('toolDuration', () => {
  const part = (toolMetadata?: unknown) =>
    ({ type: 'dynamic-tool', toolCallId: 'c', toolMetadata }) as never;
  it('is how long a finished call ran, and null when the platform did not say or it has not ended', () => {
    expect(toolDuration(part({ startedAt: 1_000, endedAt: 3_300 }))).toBe(2_300);
    expect(toolDuration(part({ startedAt: 1_000 }))).toBeNull();
    expect(toolDuration(part({ startedAt: 5, endedAt: 1 }))).toBeNull();
    expect(toolDuration(part())).toBeNull();
    expect(toolDuration(part({ liveOutput: 'x' }))).toBeNull();
  });
});
