import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Bot, Plus } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { writeHandover } from '~/hooks/use-agent-thread';
import { chattable, newThreadId, noteNewThread, useAgents } from '~/hooks/use-agents';
import type { CommandPaletteProps, PaletteGroup, PaletteItem } from './types';
import { usePaletteActions } from './use-palette-actions';

function matches(item: PaletteItem, query: string) {
  if (!query) return true;
  return `${item.label} ${item.keywords ?? ''}`.toLocaleLowerCase().includes(query);
}

export function useCommandPaletteState({
  open,
  onOpenChange,
  sidebarOpen,
  onSidebarOpenChange,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useAgents();
  const agents = useMemo(() => chattable(data), [data]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const keepFocusOnClose = useRef(false);

  const normalizedQuery = query.trim().toLocaleLowerCase();

  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [open]);

  const actionGroups = usePaletteActions({ sidebarOpen, onSidebarOpenChange });

  const groups = useMemo<PaletteGroup[]>(() => {
    const nextGroups: PaletteGroup[] = [];

    const agentItems: PaletteItem[] = agents
      .map((agent) => ({
        id: `agent-${agent.id}`,
        label: `New chat with ${agent.name}`,
        keywords: `agent ${agent.name} ${agent.description} ${agent.agentKind}`,
        icon: Bot,
        keepFocusOnClose: true,
        onSelect: () => navigate({ to: '/', search: { agent: agent.id } }),
      }))
      .filter((item) => matches(item, normalizedQuery));
    if (agentItems.length) nextGroups.push({ id: 'agents', label: 'Agents', items: agentItems });

    for (const group of actionGroups) {
      const items = group.items.filter((item) => matches(item, normalizedQuery));
      if (items.length > 0) nextGroups.push({ ...group, items });
    }

    const prompt = query.trim();
    // The query as a first message, to the agent last used (or the first).
    const lastId = localStorage.getItem('pai.lastAgent');
    const target = agents.find((agent) => agent.id === lastId) ?? agents[0];
    if (prompt && target) {
      nextGroups.push({
        id: 'query-action',
        label: 'Actions',
        items: [
          {
            id: 'ask-agent',
            label: `Ask ${target.name}: \u201c${prompt}\u201d`,
            keywords: prompt,
            icon: Plus,
            keepFocusOnClose: true,
            onSelect: async () => {
              const threadId = newThreadId();
              writeHandover({
                agentId: target.id,
                threadId,
                text: prompt,
                requestId: crypto.randomUUID(),
                focus: true,
              });
              noteNewThread(queryClient, target.id, threadId, prompt);
              await navigate({
                to: '/agents/$agentId/threads/$threadId',
                params: { agentId: target.id, threadId },
              });
            },
          },
        ],
      });
    }

    return nextGroups;
  }, [actionGroups, agents, navigate, normalizedQuery, query, queryClient]);

  const items = groups.flatMap((group) => group.items);
  const itemIds = items.map((item) => item.id).join('|');
  const safeSelectedIndex = items.length > 0 ? Math.min(selectedIndex, items.length - 1) : -1;
  const selectedItem = safeSelectedIndex >= 0 ? items[safeSelectedIndex] : undefined;
  const selectedItemId = selectedItem?.id;

  useEffect(() => {
    if (!open || !selectedItemId) return;
    document
      .getElementById(`oci-command-palette-option-${selectedItemId}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, selectedItemId]);

  // Reset to the first best match whenever the result set changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemIds intentionally tracks result identity
  useEffect(() => setSelectedIndex(0), [query, itemIds]);

  async function selectItem(item: PaletteItem | undefined) {
    if (!item) return;

    try {
      await item.onSelect();
      // The conversation moves focus to the matched message; restoring focus
      // to whatever opened the palette would take it straight back.
      keepFocusOnClose.current = Boolean(item.keepFocusOnClose);
      onOpenChange(false);
    } catch {
      // Mutation hooks retain the request error; keep the palette open for retry.
    }
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((current) => (items.length > 0 ? (current + 1) % items.length : 0));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((current) =>
        items.length > 0 ? (current - 1 + items.length) % items.length : 0,
      );
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      setSelectedIndex(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      setSelectedIndex(Math.max(0, items.length - 1));
      return;
    }

    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void selectItem(selectedItem);
    }
  }

  const showThreadProgress = false;
  const threadAnnouncement = '';

  /** Read once by the dialog's close handler, then reset. */
  function consumeKeepFocus() {
    const keep = keepFocusOnClose.current;
    keepFocusOnClose.current = false;
    return keep;
  }

  return {
    inputRef,
    query,
    setQuery,
    selectedItem,
    groups,
    items,
    safeSelectedIndex,
    setSelectedIndex,
    selectItem,
    handleInputKeyDown,
    showThreadProgress,
    threadAnnouncement,
    consumeKeepFocus,
  };
}
