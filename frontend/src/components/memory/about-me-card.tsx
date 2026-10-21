import { useId, useState } from 'react';
import { toast } from 'sonner';
import type { Basics, YouInfo } from '~/api/client';
import { FIELD, RequestError } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useSaveBasics } from '~/hooks/use-memory';
import { BASICS_FIELDS } from '~/lib/memory';
import { cn } from '~/lib/utils';

/** The About me card: the basics every agent with memory on sees. */
export function AboutMeCard({ you }: { you: YouInfo }) {
  return (
    <AboutMeForm
      // A save (or an erase) starts the form again from what is saved.
      key={`${you.saved}|${JSON.stringify(you.basics)}`}
      saved={you.basics}
      prefilled={!you.saved}
    />
  );
}

function AboutMeForm({ saved, prefilled }: { saved: Basics; prefilled: boolean }) {
  const id = useId();
  const [form, setForm] = useState<Basics>(saved);
  const save = useSaveBasics();
  const trimmed = Object.fromEntries(
    Object.entries(form).map(([key, value]) => [key, value.trim()]),
  ) as unknown as Basics;
  const dirty = BASICS_FIELDS.some(({ key }) => trimmed[key] !== saved[key]);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (save.isPending || (!dirty && !prefilled)) return;
        void save.mutateAsync(trimmed).then(
          () => toast('About me saved.'),
          () => undefined,
        );
      }}
    >
      {prefilled && (
        <p className="text-xs text-[var(--text-muted)]" data-prefilled="">
          Prefilled from this computer. Check it and save.
        </p>
      )}
      <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
        {BASICS_FIELDS.map((field) => {
          const inputId = `${id}-${field.key}`;
          return (
            <div key={field.key} className="flex flex-col gap-1.5">
              <label htmlFor={inputId} className="text-sm font-medium">
                {field.label}
              </label>
              <input
                id={inputId}
                value={form[field.key]}
                onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}
                placeholder={field.placeholder}
                maxLength={200}
                autoComplete="off"
                aria-describedby={`${inputId}-hint`}
                className={cn(FIELD)}
              />
              <p id={`${inputId}-hint`} className="text-xs text-[var(--text-muted)]">
                {field.hint}
              </p>
            </div>
          );
        })}
      </div>
      <RequestError error={save.error} what="About me" />
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={save.isPending || (!dirty && !prefilled)}>
          {save.isPending && <Spinner className="size-4 text-current" />}
          Save
        </Button>
        {dirty && (
          <Button
            type="button"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => {
              setForm(saved);
              save.reset();
            }}
          >
            Undo changes
          </Button>
        )}
      </div>
    </form>
  );
}
