import { GitBranch } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { editProblem } from '~/lib/fork';
import { isSendKey } from '~/lib/send-keys';
import { useInvertSend } from '~/providers/theme-provider';

/**
 * A message of the person's, edited in place. Sending it starts a new
 * conversation (everything before this message, then the new text); the
 * conversation it was in stays as it is. `onSubmit` answers an error to show,
 * or null once it is on its way (the page moves to the new conversation).
 */
export function MessageEditor({
  text,
  onCancel,
  onSubmit,
}: {
  text: string;
  onCancel: () => void;
  onSubmit: (text: string) => Promise<string | null>;
}) {
  const id = useId();
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const invertSend = useInvertSend();
  const problem = editProblem(text, value);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);
  // Grows with its text, as the composer does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value drives the resize
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 320)}px`;
  }, [value]);

  const submit = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    const failed = await onSubmit(value.trim());
    if (failed) {
      setError(failed);
      setBusy(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onCancel();
    } else if (isSendKey(event, { invert: invertSend })) {
      event.preventDefault();
      if (!event.repeat) void submit();
    }
  };

  return (
    <div className="flex w-full max-w-[85%] flex-col gap-2 self-end rounded-2xl border border-[var(--accent)] bg-[var(--bg-user-message)] px-4 py-3">
      <textarea
        ref={ref}
        aria-label="Edit message"
        aria-describedby={`${id}-note`}
        value={value}
        disabled={busy}
        rows={2}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        className="w-full resize-none bg-transparent text-[0.9375rem] leading-relaxed text-[var(--text-primary)] outline-none"
      />
      <p id={`${id}-note`} className="flex items-start gap-1.5 text-xs text-[var(--text-muted)]">
        <GitBranch className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
        Sends in a new conversation with everything before this message. This conversation is kept
        as it is.
      </p>
      {error && (
        <p role="alert" className="text-xs text-[var(--danger-on-tint)]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={Boolean(problem) || busy}
          title={problem ?? undefined}
          onClick={() => void submit()}
        >
          {busy && <Spinner className="size-3.5 text-current" />}
          Send
        </Button>
      </div>
    </div>
  );
}
