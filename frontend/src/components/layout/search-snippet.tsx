import { splitSnippet } from '~/lib/snippet';
import { cn } from '~/lib/utils';
import { plainTextOfMarkdown } from '~/shared';

/**
 * A line from a message that matched a search, the matched words in <mark>
 * (lib/snippet.ts). The sidebar's "In messages" and the command palette show it.
 */
export function SearchSnippet({ text, className }: { text: string; className?: string }) {
  return (
    <span dir="auto" className={cn('line-clamp-2 text-xs text-[var(--text-muted)]', className)}>
      {splitSnippet(plainTextOfMarkdown(text)).map((part) =>
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
