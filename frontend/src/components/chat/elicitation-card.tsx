import { Check, Clock, MessageCircleQuestion, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import {
  ApiError,
  type ElicitationAction,
  type ElicitationField,
  errorMessage,
  type McpElicitation,
} from '~/api/client';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useAnswerElicitation } from '~/hooks/use-elicitations';
import {
  confirmField,
  contentOf,
  expiresLabel,
  type FormValues,
  fieldLabel,
  fieldsOf,
  initialValues,
  isRequired,
  missingRequired,
} from '~/lib/elicitations';
import { cn } from '~/lib/utils';

/** The server's message: its own words, plain text, kept as written. */
const MESSAGE =
  'max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--border-inset)] bg-[var(--bg-inset)] px-2.5 py-2 text-sm leading-relaxed text-[var(--text-primary)]';

const FIELD =
  'w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]';

/** A text field longer than this many characters is a textarea. */
const LONG_TEXT = 200;

/** How long an answered card stays, saying how it ended, before it goes. */
const KEEP_ANSWERED_MS = 5_000;

/** The time, ticking every 15 s while a countdown shows. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

type Outcome = 'accept' | 'decline' | 'cancel' | 'gone';

const OUTCOME_TEXT: Record<Exclude<Outcome, 'gone'>, string> = {
  accept: 'Sent your answer',
  decline: 'Declined',
  cancel: 'Cancelled',
};

const inputTypeOf = (field: ElicitationField) => {
  switch (field.format) {
    case 'email':
      return 'email';
    case 'uri':
      return 'url';
    case 'date':
      return 'date';
    case 'date-time':
      return 'datetime-local';
    default:
      return 'text';
  }
};

/** One field of the form, by its type. Its title, description and choices are the server's: text only. */
function FormField({
  id,
  name,
  field,
  required,
  value,
  error,
  disabled,
  onChange,
}: {
  id: string;
  name: string;
  field: ElicitationField;
  required: boolean;
  value: string | boolean;
  error?: string;
  disabled: boolean;
  onChange: (value: string | boolean) => void;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [field.description ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') ||
    undefined;
  const label = (
    <label htmlFor={id} className="text-xs font-medium text-[var(--text-secondary)]">
      {fieldLabel(name, field)}
      {required && (
        <>
          <span aria-hidden="true" className="text-[var(--danger)]">
            {' '}
            *
          </span>
          <span className="sr-only"> (required)</span>
        </>
      )}
    </label>
  );
  const hint = field.description && (
    <p id={hintId} className="text-xs text-[var(--text-muted)]">
      {field.description}
    </p>
  );
  const problem = error && (
    <p id={errorId} className="text-xs text-[var(--danger-on-tint)]">
      {error}
    </p>
  );

  if (field.type === 'boolean')
    return (
      <div className="flex items-start gap-2.5">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby={describedBy}
          className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
        />
        <div className="min-w-0">
          {label}
          {hint}
          {problem}
        </div>
      </div>
    );

  const common = {
    id,
    disabled,
    required,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : undefined,
  };
  const text = typeof value === 'string' ? value : '';
  let control: ReactNode;
  if (field.type === 'string' && field.enum) {
    const names = field.enumNames?.length === field.enum.length ? field.enumNames : null;
    control = (
      <select
        {...common}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        className={cn(FIELD, 'h-9')}
      >
        {(!required || text === '') && <option value="">{required ? 'Choose…' : 'None'}</option>}
        {field.enum.map((option, index) => (
          <option key={option} value={option}>
            {names?.[index] ?? option}
          </option>
        ))}
      </select>
    );
  } else if (field.type === 'string' && (field.maxLength ?? 0) > LONG_TEXT) {
    control = (
      <textarea
        {...common}
        value={text}
        rows={4}
        minLength={field.minLength}
        maxLength={field.maxLength}
        onChange={(event) => onChange(event.target.value)}
        className={cn(FIELD, 'min-h-20 py-2 leading-relaxed')}
      />
    );
  } else if (field.type === 'string') {
    control = (
      <input
        {...common}
        type={inputTypeOf(field)}
        value={text}
        minLength={field.minLength}
        maxLength={field.maxLength}
        onChange={(event) => onChange(event.target.value)}
        className={cn(FIELD, 'h-9')}
      />
    );
  } else {
    control = (
      <input
        {...common}
        type="number"
        inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
        step={field.type === 'integer' ? 1 : 'any'}
        min={field.minimum}
        max={field.maximum}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        className={cn(FIELD, 'h-9 max-w-48')}
      />
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {label}
      {control}
      {hint}
      {problem}
    </div>
  );
}

/**
 * An MCP server asking the person something while a tool call waits: who
 * asks, its message (the server's own words, as plain text), its form, and
 * Accept / Decline / Cancel. A lone yes-or-no field (a server confirming
 * before it acts) is one button with that field's title, and Decline.
 */
export function ElicitationCard({
  elicitation,
  onDone,
  answered = null,
}: {
  elicitation: McpElicitation;
  /** Answered here, or found no longer waiting: the list may keep the card a moment to say so. */
  onDone?: (elicitation: McpElicitation, outcome: Outcome) => void;
  /** How it ended, for a card the list keeps after the question left the pending list. */
  answered?: Outcome | null;
}) {
  const answer = useAnswerElicitation();
  const schema = elicitation.requestedSchema;
  const confirm = confirmField(schema);
  const [values, setValues] = useState<FormValues>(() => initialValues(schema));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<Outcome | null>(answered);
  const titleId = useId();
  const fieldId = useId();
  const now = useNow();
  const done = useRef(onDone);
  done.current = onDone;

  const expired = elicitation.expiresAt > 0 && elicitation.expiresAt <= now;
  const busy = answer.isPending;
  const closed = outcome !== null || expired;
  const missing = missingRequired(schema, values);

  const send = (action: ElicitationAction, content?: Record<string, string | number | boolean>) => {
    if (busy || closed) return;
    // A promise, not mutate's callbacks: the list may drop this card before the answer arrives.
    answer.mutateAsync({ id: elicitation.id, action, content }).then(
      () => {
        setOutcome(action);
        done.current?.(elicitation, action);
      },
      (error: unknown) => {
        if (error instanceof ApiError && (error.code === 'not_pending' || error.status === 409)) {
          setOutcome('gone');
          done.current?.(elicitation, 'gone');
        }
      },
    );
  };

  const accept = (event?: FormEvent) => {
    event?.preventDefault();
    if (confirm) return send('accept', { [confirm]: true });
    const { content, errors: problems } = contentOf(schema, values);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    send('accept', content);
  };

  const gone =
    outcome === 'gone' ||
    (answer.error instanceof ApiError &&
      (answer.error.code === 'not_pending' || answer.error.status === 409));
  const confirmSpec = confirm ? schema.properties[confirm] : undefined;
  const pendingAction = busy ? answer.variables?.action : undefined;

  return (
    <section
      aria-labelledby={titleId}
      data-elicitation-card={elicitation.id}
      className="my-3 flex flex-col gap-3 rounded-xl border border-[var(--warning)]/45 bg-[var(--warning)]/[0.06] px-4 py-3.5 motion-safe:animate-[row-in_150ms_ease-out]"
    >
      <div className="flex items-start gap-2.5">
        <MessageCircleQuestion
          className="mt-0.5 size-4 shrink-0 text-[var(--warning)]"
          aria-hidden="true"
        />
        <p id={titleId} className="min-w-0 flex-1 text-sm font-medium text-[var(--text-primary)]">
          {elicitation.serverName} asks
          {elicitation.tool && (
            <span className="font-normal text-[var(--text-muted)]">
              {' '}
              while running <span className="font-mono">{elicitation.tool}</span>
            </span>
          )}
        </p>
      </div>

      <section
        className={MESSAGE}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolled region must be reachable by keyboard
        tabIndex={0}
        aria-label={`${elicitation.serverName}'s message`}
      >
        {elicitation.message}
      </section>

      <form className="flex flex-col gap-3" onSubmit={accept} noValidate>
        {!confirm && fieldsOf(schema).length > 0 && (
          <fieldset className="m-0 flex flex-col gap-3 border-0 p-0" disabled={closed || busy}>
            <legend className="sr-only">Your answer</legend>
            {fieldsOf(schema).map(([name, field], index) => (
              <FormField
                key={name}
                id={`${fieldId}-${index}`}
                name={name}
                field={field}
                required={isRequired(schema, name)}
                value={values[name] ?? (field.type === 'boolean' ? false : '')}
                error={errors[name]}
                disabled={closed || busy}
                onChange={(value) => {
                  setValues((current) => ({ ...current, [name]: value }));
                  if (errors[name]) setErrors(({ [name]: _cleared, ...rest }) => rest);
                }}
              />
            ))}
          </fieldset>
        )}
        {confirm && confirmSpec?.description && (
          <p className="text-xs text-[var(--text-muted)]">{confirmSpec.description}</p>
        )}

        {answer.error && (
          <p role="alert" className="text-xs text-[var(--danger-on-tint)]">
            {gone
              ? 'Already answered or expired'
              : errorMessage(answer.error, "Your answer wasn't sent. Try again.")}
          </p>
        )}

        {outcome !== null && outcome !== 'gone' ? (
          <p role="status" className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            {outcome === 'accept' ? (
              <Check className="size-3.5" aria-hidden="true" />
            ) : (
              <X className="size-3.5" aria-hidden="true" />
            )}
            {OUTCOME_TEXT[outcome]}
          </p>
        ) : (
          !gone && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                size="sm"
                variant="primary"
                data-elicitation-accept=""
                disabled={busy || closed || (!confirm && missing.length > 0)}
                title={
                  !confirm && missing.length > 0 ? 'Fill in the required fields first' : undefined
                }
              >
                {pendingAction === 'accept' ? (
                  <Spinner className="size-3.5 text-current" />
                ) : (
                  <Check />
                )}
                {confirm && confirmSpec ? fieldLabel(confirm, confirmSpec) : 'Accept'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy || closed}
                onClick={() => send('decline')}
              >
                {pendingAction === 'decline' ? (
                  <Spinner className="size-3.5 text-current" />
                ) : (
                  <X />
                )}
                Decline
              </Button>
              {!confirm && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy || closed}
                  onClick={() => send('cancel')}
                >
                  Cancel
                </Button>
              )}
              {elicitation.expiresAt > 0 && (
                <span
                  className="ml-auto inline-flex items-center gap-1 text-xs text-[var(--text-muted)]"
                  title={new Date(elicitation.expiresAt).toLocaleString()}
                >
                  <Clock className="size-3" aria-hidden="true" />
                  {expiresLabel(elicitation.expiresAt, now)}
                </span>
              )}
            </div>
          )
        )}
      </form>
    </section>
  );
}

/**
 * Elicitations waiting, as cards. One answered here stays a moment, saying
 * how it ended, after it leaves the pending list.
 */
export function ElicitationList({
  elicitations,
  className,
}: {
  elicitations: readonly McpElicitation[];
  className?: string;
}) {
  // Answered here: kept a moment with how it ended (the event that ends it can drop it from the list first, which
  // unmounts its card; the kept copy is a new card that must not ask again).
  const [kept, setKept] = useState<{ elicitation: McpElicitation; outcome: Outcome }[]>([]);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);

  const keep = (elicitation: McpElicitation, outcome: Outcome) => {
    setKept((current) =>
      current.some((candidate) => candidate.elicitation.id === elicitation.id)
        ? current
        : [...current, { elicitation, outcome }],
    );
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setKept((current) =>
        current.filter((candidate) => candidate.elicitation.id !== elicitation.id),
      );
    }, KEEP_ANSWERED_MS);
    timers.current.add(timer);
  };

  const answeredById = new Map(kept.map((k) => [k.elicitation.id, k.outcome]));
  const shown = [
    ...elicitations.filter((e) => !answeredById.has(e.id)),
    ...kept.map((k) => k.elicitation),
  ].sort((a, b) => a.createdAt - b.createdAt);
  if (shown.length === 0) return null;
  return (
    <div className={className}>
      {shown.map((elicitation) => (
        <ElicitationCard
          key={elicitation.id}
          elicitation={elicitation}
          onDone={keep}
          answered={answeredById.get(elicitation.id) ?? null}
        />
      ))}
    </div>
  );
}
