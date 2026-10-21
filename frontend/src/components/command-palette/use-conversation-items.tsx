import { useNavigate } from '@tanstack/react-router';
import { MessageSquare, MessageSquareText } from 'lucide-react';
import { useMemo } from 'react';
import { SearchSnippet } from '~/components/layout/search-snippet';
import { useInbox } from '~/hooks/use-inbox';
import { useMessageSearch } from '~/hooks/use-message-search';
import { matchConversations } from '~/lib/conversation-search';
import type { PaletteItem } from './types';

/**
 * Conversations for the palette's query, as the sidebar's search finds them:
 * by title, then by a word in their messages (`GET /api/search`, the same
 * query and cache as the sidebar's "In messages"). Enter opens one; a message
 * match opens at that message.
 */
export function useConversationItems(
  query: string,
  open: boolean,
): { items: PaletteItem[]; pending: boolean; failed: boolean } {
  const navigate = useNavigate();
  const inbox = useInbox();
  const messages = useMessageSearch(open ? query : '');
  const agentNames = useMemo(
    () => new Map(inbox.agents.map((agent) => [agent.id, agent.name])),
    [inbox.agents],
  );
  const multi = inbox.agents.length > 1;

  const items = useMemo<PaletteItem[]>(() => {
    if (!open) return [];
    return matchConversations(inbox.entries, messages.hits, query).map(({ entry, hit }) => {
      const agentName = agentNames.get(entry.agentId);
      return {
        id: `conversation-${entry.key}`,
        label: entry.title,
        icon: hit ? MessageSquareText : MessageSquare,
        content: (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <span dir="auto" className="min-w-0 flex-1 truncate">
                {entry.title}
              </span>
              {multi && agentName && (
                <span className="shrink-0 truncate text-xs text-[var(--text-muted)]">
                  {agentName}
                </span>
              )}
            </span>
            {hit && <SearchSnippet text={hit.snippet} />}
          </>
        ),
        // The conversation takes focus (to the matched message, or its message box).
        keepFocusOnClose: true,
        onSelect: () =>
          navigate({
            to: '/agents/$agentId/threads/$threadId',
            params: { agentId: entry.agentId, threadId: entry.threadId },
            // Opened at the message the snippet came from (thread.tsx), as from the sidebar.
            ...(hit ? { search: { find: hit.snippet } } : {}),
          }),
      };
    });
  }, [open, inbox.entries, messages.hits, query, agentNames, multi, navigate]);

  return { items, pending: messages.pending, failed: messages.failed };
}
