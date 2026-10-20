import { Check, Copy, GitBranch, Pencil, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { messageExcerpt, quotedMessage } from '~/lib/message-excerpt';
import { cn } from '~/lib/utils';

export function MessageActions({
  text,
  onRetry,
  onEdit,
  onBranch,
  branching = false,
  position,
  info,
}: {
  text: string;
  /** When, and for a reply which model and how many tokens (reply-meta.ts), beside the controls. */
  info?: { text: string; title: string } | null;
  /** Sends the question this reply answered again. */
  onRetry?: () => void;
  /** A message of the person's: edit it (in a new conversation). */
  onEdit?: () => void;
  /** A reply: a new conversation from here. */
  onBranch?: () => void;
  /** The branch is being made. */
  branching?: boolean;
  /** Its place, when another message opens with the same words: "reply 3". */
  position?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  // Every message has these controls; its opening words tell them apart.
  const excerpt = useMemo(() => messageExcerpt(text), [text]);
  const about = excerpt ? ` ${quotedMessage(excerpt, position)}` : '';

  if (!text.trim() && !onRetry && !info && !onBranch) return null;
  return (
    <div
      className={cn(
        'mt-2 flex min-h-8 flex-wrap items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100',
        'sm:has-[[aria-expanded=true]]:opacity-100 sm:has-[[role=alert]]:opacity-100',
        branching && 'sm:opacity-100',
      )}
    >
      {text.trim() && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Copy message${about}`}
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
        </Button>
      )}
      {onEdit && text.trim() && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit message${about}`}
          title="Edit (in a new conversation)"
          onClick={onEdit}
        >
          <Pencil />
        </Button>
      )}
      {onRetry && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Send again"
          title="Send again"
          onClick={onRetry}
        >
          <RefreshCw />
        </Button>
      )}
      {onBranch && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Branch from here${about}`}
          title="Branch from here: a new conversation with everything up to this reply"
          disabled={branching}
          onClick={onBranch}
        >
          {branching ? <Spinner className="size-4" /> : <GitBranch />}
        </Button>
      )}
      {info && (
        <span
          className="ml-1.5 cursor-default whitespace-nowrap text-xs tabular-nums text-[var(--text-muted)]"
          title={info.title}
        >
          {info.text}
        </span>
      )}
    </div>
  );
}
