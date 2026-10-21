import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { Agent } from '~/api/client';
import { usePrompts } from '~/hooks/use-prompts';
import { useFeature } from '~/hooks/use-session';
import { buildSlashCommands, type SlashCommand } from '~/lib/slash-commands';

/**
 * The composer's slash commands (buildSlashCommands) for this agent and this page: the built-ins that make sense, then
 * the prompt library.
 */
export function useSlashCommands({
  agent,
  working = false,
  onNew,
  onModel,
  onStop,
}: {
  agent?: Agent | undefined;
  /** The agent is working on a reply. */
  working?: boolean;
  /** Start a new conversation with this agent (a conversation page; the new chat page already is one). */
  onNew?: () => void;
  /** Open the model picker. */
  onModel?: () => void;
  /** Stop the reply in progress. */
  onStop?: () => void;
}): SlashCommand[] {
  const navigate = useNavigate();
  const modelChoice = useFeature('modelPerConversation');
  const prompts = usePrompts().data;
  return useMemo(
    () =>
      buildSlashCommands({
        agent,
        working,
        modelChoice,
        prompts: prompts ?? [],
        onNew,
        onModel,
        onStop,
        onManagePrompts: () => void navigate({ to: '/settings/prompts' }),
      }),
    [agent, working, modelChoice, prompts, onNew, onModel, onStop, navigate],
  );
}
