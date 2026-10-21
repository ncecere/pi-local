import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { type Agent, errorMessage, type Schedule } from '~/api/client';
import { ErrorNotice, FIELD, Field, Optional } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { useAgents, useAgentThreads } from '~/hooks/use-agents';
import { useCreateSchedule, useUpdateSchedule } from '~/hooks/use-schedules';
import {
  browserTimeZone,
  DAY_NAMES,
  describeCron,
  movedNotice,
  presetCron,
  type RepeatPreset,
  SCHEDULE_NAME_MAX,
  type ScheduleForm,
  scheduleChanges,
  scheduleFormOf,
  scheduleFormProblem,
  scheduleInputOf,
  timeZones,
  type WhenForm,
} from '~/lib/schedules';
import { cn } from '~/lib/utils';

const PRESETS: { id: RepeatPreset; label: string }[] = [
  { id: 'daily', label: 'Every day at…' },
  { id: 'weekdays', label: 'Every weekday at…' },
  { id: 'weekly', label: 'Every week on… at…' },
  { id: 'hourly', label: 'Every hour' },
  { id: 'custom', label: 'Custom (cron expression)' },
];

/** A pair (or more) of choices drawn as cards: radio buttons, one line of hint each. */
function Choices<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: { id: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.id}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors',
              value === option.id
                ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                : 'border-[var(--border-subtle)] hover:bg-[var(--bg-control)]',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.id}
              checked={value === option.id}
              onChange={() => onChange(option.id)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
            />
            <span className="min-w-0">
              <span className="block">{option.label}</span>
              {option.hint && (
                <span className="block text-xs text-[var(--text-muted)]">{option.hint}</span>
              )}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** "When": once at a date and time, or repeating, in a time zone. */
function WhenFields({ when, onChange }: { when: WhenForm; onChange: (when: WhenForm) => void }) {
  const id = useId();
  const zones = useMemo(() => timeZones(when.timezone), [when.timezone]);
  const set = (change: Partial<WhenForm>) => onChange({ ...when, ...change });
  const cron = when.kind === 'repeats' ? presetCron(when) : '';
  const described = cron ? describeCron(cron) : null;
  return (
    <div className="flex flex-col gap-3">
      <Choices
        legend="When"
        name={`${id}-kind`}
        value={when.kind}
        options={[
          { id: 'once', label: 'Once', hint: 'A reminder at a date and time.' },
          { id: 'repeats', label: 'Repeats', hint: 'Every day, weekday, week, hour…' },
        ]}
        onChange={(kind) => set({ kind })}
      />
      {when.kind === 'once' ? (
        <div className="grid grid-cols-2 gap-3">
          <Field id={`${id}-date`} label="Date">
            <input
              id={`${id}-date`}
              type="date"
              value={when.date}
              onChange={(event) => set({ date: event.target.value })}
              className={FIELD}
            />
          </Field>
          <Field id={`${id}-time`} label="Time">
            <input
              id={`${id}-time`}
              type="time"
              value={when.time}
              onChange={(event) => set({ time: event.target.value })}
              className={FIELD}
            />
          </Field>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Field id={`${id}-preset`} label="Repeats">
            <select
              id={`${id}-preset`}
              value={when.preset}
              onChange={(event) => set({ preset: event.target.value as RepeatPreset })}
              className={FIELD}
            >
              {PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </Field>
          {(when.preset === 'daily' || when.preset === 'weekdays' || when.preset === 'weekly') && (
            <div className="grid grid-cols-2 gap-3">
              {when.preset === 'weekly' && (
                <Field id={`${id}-weekday`} label="Day">
                  <select
                    id={`${id}-weekday`}
                    value={when.weekday}
                    onChange={(event) => set({ weekday: Number(event.target.value) })}
                    className={FIELD}
                  >
                    {/* Monday first; Sunday is 0 in cron. */}
                    {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                      <option key={day} value={day}>
                        {DAY_NAMES[day]}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field id={`${id}-repeat-time`} label="Time">
                <input
                  id={`${id}-repeat-time`}
                  type="time"
                  value={when.time}
                  onChange={(event) => set({ time: event.target.value })}
                  className={FIELD}
                />
              </Field>
            </div>
          )}
          {when.preset === 'hourly' && (
            <Field id={`${id}-minute`} label="Minutes past the hour" hint="0 runs it on the hour.">
              <input
                id={`${id}-minute`}
                type="number"
                min={0}
                max={59}
                value={Number.isNaN(when.minute) ? '' : when.minute}
                aria-describedby={`${id}-minute-hint`}
                onChange={(event) => set({ minute: event.target.valueAsNumber })}
                className={cn(FIELD, 'w-28')}
              />
            </Field>
          )}
          {when.preset === 'custom' && (
            <Field
              id={`${id}-cron`}
              label="Cron expression"
              hint="Five fields: minute hour day-of-month month weekday, like 0 9 * * 1-5. Or @daily, @weekly."
            >
              <input
                id={`${id}-cron`}
                value={when.cron}
                spellCheck={false}
                autoComplete="off"
                aria-describedby={`${id}-cron-hint`}
                placeholder="0 9 * * 1-5"
                onChange={(event) => set({ cron: event.target.value })}
                className={cn(FIELD, 'font-mono')}
              />
            </Field>
          )}
          {cron && (
            <p className="text-xs text-[var(--text-muted)]" aria-live="polite">
              {described ?? 'A custom schedule'} · <span className="font-mono">{cron}</span>
            </p>
          )}
        </div>
      )}
      <Field
        id={`${id}-zone`}
        label="Time zone"
        hint={when.timezone === browserTimeZone() ? "This computer's time zone." : undefined}
      >
        <select
          id={`${id}-zone`}
          value={when.timezone}
          onChange={(event) => set({ timezone: event.target.value })}
          className={FIELD}
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/**
 * Making a schedule, or changing one: whose it is (on the global page), its
 * name and message, when, where it runs, and what to do about a time missed
 * while Pi Local was closed. The backend's refusals are shown in the dialog.
 */
export function ScheduleDialog({
  schedule,
  agents,
  agentId,
  onClose,
}: {
  schedule: Schedule | null;
  /** The agents to choose from; one agent's page passes just that one. */
  agents: Agent[];
  /** Fixed to this agent (its page), or the first one by default. */
  agentId?: string;
  onClose: () => void;
}) {
  const id = useId();
  const create = useCreateSchedule();
  const update = useUpdateSchedule();
  const [initial] = useState<ScheduleForm>(() =>
    scheduleFormOf(schedule, agentId ?? agents[0]?.id ?? ''),
  );
  const [form, setForm] = useState<ScheduleForm>(initial);
  const [tried, setTried] = useState(false);
  const problem = scheduleFormProblem(form);
  const busy = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  // Changing one: any enabled agent may take it over (the page's own list may be just one).
  const allAgents = useAgents().data;
  const choices = useMemo(
    () =>
      schedule
        ? (allAgents?.filter((agent) => agent.enabled || agent.id === schedule.agentId) ?? agents)
        : agents,
    [schedule, allAgents, agents],
  );
  const pickAgent = schedule ? choices.length > 1 : !agentId;
  const moved = schedule !== null && form.agentId !== initial.agentId;
  const newAgent = choices.find((agent) => agent.id === form.agentId);
  const threads = useAgentThreads(form.agentId || undefined);
  const set = (change: Partial<ScheduleForm>) => setForm((current) => ({ ...current, ...change }));

  const submit = () => {
    setTried(true);
    if (problem) return;
    const done = (saved: Schedule) => {
      toast(schedule ? `${saved.name} saved.` : `${saved.name} is scheduled.`);
      onClose();
    };
    if (schedule) {
      const changes = scheduleChanges(initial, form);
      if (Object.keys(changes).length === 0) return onClose();
      update.mutate({ id: schedule.id, ...changes }, { onSuccess: done });
    } else create.mutate({ agentId: form.agentId, ...scheduleInputOf(form) }, { onSuccess: done });
  };

  const threadOptions = threads.data ?? [];
  const missingThread =
    form.threadId && !threadOptions.some((thread) => thread.threadId === form.threadId);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{schedule ? `Edit ${schedule.name}` : 'New schedule'}</DialogTitle>
          <DialogDescription>
            The agent gets this message at the times you choose, as if you had sent it. Pi Local
            keeps running in the menu bar when its window is closed, so schedules still run.
          </DialogDescription>
        </DialogHeader>
        <form
          id={`${id}-form`}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {pickAgent && (
            <Field id={`${id}-agent`} label="Agent">
              <select
                id={`${id}-agent`}
                value={form.agentId}
                onChange={(event) => {
                  const next = event.target.value;
                  // Another agent doesn't have the conversation: runs start new ones. Back to
                  // the first agent, it is as it was.
                  set(
                    next === initial.agentId
                      ? {
                          agentId: next,
                          threadMode: initial.threadMode,
                          threadId: initial.threadId,
                        }
                      : { agentId: next, threadMode: 'new', threadId: '' },
                  );
                }}
                className={FIELD}
              >
                {choices.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              {moved && newAgent && (
                <p role="note" className="mt-1.5 text-xs text-[var(--text-muted)]">
                  {movedNotice(newAgent.name)}
                </p>
              )}
            </Field>
          )}
          <Field
            id={`${id}-name`}
            label={
              <>
                Name <Optional />
              </>
            }
            hint="Without one, the message's first line names it."
          >
            <input
              id={`${id}-name`}
              maxLength={SCHEDULE_NAME_MAX}
              value={form.name}
              aria-describedby={`${id}-name-hint`}
              onChange={(event) => set({ name: event.target.value })}
              placeholder="Morning briefing"
              className={FIELD}
            />
          </Field>
          <Field id={`${id}-message`} label="Message">
            <textarea
              id={`${id}-message`}
              rows={4}
              value={form.message}
              onChange={(event) => set({ message: event.target.value })}
              placeholder="Summarise my unread issues and what changed since yesterday."
              className={cn(FIELD, 'h-auto min-h-24 resize-y py-2 leading-relaxed')}
            />
          </Field>

          <WhenFields when={form.when} onChange={(when) => set({ when })} />

          {!moved && (
            <Choices
              legend="Where it runs"
              name={`${id}-thread-mode`}
              value={form.threadMode}
              options={[
                { id: 'new', label: 'A new conversation each time' },
                { id: 'this', label: 'Always the same conversation' },
              ]}
              onChange={(threadMode) => set({ threadMode })}
            />
          )}
          {!moved && form.threadMode === 'this' && (
            <Field id={`${id}-thread`} label="Conversation">
              <select
                id={`${id}-thread`}
                value={form.threadId}
                onChange={(event) => set({ threadId: event.target.value })}
                className={FIELD}
                disabled={threads.isPending}
              >
                <option value="">
                  {threads.isPending
                    ? 'Loading conversations…'
                    : threadOptions.length === 0
                      ? 'This agent has no conversations yet'
                      : 'Choose a conversation…'}
                </option>
                {missingThread && <option value={form.threadId}>{form.threadId}</option>}
                {threadOptions.map((thread) => (
                  <option key={thread.threadId} value={thread.threadId}>
                    {thread.title || thread.threadId}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Choices
            legend="If Pi Local was closed when it was due"
            name={`${id}-missed`}
            value={form.missedPolicy}
            options={[
              { id: 'run_once', label: 'Run it once when it opens' },
              { id: 'skip', label: 'Skip it' },
            ]}
            onChange={(missedPolicy) => set({ missedPolicy })}
          />

          {tried && problem && <ErrorNotice>{problem}</ErrorNotice>}
          {error && <ErrorNotice>{errorMessage(error)}</ErrorNotice>}
        </form>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} variant="primary" disabled={busy}>
            {busy && <Spinner className="size-4 text-current" />}
            {schedule ? 'Save' : 'Schedule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
