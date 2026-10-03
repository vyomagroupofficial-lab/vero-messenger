/**
 * Muted chats for the signed-in user (mute_conversation / get_conversation_mutes,
 * 005_settings_push_backup.sql). Muted chats get no push notifications.
 */

import { create } from 'zustand';
import { supabase } from '../../core/network/supabase';
import { currentSession } from '../../core/session';
import { isMutedUntil, muteLabel, MuteOption, muteUntilFor } from './mute';

interface MuteState {
  /** conversationId -> muted_until (ISO or 'infinity') */
  mutes: Record<string, string>;
  load: () => Promise<void>;
  setMute: (conversationId: string, option: MuteOption) => Promise<void>;
  reset: () => void;
}

export const useMuteStore = create<MuteState>((set, get) => ({
  mutes: {},

  load: async () => {
    const session = currentSession();
    if (!session || session.isDemo) return;
    const { data, error } = await supabase.rpc('get_conversation_mutes');
    if (error) {
      console.warn('[Mute] could not load mutes:', error.message);
      return;
    }
    const mutes: Record<string, string> = {};
    for (const row of (data ?? []) as { conversation_id: string; muted_until: string }[]) {
      mutes[row.conversation_id] = row.muted_until;
    }
    set({ mutes });
  },

  setMute: async (conversationId, option) => {
    const session = currentSession();
    const until = muteUntilFor(option);
    if (session && !session.isDemo) {
      const { data, error } = await supabase.rpc('mute_conversation', {
        p_conversation_id: conversationId,
        p_until: until,
      });
      if (error) throw error;
      const stored = (data as string | null) ?? null;
      const mutes = { ...get().mutes };
      if (stored) mutes[conversationId] = stored;
      else delete mutes[conversationId];
      set({ mutes });
      return;
    }
    const mutes = { ...get().mutes };
    if (until) mutes[conversationId] = until;
    else delete mutes[conversationId];
    set({ mutes });
  },

  reset: () => set({ mutes: {} }),
}));

export function isConversationMuted(conversationId: string): boolean {
  return isMutedUntil(useMuteStore.getState().mutes[conversationId]);
}

/** Mute state of one chat, for chat headers / menus / list rows. */
export function useConversationMute(conversationId: string) {
  const mutedUntil = useMuteStore((s) => s.mutes[conversationId] ?? null);
  const setMute = useMuteStore((s) => s.setMute);
  return {
    mutedUntil,
    isMuted: isMutedUntil(mutedUntil),
    label: muteLabel(mutedUntil),
    mute: (option: Exclude<MuteOption, 'off'>) => setMute(conversationId, option),
    unmute: () => setMute(conversationId, 'off'),
  };
}
