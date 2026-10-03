/**
 * Group extras for an open group chat, kept out of the shared messages store:
 *   * renders group events (adds, removals, role/info changes) as local
 *     system messages, live via the private `group:<id>` topic;
 *   * tracks "only admins can send" so the composer can be replaced.
 */

import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../../core/network/supabase';
import { privateChannel } from '../../core/network/realtime';
import { currentSession } from '../../core/session';
import { databaseService } from '../../core/storage/DatabaseService';
import { memberNames, useChatsStore } from '../chats/useChatsStore';
import { messageRepository } from '../messages/MessageRepository';
import { useMessagesStore } from '../messages/useMessagesStore';
import { groupEventToMessage } from './groupEvents';
import { groupRepository } from './GroupRepository';
import { canSendMessages } from './permissions';
import { GroupEvent, GroupRole, GroupSettings } from './types';

const lastSynced = new Map<string, string>();

function namesFor(conversationId: string): Record<string, string> {
  const fromChat = useMessagesStore.getState().chats[conversationId]?.conversation ?? undefined;
  const fromList = useChatsStore.getState().conversations.find((c) => c.id === conversationId);
  return { ...memberNames(fromList), ...memberNames(fromChat) };
}

async function saveEvents(conversationId: string, events: GroupEvent[]): Promise<void> {
  const me = currentSession()?.userId ?? null;
  const names = namesFor(conversationId);
  for (const ev of events) {
    const msg = groupEventToMessage(ev, names, me);
    await databaseService.saveMessage(msg);
    useMessagesStore.getState().upsert(conversationId, msg);
    if (!lastSynced.has(conversationId) || lastSynced.get(conversationId)! < ev.createdAt) {
      lastSynced.set(conversationId, ev.createdAt);
    }
  }
}

/** Pulls events we haven't rendered yet into the local timeline. */
export async function syncGroupEvents(conversationId: string): Promise<number> {
  const session = currentSession();
  if (!session || session.isDemo) return 0;
  const events = await groupRepository.fetchEvents(conversationId, lastSynced.get(conversationId) ?? null);
  if (!events.length) return 0;
  // Catch up on messages first: incremental message sync starts from the newest
  // local row, which must not be a system line newer than unsynced messages.
  await messageRepository.syncLatest(session, conversationId, namesFor(conversationId)).catch(() => 0);
  await saveEvents(conversationId, events);
  return events.length;
}

const SETTINGS_EVENTS = new Set(['settings_changed', 'promoted', 'demoted', 'owner_changed', 'removed', 'left']);

export function useGroupChatSync(conversationId: string, enabled: boolean) {
  const [settings, setSettings] = useState<GroupSettings | null>(null);
  const role = useMessagesStore((s) => {
    const me = currentSession()?.userId;
    return (s.chats[conversationId]?.conversation?.members.find((m) => m.id === me)?.role ?? null) as GroupRole | null;
  });

  useEffect(() => {
    if (!enabled || !conversationId) return;
    let cancelled = false;
    let channel: RealtimeChannel | null = null;

    const loadSettings = () =>
      groupRepository
        .getSettings(conversationId)
        .then((s) => !cancelled && setSettings(s))
        .catch(() => undefined);

    void loadSettings();
    void syncGroupEvents(conversationId).catch((e) => console.warn('[Groups] event sync failed', e?.message));

    channel = privateChannel(`group:${conversationId}`)
      .on('broadcast', { event: 'group.event' }, async ({ payload }) => {
        if (!payload?.id) return;
        const ev = await groupRepository.fetchEvent(payload.id);
        if (!ev || cancelled) return;
        await saveEvents(conversationId, [ev]);
        if (SETTINGS_EVENTS.has(ev.eventType)) void loadSettings();
      })
      .subscribe();

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [conversationId, enabled]);

  const canSend = !enabled || !settings || canSendMessages(role ?? 'member', settings);
  return { settings, role, canSend };
}
