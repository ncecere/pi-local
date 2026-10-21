import { Link } from '@tanstack/react-router';
import {
  BookOpen,
  Bot,
  Brain,
  Briefcase,
  CalendarClock,
  Code,
  Download,
  Ellipsis,
  FileText,
  Globe,
  Heart,
  Languages,
  Lightbulb,
  ListChecks,
  type LucideIcon,
  Mail,
  PenLine,
  Search,
  Sparkles,
  Sunrise,
  Terminal,
  Trash2,
  Upload,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { type AgentTemplate, ApiError, errorMessage } from '~/api/client';
import { ConfirmDialog, ErrorNotice } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Spinner } from '~/components/ui/spinner';
import { useDeleteTemplate, useExportTemplate, useImportTemplate } from '~/hooks/use-templates';
import { groupTemplates, needsWebSearch, templateChipDetails } from '~/lib/templates';
import { cn } from '~/lib/utils';

/** The lucide icons templates may name; anything else gets a sparkle. */
const ICONS: Record<string, LucideIcon> = {
  'book-open': BookOpen,
  bot: Bot,
  brain: Brain,
  briefcase: Briefcase,
  'calendar-clock': CalendarClock,
  code: Code,
  'file-text': FileText,
  globe: Globe,
  heart: Heart,
  languages: Languages,
  lightbulb: Lightbulb,
  'list-checks': ListChecks,
  mail: Mail,
  'pen-line': PenLine,
  search: Search,
  sparkles: Sparkles,
  sunrise: Sunrise,
  terminal: Terminal,
};

export function TemplateIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? Sparkles;
  return <Icon className={className} aria-hidden="true" />;
}

/**
 * The New agent gallery: a card per template, grouped by category, as one
 * radio group. The person's own templates ("Yours") have a menu with Export
 * and Delete; Import template… adds a shared one.
 */
export function TemplateGallery({
  id,
  templates,
  selectedId,
  onSelect,
}: {
  id: string;
  templates: readonly AgentTemplate[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [importError, setImportError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState<AgentTemplate | null>(null);
  const remove = useDeleteTemplate();
  const groups = groupTemplates(templates);

  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
      <legend className="sr-only">Start from</legend>
      <div className="flex items-center justify-between gap-3">
        <span aria-hidden="true" className="text-sm font-medium">
          Start from
        </span>
        <ImportTemplateButton
          onError={setImportError}
          onImported={(template) => onSelect(template.id)}
        />
      </div>
      {importError ? (
        <ErrorNotice>
          {importError instanceof ApiError && importError.code === 'invalid_template'
            ? `That file can't be imported: ${importError.message}`
            : errorMessage(importError, 'Not imported.')}
        </ErrorNotice>
      ) : null}
      {groups.map((group) => (
        <fieldset key={group.category} className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-1.5 text-xs font-semibold text-[var(--text-muted)]">
            {group.label}
          </legend>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {group.templates.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                name={`${id}-template`}
                checked={template.id === selectedId}
                onSelect={() => onSelect(template.id)}
                onDelete={() => setDeleting(template)}
              />
            ))}
          </ul>
        </fieldset>
      ))}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          description="The template goes from the gallery. Agents made from it keep working."
          action="Delete"
          what={deleting.name}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toast(`${deleting.name} deleted.`);
            if (deleting.id === selectedId) {
              const first = templates.find((template) => template.id !== deleting.id);
              if (first) onSelect(first.id);
            }
          }}
        />
      )}
    </fieldset>
  );
}

function TemplateCard({
  template,
  name,
  checked,
  onSelect,
  onDelete,
}: {
  template: AgentTemplate;
  name: string;
  checked: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const exportTemplate = useExportTemplate();
  return (
    <li className="relative">
      <label
        className={cn(
          'flex h-full cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors',
          'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent-bright)]',
          checked
            ? 'border-[var(--accent-button-border)] bg-[var(--accent-soft)]'
            : 'border-[var(--border-subtle)] hover:bg-[var(--bg-control)]/60',
          !template.builtin && 'pr-9',
        )}
      >
        <input
          type="radio"
          name={name}
          value={template.id}
          checked={checked}
          onChange={onSelect}
          className="sr-only"
        />
        <TemplateIcon
          name={template.icon}
          className={cn(
            'mt-0.5 size-4 shrink-0',
            checked ? 'text-[var(--accent-bright)]' : 'text-[var(--text-muted)]',
          )}
        />
        <span className="min-w-0">
          <span className="block font-medium">{template.name}</span>
          {template.description && (
            <span
              className="line-clamp-2 text-xs text-[var(--text-muted)]"
              title={template.description}
            >
              {template.description}
            </span>
          )}
        </span>
      </label>
      {!template.builtin && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`More for ${template.name}`}
              title="More"
              className="absolute right-1.5 top-1.5"
            >
              {exportTemplate.isPending ? <Spinner className="size-3.5" /> : <Ellipsis />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44 min-w-0">
            <DropdownMenuItem
              onSelect={() =>
                exportTemplate.mutate(template, {
                  onSuccess: (filename) => {
                    if (filename) toast(`Exported ${template.name} to ${filename}.`);
                  },
                  onError: (error) => toast.error(errorMessage(error, 'Not exported.')),
                })
              }
            >
              <Download />
              Export
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDelete}>
              <Trash2 />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

/**
 * Import template…: a .yaml file someone shared (an export). Its text is sent
 * as the raw body; the new template is selected.
 */
function ImportTemplateButton({
  onError,
  onImported,
}: {
  onError: (error: unknown) => void;
  onImported: (template: AgentTemplate) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const importTemplate = useImportTemplate();
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".yaml,.yml,application/yaml,text/yaml"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="import-template-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // The same file can be picked again after a failure.
          event.target.value = '';
          if (!file) return;
          onError(null);
          importTemplate.mutate(file, {
            onSuccess: (template) => {
              toast(`${template.name} imported.`);
              onImported(template);
            },
            onError,
          });
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={importTemplate.isPending}
        onClick={() => input.current?.click()}
      >
        {importTemplate.isPending ? <Spinner className="size-3.5 text-current" /> : <Upload />}
        Import template…
      </Button>
    </>
  );
}

/** What the chosen template brings, and what to set up for it. */
export function TemplateSummary({
  template,
  webSearchReady,
}: {
  template: AgentTemplate;
  /** Null: not known. */
  webSearchReady: boolean | null;
}) {
  const chips = templateChipDetails(template);
  const hint = needsWebSearch(template) && webSearchReady === false;
  if (chips.length === 0 && !hint) return null;
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      {chips.length > 0 && (
        <ul aria-label={`What ${template.name} brings`} className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <li
              key={chip.label}
              title={chip.title}
              className="rounded-full bg-[var(--bg-control)] px-2.5 py-0.5 text-xs text-[var(--text-secondary)]"
            >
              {chip.label}
            </li>
          ))}
        </ul>
      )}
      {hint && (
        <p className="text-xs text-[var(--text-muted)]">
          Works best with web search: set it up in{' '}
          <Link
            to="/settings/models"
            className="text-[var(--accent-bright)] underline-offset-4 hover:underline"
          >
            Settings → Models
          </Link>
          .
        </p>
      )}
    </div>
  );
}
