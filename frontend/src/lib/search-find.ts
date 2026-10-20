import { splitSnippet } from '~/lib/snippet';

/**
 * Opening a message-search result at its match. A result names a
 * conversation, not a message (docs/api.md, "Search"), so the message is
 * found in the transcript by the snippet: the one holding the snippet's text,
 * or else the newest holding every matched word.
 */

/** Lower case, accents gone, runs of space as one: how search compares text. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The words a snippet marks as matched, folded, each once. */
export function matchedTermsOf(snippet: string): string[] {
  const terms = new Set<string>();
  for (const part of splitSnippet(snippet))
    if (part.match) {
      const folded = foldText(part.text);
      if (folded) terms.add(folded);
    }
  return [...terms];
}

/** The snippet's words without the markers or the ellipses at its ends, folded. */
export function snippetCoreOf(snippet: string): string {
  const plain = splitSnippet(snippet)
    .map((part) => part.text)
    .join('');
  return foldText(plain.replace(/^\s*(?:…|\.\.\.)\s*/, '').replace(/\s*(?:…|\.\.\.)\s*$/, ''));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a (folded) text has `term` at the start of a word. */
const startsWord = (text: string, term: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}`, 'u').test(text);

/** The ID of the message the snippet came from, or null when none of these hold it. */
export function findSnippetMessage(
  messages: readonly { id: string; text: string }[],
  snippet: string,
): string | null {
  const core = snippetCoreOf(snippet);
  const terms = matchedTermsOf(snippet);
  if (!core && terms.length === 0) return null;
  let byTerms: string | null = null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const text = foldText(message.text);
    if (!text) continue;
    if (core.length >= 8 && text.includes(core)) return message.id;
    if (byTerms === null && terms.length > 0 && terms.every((term) => startsWord(text, term)))
      byTerms = message.id;
  }
  return byTerms;
}
