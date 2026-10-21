import { Download, RefreshCw, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '~/api/client';
import { AboutMeCard } from '~/components/memory/about-me-card';
import { AddFactForm, FactList, SuggestionList } from '~/components/memory/facts';
import { ALWAYS_SHARED_NOTE, MemoryAccessTable } from '~/components/memory/memory-access';
import { ErrorNotice, FIELD, RequestError } from '~/components/models/fields';
import { SettingsRow, SettingsSection } from '~/components/settings/settings-layout';
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
import { Switch } from '~/components/ui/switch';
import { useAgents } from '~/hooks/use-agents';
import {
  useEraseYou,
  useExportYou,
  useFacts,
  useSaveSuggestions,
  useYou,
} from '~/hooks/use-memory';
import { usePageTitle } from '~/lib/document-title';
import { plural } from '~/lib/utils';

export const PRIVACY_NOTE =
  'All of this is stored on this computer. It is sent only to the model provider each agent uses.';

/**
 * Settings → You: what agents know about the person. The About me card, the
 * facts agents saved (and suggestions waiting for a yes), which agents see
 * which categories, and export or erase.
 */
export function SettingsYouPage() {
  usePageTitle('You · Settings');
  const you = useYou();
  const facts = useFacts();
  const agents = useAgents();

  if (you.isError)
    return (
      <SettingsSection title="You" first>
        <ErrorNotice>
          What agents know about you could not be read: {errorMessage(you.error)}
        </ErrorNotice>
        <div>
          <Button type="button" variant="secondary" onClick={() => void you.refetch()}>
            <RefreshCw />
            Try again
          </Button>
        </div>
      </SettingsSection>
    );
  if (!you.data)
    return (
      <div className="py-12">
        <Spinner className="mx-auto" />
      </div>
    );

  const { categories, shareable } = you.data;
  const suggestions = you.data.suggestions ?? { enabled: false, judged: false };
  const known = facts.data?.filter((fact) => fact.status === 'active') ?? [];
  const suggested = facts.data?.filter((fact) => fact.status === 'suggested') ?? [];

  return (
    <>
      {suggested.length > 0 && (
        <SettingsSection title="Suggestions waiting" first>
          <p className="-mt-2 text-sm text-[var(--text-muted)]">
            {suggested.length === 1
              ? "An agent wants to remember this about you. It isn't used until you accept it."
              : `Agents want to remember ${plural(suggested.length, 'thing')} about you. They aren't used until you accept them.`}
          </p>
          <SuggestionList facts={suggested} categories={categories} />
        </SettingsSection>
      )}

      <SettingsSection title="About me" first={suggested.length === 0}>
        <p className="-mt-2 text-sm text-[var(--text-muted)]">
          The basics every agent with memory on knows about you. {PRIVACY_NOTE}
        </p>
        <AboutMeCard you={you.data} />
      </SettingsSection>

      <SettingsSection title="What agents know about you">
        <p className="-mt-2 text-sm text-[var(--text-muted)]">
          What you told agents, or accepted from them. Each agent sees your preferences, and the
          other categories you share with it below.
        </p>
        {facts.isError ? (
          <ErrorNotice>{errorMessage(facts.error, 'These could not be read.')}</ErrorNotice>
        ) : !facts.data ? (
          <Spinner />
        ) : (
          <FactList facts={known} categories={categories} />
        )}
        <AddFactForm categories={categories} />
      </SettingsSection>

      <SettingsSection title="Suggestions from conversations">
        <SuggestionsSwitch enabled={suggestions.enabled} judged={suggestions.judged} />
      </SettingsSection>

      <SettingsSection title="Which agents see what">
        <p className="-mt-2 text-sm text-[var(--text-muted)]">
          {ALWAYS_SHARED_NOTE} Tick the other categories each one may see. An agent with memory off
          sees none of it and keeps no notes.
        </p>
        {agents.isError ? (
          <ErrorNotice>{errorMessage(agents.error, 'The agents could not be read.')}</ErrorNotice>
        ) : !agents.data ? (
          <Spinner />
        ) : (
          <MemoryAccessTable agents={agents.data} shareable={shareable} />
        )}
      </SettingsSection>

      <SettingsSection title="Your data">
        <p className="-mt-2 text-sm text-[var(--text-muted)]">{PRIVACY_NOTE}</p>
        <DataActions />
      </SettingsSection>
    </>
  );
}

/** The one system-wide switch for agents suggesting what to remember from a conversation. */
function SuggestionsSwitch({ enabled, judged }: { enabled: boolean; judged: boolean }) {
  const save = useSaveSuggestions();
  return (
    <div className="flex flex-col gap-3">
      <SettingsRow
        id="memory-suggestions"
        label="Suggest things to remember"
        description={
          <>
            When a conversation has been quiet for 10 minutes after a reply, the agent's model reads
            what is new in it and suggests up to 3 things worth remembering about you. Each waits
            above until you accept or dismiss it. Conversations a schedule started, or another agent
            asked in, are never read. This sends the conversation's text to the model provider that
            agent already uses.
            {judged
              ? ' Fast judgments check each suggestion first, so one-off details are dropped.'
              : ''}
          </>
        }
      >
        <Switch
          checked={enabled}
          disabled={save.isPending}
          aria-labelledby="memory-suggestions-label"
          aria-describedby="memory-suggestions-description"
          onCheckedChange={(on) =>
            save.mutate(on, {
              onError: (error) =>
                toast.error(errorMessage(error, 'The setting could not be saved.')),
            })
          }
        />
      </SettingsRow>
      <p className="text-xs text-[var(--text-muted)]">
        When a long conversation is compacted, what is about to be summarized is read the same way,
        so a fact isn't lost to the summary.
      </p>
    </div>
  );
}

function DataActions() {
  const exportYou = useExportYou();
  const [erasing, setErasing] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={exportYou.isPending}
          onClick={() =>
            exportYou.mutate(undefined, {
              onError: (error) => toast.error(errorMessage(error, 'The export failed.')),
            })
          }
        >
          {exportYou.isPending ? <Spinner className="size-4 text-current" /> : <Download />}
          Export
        </Button>
        <Button type="button" variant="danger" onClick={() => setErasing(true)}>
          <Trash2 />
          Erase everything
        </Button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Export saves everything about you as a JSON file. Erasing forgets all of it, the About me
        card included. Agents' own notes stay: reset them in each agent's Memory tab.
      </p>
      {erasing && <EraseDialog onClose={() => setErasing(false)} />}
    </div>
  );
}

function EraseDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const [typed, setTyped] = useState('');
  const erase = useEraseYou();
  const confirmed = typed.trim() === 'erase';
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!confirmed || erase.isPending) return;
            void erase.mutateAsync().then(
              () => {
                toast('Everything about you is erased.');
                onClose();
              },
              () => undefined,
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Erase everything about you?</DialogTitle>
            <DialogDescription>
              Agents forget your About me card, everything they know about you, and every
              suggestion. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex flex-col gap-1.5">
            <label htmlFor={`${id}-confirm`} className="text-sm font-medium">
              Type "erase" to confirm
            </label>
            <input
              id={`${id}-confirm`}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className={FIELD}
            />
          </div>
          <div className="mt-3">
            <RequestError error={erase.error} what="It" />
          </div>
          <DialogFooter className="mt-4">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={!confirmed || erase.isPending}>
              {erase.isPending && <Spinner className="size-4 text-current" />}
              Erase everything
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
