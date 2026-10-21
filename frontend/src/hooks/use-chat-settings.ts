import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ChatSettings } from '~/api/client';
import { ME_KEY } from '~/hooks/use-session';

/**
 * Whether people choose the model and thinking for each conversation in the
 * message box (docs/api.md "Model per conversation"). `GET /api/me` says
 * whether it is on (`features.modelPerConversation`), so saving reads that again.
 */
export function useSaveChatSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { modelPerConversation: boolean }) =>
      api.put<ChatSettings>('/api/settings/chat', body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ME_KEY }),
  });
}
