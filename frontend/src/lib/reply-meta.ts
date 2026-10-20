import type { ReplyMetadata } from '~/lib/chat-view';

/** A token count as people read it: 840, 1.2k, 12k, 1.2M. */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(Math.round(count / 100) / 10).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(Math.round(count / 100_000) / 10).toFixed(1)}M`;
}

/** How long something took: 56 ms, 2.3 s, 12 s, 1m 05s, 1h 02m. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)} s`;
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 3_600) {
    const minutes = Math.floor(totalSeconds / 60);
    return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
  }
  const hours = Math.floor(totalSeconds / 3_600);
  return `${hours}h ${String(Math.floor((totalSeconds % 3_600) / 60)).padStart(2, '0')}m`;
}

/** When a message was sent: the time today, the date and time otherwise. */
export function formatClock(at: number, now: number = Date.now(), locale?: string): string {
  const date = new Date(at);
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return date.toLocaleString(
    locale,
    sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  );
}

/** The small line beside a message's controls: when, and for a reply which model and how many tokens. */
export function replyInfo(
  meta: ReplyMetadata | undefined,
  now: number = Date.now(),
  locale?: string,
): { text: string; title: string } | null {
  if (!meta) return null;
  const parts: string[] = [];
  const details: string[] = [];
  if (meta.at !== undefined) {
    parts.push(formatClock(meta.at, now, locale));
    details.push(new Date(meta.at).toLocaleString(locale));
  }
  if (meta.model) {
    parts.push(meta.model);
    details.push(`Written by ${meta.model}`);
  }
  const usage = meta.usage;
  if (usage && usage.total > 0) {
    parts.push(`${formatTokens(usage.total)} tokens`);
    details.push(
      `${usage.input.toLocaleString(locale)} in, ${usage.output.toLocaleString(locale)} out` +
        (usage.cacheRead ? `, ${usage.cacheRead.toLocaleString(locale)} read from cache` : ''),
    );
  }
  return parts.length ? { text: parts.join(' · '), title: details.join('\n') } : null;
}
