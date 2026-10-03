/**
 * Applies the user's default disappearing-message timer to chats they start.
 * Called right after create_direct_conversation / create_group_conversation;
 * only a brand-new chat (no messages on the server, no timer locally) gets
 * the timer, announced to the other members with the normal E2EE timer
 * message, exactly as if the user had picked it from the chat menu.
 */

import { supabase } from '../../core/network/supabase';
import { currentSession } from '../../core/session';
import { databaseService } from '../../core/storage/DatabaseService';
import { defaultTimerForNewChat } from './privacy';
import { useSettingsStore } from './useSettingsStore';

export async function applyDefaultDisappearing(conversationId: string): Promise<void> {
  const session = currentSession();
  if (!session || session.isDemo) return;
  const seconds = useSettingsStore.getState().defaultDisappearingSeconds;
  if (!seconds) return;
  try {
    const [{ data, error }, currentTimerSeconds] = await Promise.all([
      supabase.from('messages').select('id').eq('conversation_id', conversationId).limit(1),
      databaseService.getDisappearingTimer(conversationId),
    ]);
    if (error) throw error;
    const timer = defaultTimerForNewChat({ defaultDisappearingSeconds: seconds }, {
      hasMessages: (data?.length ?? 0) > 0,
      currentTimerSeconds,
    });
    if (timer === null) return;
    // Lazy import: the message layer imports the chats layer, which calls us.
    const { messageRepository } = await import('../messages/MessageRepository');
    await messageRepository.setDisappearingTimer(session, conversationId, timer);
  } catch (e) {
    console.warn('[Settings] could not apply the default timer:', (e as Error)?.message);
  }
}
