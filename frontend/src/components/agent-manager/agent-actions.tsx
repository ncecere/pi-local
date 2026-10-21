import { useNavigate } from '@tanstack/react-router';
import { BookmarkPlus, Copy, Download, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { type Agent, errorMessage } from '~/api/client';
import { ConfirmDialog, ErrorNotice, FIELD, Field, Optional } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Spinner } from '~/components/ui/spinner';
import { useDeleteAgent, useDuplicateAgent, useExportAgent } from '~/hooks/use-agent-manager';
import { useSaveAsTemplate } from '~/hooks/use-templates';

/** Duplicate, Save as template, Export (with or without conversations) and Delete, for one agent. */
export function AgentActions({
  agent,
  deleting,
  setDeleting,
}: {
  agent: Agent;
  deleting: boolean;
  setDeleting: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const duplicate = useDuplicateAgent();
  const exportAgent = useExportAgent();
  const remove = useDeleteAgent();
  const [savingTemplate, setSavingTemplate] = useState(false);

  const runExport = (conversations: boolean) =>
    exportAgent.mutate(
      { agent, conversations },
      {
        onSuccess: (filename) => {
          if (filename) toast(`Exported ${agent.name} to ${filename}.`);
        },
        onError: (error) => toast.error(errorMessage(error, 'Not exported.')),
      },
    );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={duplicate.isPending}
        onClick={() =>
          duplicate.mutate(
            { id: agent.id },
            {
              onSuccess: (copy) => {
                toast(`${copy.name} made.`);
                void navigate({ to: '/settings/agents/$agentId', params: { agentId: copy.id } });
              },
              onError: (error) => toast.error(errorMessage(error, 'Not duplicated.')),
            },
          )
        }
      >
        {duplicate.isPending ? <Spinner className="size-3.5 text-current" /> : <Copy />}
        Duplicate
      </Button>
      <Button type="button" size="sm" variant="secondary" onClick={() => setSavingTemplate(true)}>
        <BookmarkPlus />
        Save as template
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="secondary" disabled={exportAgent.isPending}>
            {exportAgent.isPending ? <Spinner className="size-3.5 text-current" /> : <Download />}
            Export
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem onSelect={() => runExport(false)}>
            <span className="flex flex-col">
              <span className="text-[var(--text-primary)]">Settings only</span>
              <span className="text-xs text-[var(--text-muted)]">
                Its agent.yaml: a fresh copy anywhere.
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => runExport(true)}>
            <span className="flex flex-col">
              <span className="text-[var(--text-primary)]">With conversations</span>
              <span className="text-xs text-[var(--text-muted)]">
                Also its memory and conversations. It is put to sleep first.
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button type="button" size="sm" variant="ghost" onClick={() => setDeleting(true)}>
        <Trash2 />
        Delete
      </Button>

      {savingTemplate && (
        <SaveTemplateDialog agent={agent} onClose={() => setSavingTemplate(false)} />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${agent.name}?`}
          description={
            <>
              The agent stops, and its folder (its memory and all its conversations) moves to the
              Trash. Teams it leads are deleted; other agents can no longer ask it.
            </>
          }
          action="Delete"
          what={agent.name}
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await remove.mutateAsync(agent.id);
            toast(`${agent.name} deleted.`);
            void navigate({ to: '/settings/agents' });
          }}
        />
      )}
    </div>
  );
}

/**
 * Save as template: the agent's kind, instructions, tools and approvals become
 * a template of the person's own ("Yours" in the New agent gallery).
 */
function SaveTemplateDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const id = useId();
  const save = useSaveAsTemplate();
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const submit = () =>
    save.mutate(
      {
        agentId: agent.id,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      },
      {
        onSuccess: () => {
          toast('Saved as a template.');
          onClose();
        },
      },
    );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save as template</DialogTitle>
          <DialogDescription>
            New agents can start from it: its instructions, tools and approvals. Not its memory or
            conversations.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && !save.isPending) submit();
          }}
        >
          <Field id={`${id}-name`} label="Name">
            <input
              id={`${id}-name`}
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={FIELD}
            />
          </Field>
          <Field
            id={`${id}-description`}
            label={
              <>
                Description <Optional />
              </>
            }
          >
            <input
              id={`${id}-description`}
              maxLength={500}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className={FIELD}
            />
          </Field>
          {save.error && <ErrorNotice>{errorMessage(save.error)}</ErrorNotice>}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim() || save.isPending}>
              {save.isPending && <Spinner className="size-4 text-current" />}
              Save template
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
