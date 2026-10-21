import { ArrowUp, Square, Zap } from 'lucide-react';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';
import { FILLED_FOCUS_RING, FOCUS_RING } from '~/components/ui/focus-ring';
import { AGENT_MESSAGE_MAX_LENGTH } from '~/hooks/use-agent-thread';
import { filesOf } from '~/lib/attachments';
import { isApplePlatform } from '~/lib/keyboard-shortcuts';
import {
  isSendKey,
  isSteerKey,
  STEER_KEY_SHORTCUT,
  sendKeyShortcuts,
  steerKeyLabel,
} from '~/lib/send-keys';
import { cn } from '~/lib/utils';
import { useInvertSend } from '~/providers/theme-provider';

interface ComposerProps {
  /** Focus the message field when it first appears. */
  autoFocus?: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /**
   * While the agent works: sends into the reply in progress (it joins after
   * the current step) instead of queueing after it. Offered beside Queue, and
   * on Alt+Enter.
   */
  onSteer?: () => void;
  /** Stops the agent's reply; shown while it works. */
  onStop?: () => void;
  /** The agent is working on a reply. Sending still works: the message queues. */
  working?: boolean;
  stopping?: boolean;
  /** A send is being handed over: no second one. */
  submitting?: boolean;
  /** Nothing can be sent (no agent, or it is disabled); the reason is the placeholder. */
  disabled?: boolean;
  placeholder?: string;
  /** Left of the send button: the agent picker. */
  options?: ReactNode;
  /** Beside the options: the model and thinking picker. */
  model?: ReactNode;
  /** Above the message field: attached files (AttachmentTray). */
  tray?: ReactNode;
  /** Before the options: the attach button. */
  attach?: ReactNode;
  /** Files pasted into the message field. */
  onPasteFiles?: (files: File[]) => void;
  /** Something besides text will be sent (attached files): an empty message may go. */
  hasExtra?: boolean;
  /** Sending waits for this (files still uploading); said under the field. */
  holdSend?: string | null;
}

/**
 * Bottom-anchored composer. The card is flush with the bottom edge and only
 * its top corners are rounded, matching the reference layout.
 */
export const Composer = memo(function Composer({
  value,
  onChange,
  onSubmit,
  onSteer,
  onStop,
  working = false,
  stopping = false,
  submitting = false,
  disabled = false,
  placeholder = 'Message the agent…',
  autoFocus = false,
  options,
  model,
  tray,
  attach,
  onPasteFiles,
  hasExtra = false,
  holdSend = null,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const apple = isApplePlatform();
  // Enter adds a line and Cmd/Ctrl+Enter sends, when chosen in Appearance.
  const invertSend = useInvertSend();

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount only
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus({ preventScroll: true });
  }, []);

  // Re-measure whenever the text changes so the field grows with its content.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value drives the resize
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [value]);

  const length = value.trim().length;
  const tooLong = length > AGENT_MESSAGE_MAX_LENGTH;
  const lengthNoteId = useId();
  const queueNoteId = useId();
  const holdNoteId = useId();
  const canSubmit = (length > 0 || hasExtra) && !tooLong && !submitting && !disabled && !holdSend;

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!onPasteFiles) return;
    const files = filesOf(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    onPasteFiles(files);
  }

  const canSteer = working && Boolean(onSteer);
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (canSteer && isSteerKey(event)) {
      event.preventDefault();
      if (canSubmit && !event.repeat) onSteer?.();
      return;
    }
    if (isSendKey(event, { invert: invertSend })) {
      event.preventDefault();
      // A held key sends once.
      if (canSubmit && !event.repeat) onSubmit();
    }
  }

  return (
    <div className="mx-auto w-full max-w-[47rem] px-6 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-3 md:pb-0">
      <div className="rounded-[1.25rem] border border-[var(--border-strong)] bg-[var(--bg-control)] px-4 pb-4 pt-5 focus-within:outline focus-within:outline-1 focus-within:-outline-offset-1 focus-within:outline-[var(--accent-bright)] md:rounded-b-none md:border-b-0">
        {tray}
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          aria-label="Message input"
          dir="auto"
          aria-invalid={tooLong || undefined}
          aria-describedby={
            [tooLong && lengthNoteId, working && length > 0 && queueNoteId, holdSend && holdNoteId]
              .filter(Boolean)
              .join(' ') || undefined
          }
          className={cn(
            'w-full resize-none bg-transparent text-[0.9375rem] leading-relaxed',
            'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
            'focus:outline-none disabled:cursor-not-allowed',
          )}
        />
        {tooLong && (
          <p id={lengthNoteId} className="mt-2 text-xs font-medium text-[var(--text-primary)]">
            This message is {length.toLocaleString('en-US')} characters long. Messages can be up to{' '}
            {AGENT_MESSAGE_MAX_LENGTH.toLocaleString('en-US')} characters.
          </p>
        )}
        {holdSend && (
          <p id={holdNoteId} className="mt-2 text-xs text-[var(--text-muted)]">
            {holdSend}
          </p>
        )}
        {working && length > 0 && !tooLong && (
          <p id={queueNoteId} className="mt-2 text-xs text-[var(--text-muted)]">
            The agent is working. Your message will run after the current reply
            {canSteer ? (
              <>
                , or steer it now ({steerKeyLabel(apple)}): it joins the reply in progress after its
                current step.
              </>
            ) : (
              '.'
            )}
          </p>
        )}

        <div className="mt-5 flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {attach}
            {options}
            {model}
          </div>

          {working && onStop && (
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              aria-label={stopping ? 'Stopping' : 'Stop the agent'}
              title={stopping ? 'Stopping…' : 'Stop'}
              className={cn(
                'inline-flex size-[2.125rem] shrink-0 items-center justify-center rounded-lg border transition-colors',
                FOCUS_RING,
                length > 0
                  ? 'border-[var(--border-strong)] bg-[var(--bg-control-hover)] text-[var(--text-primary)] hover:bg-[var(--accent-soft)]'
                  : `border-[var(--accent-button-border)] bg-[var(--accent-send)] text-[var(--accent-button-foreground)] hover:bg-[var(--accent-send-hover)] ${FILLED_FOCUS_RING}`,
                stopping && 'animate-pulse',
              )}
            >
              <Square className="size-3.5 fill-current" />
            </button>
          )}
          {canSteer && (length > 0 || hasExtra) && (
            <button
              type="button"
              disabled={!canSubmit}
              onClick={onSteer}
              aria-label="Steer now"
              aria-keyshortcuts={STEER_KEY_SHORTCUT}
              title={`Steer now (${steerKeyLabel(apple)}): joins the reply in progress after its current step`}
              className={cn(
                'inline-flex h-[2.125rem] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors',
                FOCUS_RING,
                canSubmit
                  ? 'border-[var(--border-strong)] bg-[var(--bg-control-hover)] text-[var(--text-primary)] hover:bg-[var(--accent-soft)]'
                  : 'border-[var(--border-strong)] bg-[var(--accent-soft)] text-[var(--text-faint)]',
              )}
            >
              <Zap className="size-3.5" aria-hidden="true" />
              Steer
            </button>
          )}
          {(!working || length > 0 || hasExtra) && (
            <button
              type="button"
              disabled={!canSubmit}
              aria-busy={submitting || undefined}
              onClick={onSubmit}
              aria-label={working ? 'Queue message' : 'Send message'}
              aria-keyshortcuts={sendKeyShortcuts(invertSend)}
              title={working ? 'Queue: runs after the current reply' : undefined}
              className={cn(
                'inline-flex size-[2.125rem] shrink-0 items-center justify-center rounded-lg border transition-colors',
                FOCUS_RING,
                canSubmit
                  ? `border-[var(--accent-button-border)] bg-[var(--accent-send)] text-[var(--accent-button-foreground)] hover:bg-[var(--accent-send-hover)] ${FILLED_FOCUS_RING}`
                  : 'border-[var(--border-strong)] bg-[var(--accent-soft)] text-[var(--text-faint)]',
              )}
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
