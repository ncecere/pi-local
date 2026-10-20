import { Check, Copy, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '~/components/ui/button';
import { messageExcerpt, quotedMessage } from '~/lib/message-excerpt';
import { cn } from '~/lib/utils';

export function MessageActions({
  text,
  onRetry,
  position,
  info,
}: {
  text: string;
  /** When, and for a reply which model and how many tokens (reply-meta.ts), beside the controls. */
  info?: { text: string; title: string } | null;
  /** Sends the question this reply answered again. */
  onRetry?: () => void;
  /** Its place, when another message opens with the same words: "reply 3". */
  position?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  // Every message has these controls; its opening words tell them apart.
  const excerpt = useMemo(() => messageExcerpt(text), [text]);
  const about = excerpt ? ` ${quotedMessage(excerpt, position)}` : '';

  if (!text.trim() && !onRetry && !info) return null;
  return (
    <div
      className={cn(
        'mt-2 flex min-h-8 flex-wrap items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100',
        'sm:has-[[aria-expanded=true]]:opacity-100 sm:has-[[role=alert]]:opacity-100',
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
