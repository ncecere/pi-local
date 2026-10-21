import { ArrowUp, Square, Zap } from 'lucide-react';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { PlaceholderForm, SlashMenu } from '~/components/chat/slash-menu';
import { FILLED_FOCUS_RING, FOCUS_RING } from '~/components/ui/focus-ring';
import { AGENT_MESSAGE_MAX_LENGTH } from '~/hooks/use-agent-thread';
import { pastedFilesOf } from '~/lib/attachments';
import { isApplePlatform } from '~/lib/keyboard-shortcuts';
import {
  isSendKey,
  isSteerKey,
  STEER_KEY_SHORTCUT,
  sendKeyShortcuts,
  steerKeyLabel,
} from '~/lib/send-keys';
import { filterCommands, type SlashCommand, slashQuery } from '~/lib/slash-commands';
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
  /**
   * Slash commands: typing `/` at the start of the message opens a menu of these (arrow keys and Enter, Tab or a click
   * choose, Escape closes it). Absent: `/` is only text.
   */
  commands?: readonly SlashCommand[];
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
  commands,
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
    const files = pastedFilesOf(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    onPasteFiles(files);
  }

  // Slash commands: the menu is open while the message is only `/` and what is being typed after it, and something
  // matches. Escape closes it until the text changes.
  const listId = useId();
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  useEffect(() => {
    setDismissedAt((current) => (current === value ? current : null));
  }, [value]);
  const [filling, setFilling] = useState<SlashCommand | null>(null);
  const query = commands && !disabled && !filling ? slashQuery(value) : null;
  const matches = useMemo(
    () => (query === null ? [] : filterCommands(commands ?? [], query)),
    [commands, query],
  );
  const menuOpen = matches.length > 0 && dismissedAt !== value;
  const shownActive = Math.min(active, Math.max(matches.length - 1, 0));
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the top
  useEffect(() => setActive(0), [query]);
  // After a fill, the cursor goes to the end of the text.
  const caretAtEnd = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: value is what the fill changed
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!caretAtEnd.current || !node) return;
    caretAtEnd.current = false;
    node.focus({ preventScroll: true });
    node.setSelectionRange(node.value.length, node.value.length);
  }, [value]);
  const fillBox = (text: string) => {
    caretAtEnd.current = true;
    onChange(text);
    // The text may equal what is there: the effect above only runs on a change, so also place the cursor now.
    const node = textareaRef.current;
    if (node && node.value === text) {
      node.focus({ preventScroll: true });
      node.setSelectionRange(text.length, text.length);
    }
  };
  function choose(command: SlashCommand) {
    if (command.fields && command.fields.length > 0) {
      onChange('');
      setFilling(command);
    } else if (command.run) {
      onChange('');
      command.run();
    } else fillBox(command.text ?? '');
  }

  const canSteer = working && Boolean(onSteer);
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen && !event.nativeEvent.isComposing) {
      const plainEnter =
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((shownActive + step + matches.length) % matches.length);
        return;
      }
      if (plainEnter || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault();
        choose(matches[shownActive]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedAt(value);
        return;
      }
    }
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
    <div className="mx-auto w-full max-w-[47rem] px-6 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-3 md:pb-3">
      <div className="relative rounded-[1.25rem] border border-[var(--border-strong)] bg-[var(--bg-control)] px-4 pb-4 pt-5 focus-within:outline focus-within:outline-1 focus-within:-outline-offset-1 focus-within:outline-[var(--accent-bright)]">
        {menuOpen && (
          <SlashMenu
            id={listId}
            commands={matches}
            active={shownActive}
            onActive={setActive}
            onChoose={choose}
          />
        )}
        {tray}
        {filling && (
          <PlaceholderForm
            command={filling}
            onCancel={() => {
              setFilling(null);
              textareaRef.current?.focus({ preventScroll: true });
            }}
            onDone={(text) => {
              setFilling(null);
              fillBox(text);
            }}
          />
        )}
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
          {...(menuOpen
            ? {
                'aria-controls': listId,
                'aria-autocomplete': 'list' as const,
                'aria-activedescendant': `${listId}-${shownActive}`,
              }
            : {})}
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
