import { useId } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '~/api/client';
import { SettingsRow, SettingsSection } from '~/components/settings/settings-layout';
import { Switch } from '~/components/ui/switch';
import { useSaveChatSettings } from '~/hooks/use-chat-settings';
import { useFeature } from '~/hooks/use-session';

/**
 * Settings → Models → Per conversation: whether the message box lets a person
 * choose the model and thinking for each conversation. It is their own choice;
 * nothing picks a model for them.
 */
export function PerConversationSection() {
  const id = useId();
  const on = useFeature('modelPerConversation');
  const save = useSaveChatSettings();
  // What was just chosen shows at once, while the change is saved.
  const checked = save.isPending ? save.variables.modelPerConversation : on;
  return (
    <SettingsSection title="Per conversation">
      <SettingsRow
        id={id}
        label="Choose the model and thinking for each conversation in the message box"
        description="Off: every conversation uses its agent's model."
      >
        <Switch
          checked={checked}
          disabled={save.isPending}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-description`}
          onCheckedChange={(modelPerConversation) =>
            save.mutate(
              { modelPerConversation },
              { onError: (error) => toast.error(errorMessage(error, 'Not changed.')) },
            )
          }
        />
      </SettingsRow>
    </SettingsSection>
  );
}
