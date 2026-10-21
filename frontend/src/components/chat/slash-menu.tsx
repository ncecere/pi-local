import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { FILLED_FOCUS_RING, FOCUS_RING } from '~/components/ui/focus-ring';
import { fillPlaceholders, type SlashCommand } from '~/lib/slash-commands';
import { cn } from '~/lib/utils';

/** The list of commands above the message box. The native textbox keeps focus and points to the listbox. */
export function SlashMenu({
  id,
  commands,
  active,
  onActive,
  onChoose,
}: {
  id: string;
  commands: readonly SlashCommand[];
  active: number;
  onActive: (index: number) => void;
  onChoose: (command: SlashCommand) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  // The highlighted row stays in view as the arrow keys move it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect reads the DOM the active row marks
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  return (
    <div
      ref={list}
      id={id}
      role="listbox"
      aria-label="Commands and prompts"
      className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-popover)]"
    >
      {commands.map((command, index) => (
        // The message box keeps focus and handles the keys, so a row is neither focusable nor keyboard-operable itself.
        // biome-ignore lint/a11y/useFocusableInteractive: options of a listbox the textbox points to
        // biome-ignore lint/a11y/useKeyWithClickEvents: the message box handles the keys
        <div
          key={command.id}
          id={`${id}-${index}`}
          role="option"
          aria-selected={index === active}
          // Pressing a row must not take focus from the message box.
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => index !== active && onActive(index)}
          onClick={() => onChoose(command)}
          className={cn(
            'flex cursor-pointer items-baseline gap-2 rounded-lg px-3 py-2 text-sm',
            index === active
              ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)]',
          )}
        >
          <span className="shrink-0 font-mono text-[0.8125rem] font-medium text-[var(--text-primary)]">
            /{command.name}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {command.title}
            {command.description ? (
              <span className="text-[var(--text-muted)]"> · {command.description}</span>
            ) : null}
          </span>
          {command.group === 'prompt' && (
            <span className="shrink-0 text-xs text-[var(--text-muted)]">
              {command.fields && command.fields.length > 0
                ? `${command.fields.length} ${command.fields.length === 1 ? 'field' : 'fields'}`
                : 'prompt'}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A prompt's {{placeholders}}, asked for inline one field each: Tab (or Enter) goes to the next, Enter in the last
 * puts the finished text in the message box, Escape drops it. A field left empty stays as `{{name}}` in the text.
 */
export function PlaceholderForm({
  command,
  onDone,
  onCancel,
}: {
  command: SlashCommand;
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const fields = command.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => Object.create(null));
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const finish = () => onDone(fillPlaceholders(command.text ?? '', values));

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>, index: number) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.shiftKey) return;
    event.preventDefault();
    if (index < fields.length - 1) {
      (
        event.currentTarget.form?.elements.namedItem(`field-${index + 1}`) as HTMLElement | null
      )?.focus();
    } else finish();
  }

  return (
    <form
      aria-label={`Fill in ${command.title}`}
      onSubmit={(event) => {
        event.preventDefault();
        finish();
      }}
      className="mb-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3"
    >
      <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">
        {command.title}{' '}
        <span className="font-normal text-[var(--text-muted)]">· fill in, then Enter</span>
      </p>
      <div className="flex flex-col gap-2">
        {fields.map((field, index) => (
          <label key={field} className="flex items-center gap-3 text-sm">
            <span className="w-32 shrink-0 truncate text-[var(--text-muted)]" title={field}>
              {field}
            </span>
            <input
              ref={index === 0 ? first : undefined}
              name={`field-${index}`}
              type="text"
              value={Object.hasOwn(values, field) ? values[field] : ''}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field]: event.target.value }))
              }
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                'min-w-0 flex-1 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-control)] px-2.5 py-1.5 text-sm text-[var(--text-primary)]',
                FOCUS_RING,
              )}
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            'rounded-lg px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            FOCUS_RING,
          )}
        >
          Cancel
        </button>
        <button
          type="submit"
          className={cn(
            'rounded-lg border border-[var(--accent-button-border)] bg-[var(--accent-send)] px-3 py-1.5 text-xs font-medium text-[var(--accent-button-foreground)] hover:bg-[var(--accent-send-hover)]',
            FILLED_FOCUS_RING,
          )}
        >
          Put in the message
        </button>
      </div>
    </form>
  );
}
