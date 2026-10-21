/**
 * Pi Durable adds a tool's diagnostics to its result as a block of text for the
 * model: `<harness>`, one `[severity] message` line each, `</harness>`. People
 * should see the messages, not the wrapper.
 */

const HARNESS_BLOCK = /<harness>([\s\S]*?)<\/harness>/g;
const SEVERITY = /^\[(?:error|warning|warn|info|debug|notice)\]\s*/i;

/** The text without the harness wrapper (and the severity tags): the diagnostics' messages stay. */
export function stripHarness(text: string): string {
  if (!text.includes('harness>')) return text;
  const unwrapped = text
    .replace(HARNESS_BLOCK, (_, inner: string) =>
      inner
        .split('\n')
        .map((line) => line.trim().replace(SEVERITY, ''))
        .filter(Boolean)
        .join('\n'),
    )
    // A tag left over from a block cut short.
    .replace(/<\/?harness>/g, '');
  return unwrapped.replace(/\n{3,}/g, '\n\n').trim();
}
