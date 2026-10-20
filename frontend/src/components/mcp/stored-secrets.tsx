import { Eye, EyeOff, Trash2, Undo2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '~/api/client';
import { FIELD, HeadersEditor, Optional } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import type { SecretRow } from '~/lib/mcp';
import { cn } from '~/lib/utils';

/**
 * Changes to a server's stored env values or headers, one name at a time: a new value for some, some removed, the
 * rest kept as they are. Values stay in the keychain; one is fetched only when the person asks to see it.
 */
export interface StoredEdit {
  /** New values typed, by name. */
  values: Record<string, string>;
  removed: string[];
  /** Values fetched to show, by name (the stored ones). */
  revealed: Record<string, string>;
  /** Names shown in plain text now. */
  visible: string[];
  /** Names to add, with their values. */
  added: SecretRow[];
}

export const NO_EDIT: StoredEdit = {
  values: {},
  removed: [],
  revealed: {},
  visible: [],
  added: [],
};

/** The values that change: typed, not removed, and not just the stored value shown back. */
export function changedValues(edit: StoredEdit): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(edit.values)) {
    if (value === '' || edit.removed.includes(name) || edit.revealed[name] === value) continue;
    out[name] = value;
  }
  return out;
}

/** Whether anything would change. */
export function isEdited(edit: StoredEdit): boolean {
  return (
    Object.keys(changedValues(edit)).length > 0 ||
    edit.removed.length > 0 ||
    edit.added.some((row) => row.name.trim() !== '' || row.value !== '')
  );
}

export function StoredSecretsField({
  legend,
  noun,
  namePlaceholder,
  names,
  edit,
  onChange,
  reveal,
  hint,
}: {
  legend: string;
  /** What one is, lower case: "variable", "header". */
  noun: string;
  namePlaceholder: string;
  /** The names stored now. */
  names: string[];
  edit: StoredEdit;
  onChange: (edit: StoredEdit) => void;
  /** The stored value of one name. */
  reveal: (name: string) => Promise<string>;
  hint?: ReactNode;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const toggleVisible = async (name: string) => {
    if (edit.visible.includes(name)) {
      onChange({ ...edit, visible: edit.visible.filter((n) => n !== name) });
      return;
    }
    if (name in edit.revealed || name in edit.values) {
      onChange({ ...edit, visible: [...edit.visible, name] });
      return;
    }
    setLoading(name);
    try {
      const value = await reveal(name);
      onChange({
        ...edit,
        revealed: { ...edit.revealed, [name]: value },
        visible: [...edit.visible, name],
      });
    } catch (error) {
      toast.error(`Couldn't show ${name}`, { description: errorMessage(error) });
    } finally {
      setLoading(null);
    }
  };

  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1.5 text-sm font-medium">
        {legend} <Optional />
      </legend>
      {hint && <p className="-mt-1 text-xs text-[var(--text-muted)]">{hint}</p>}
      {names.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label={`Current ${noun}s`}>
          {names.map((name) => {
            const removed = edit.removed.includes(name);
            const visible = edit.visible.includes(name);
            const value = edit.values[name] ?? edit.revealed[name] ?? '';
            return (
              <li key={name} className="flex items-center gap-2">
                <span
                  title={name}
                  className={cn(
                    'min-w-0 flex-1 truncate font-mono text-xs',
                    removed && 'text-[var(--text-muted)] line-through',
                  )}
                >
                  {name}
                </span>
                <input
                  type={visible ? 'text' : 'password'}
                  aria-label={`${name} value`}
                  value={removed ? '' : value}
                  disabled={removed}
                  onChange={(event) =>
                    onChange({ ...edit, values: { ...edit.values, [name]: event.target.value } })
                  }
                  placeholder={removed ? 'Removed when you save' : 'Unchanged'}
                  autoComplete="new-password"
                  spellCheck={false}
                  className={cn(FIELD, 'flex-1', visible && 'font-mono text-xs')}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={removed || loading === name}
                  aria-label={visible ? `Hide ${name}` : `Show ${name}`}
                  title={visible ? 'Hide' : 'Show'}
                  onClick={() => void toggleVisible(name)}
                >
                  {visible ? <EyeOff /> : <Eye />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={removed ? `Keep ${name}` : `Remove ${name}`}
                  title={removed ? 'Keep' : 'Remove'}
                  onClick={() =>
                    onChange({
                      ...edit,
                      removed: removed
                        ? edit.removed.filter((n) => n !== name)
                        : [...edit.removed, name],
                    })
                  }
                >
                  {removed ? <Undo2 /> : <Trash2 />}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <HeadersEditor
        rows={edit.added}
        onChange={(added) => onChange({ ...edit, added })}
        noun={noun}
        namePlaceholder={namePlaceholder}
      />
    </fieldset>
  );
}
