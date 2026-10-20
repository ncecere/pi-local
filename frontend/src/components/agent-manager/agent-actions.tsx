import { useNavigate } from '@tanstack/react-router';
import { Copy, Download, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { type Agent, errorMessage } from '~/api/client';
import { ConfirmDialog } from '~/components/models/fields';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Spinner } from '~/components/ui/spinner';
import { useDeleteAgent, useDuplicateAgent, useExportAgent } from '~/hooks/use-agent-manager';

/** Duplicate, Export (with or without conversations) and Delete, for one agent. */
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
