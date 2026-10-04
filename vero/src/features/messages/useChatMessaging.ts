/**
 * Chat screen logic for edit, multi-select, forward, star, edit history and
 * in-chat search, so the screen only wires UI.
 */

import { useCallback, useMemo, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { messagingStore } from '../../core/storage/messagingStore';
import { friendlyError } from '../../core/network/supabase';
import type { Message } from '../../shared/models/Message';
import { notify } from '../groups/components/ui';
import { useChatSearch } from '../search/useMessageSearch';
import { canEditMessage, EditHistoryEntry, editHistory } from './edits';
import { isForwardable } from './forward';
import { canDeleteForEveryone } from './deletion';
import { useMessagesStore } from './useMessagesStore';

export function useChatMessaging(conversationId: string, myUserId: string | undefined) {
  const messages = useMessagesStore((s) => s.chats[conversationId]?.messages);
  const focusMessageId = useMessagesStore((s) => s.chats[conversationId]?.focusMessageId ?? null);

  // ── Edit ──────────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState<Message | null>(null);

  /** Returns the text to prefill, or null if the message can't be edited. */
  const startEdit = useCallback(
    (m: Message): string | null => {
      if (!myUserId) return null;
      const check = canEditMessage(m, myUserId);
      if (!check.ok) {
        notify('Can’t edit', check.reason);
        return null;
      }
      setEditing(m);
      return m.content ?? '';
    },
    [myUserId]
  );

  const submitEdit = useCallback(
    async (text: string): Promise<boolean> => {
      const target = editing;
      if (!target) return false;
      setEditing(null);
      try {
        await useMessagesStore.getState().edit(target, text);
        return true;
      } catch (e) {
        notify('Edit not saved', friendlyError(e, 'Could not edit the message.'));
        return false;
      }
    },
    [editing]
  );

  const canEdit = useCallback((m: Message | null) => !!m && !!myUserId && canEditMessage(m, myUserId).ok, [myUserId]);
  const canDeleteEveryone = useCallback(
    (m: Message | null) => !!m && !!myUserId && canDeleteForEveryone(m, myUserId),
    [myUserId]
  );

  // ── Selection ─────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(false);
  const selectedMessages = useMemo(
    () => (messages ?? []).filter((m) => selectedIds.includes(m.id)),
    [messages, selectedIds]
  );
  const startSelect = useCallback((m: Message) => {
    setSelecting(true);
    setSelectedIds([m.id]);
  }, []);
  const toggleSelect = useCallback(
    (m: Message) =>
      setSelectedIds((ids) => {
        const next = ids.includes(m.id) ? ids.filter((x) => x !== m.id) : [...ids, m.id];
        if (next.length === 0) setSelecting(false);
        return next;
      }),
    []
  );
  const clearSelection = useCallback(() => {
    setSelecting(false);
    setSelectedIds([]);
  }, []);
  const copySelection = useCallback(async () => {
    const text = selectedMessages
      .filter((m) => m.messageType === 'text' && m.content)
      .map((m) => m.content)
      .join('\n');
    if (text) await Clipboard.setStringAsync(text);
    clearSelection();
  }, [selectedMessages, clearSelection]);
  const deleteSelectionForMe = useCallback(async () => {
    for (const m of selectedMessages) await useMessagesStore.getState().deleteMessage(m, false);
    clearSelection();
  }, [selectedMessages, clearSelection]);

  // ── Forward ───────────────────────────────────────────────────────────────
  const [forwarding, setForwarding] = useState<Message[] | null>(null);
  const openForward = useCallback((list: Message[]) => {
    const ok = list.filter(isForwardable);
    if (ok.length === 0) {
      notify('Can’t forward', 'These messages can’t be forwarded.');
      return;
    }
    setForwarding(ok);
  }, []);
  const doForward = useCallback(
    async (conversationIds: string[]) => {
      if (!forwarding) return;
      try {
        const result = await useMessagesStore.getState().forward(forwarding, conversationIds);
        setForwarding(null);
        clearSelection();
        if (result.failed > 0) {
          notify('Some messages weren’t forwarded', `${result.failed} could not be sent. Check your connection and try again.`);
        }
      } catch (e) {
        notify('Forward failed', friendlyError(e, 'Could not forward.'));
      }
    },
    [forwarding, clearSelection]
  );

  // ── Star ──────────────────────────────────────────────────────────────────
  const toggleStar = useCallback(
    async (list: Message[]) => {
      if (list.length === 0) return;
      const starred = !list.every((m) => m.starred);
      try {
        await useMessagesStore.getState().star(list, starred);
      } catch (e) {
        notify('Could not update star', friendlyError(e));
      }
      clearSelection();
    },
    [clearSelection]
  );

  // ── Edit history ──────────────────────────────────────────────────────────
  const [history, setHistory] = useState<EditHistoryEntry[] | null>(null);
  const showHistory = useCallback(async (m: Message) => {
    const edits = await messagingStore.getEdits(m.id);
    setHistory(editHistory(m.content ?? '', m.createdAt, edits));
  }, []);

  // ── Search ────────────────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const search = useChatSearch(conversationId, (messageId) => {
    void useMessagesStore.getState().jumpTo(conversationId, messageId);
  });
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    search.setQuery('');
    useMessagesStore.getState().clearFocus(conversationId);
  }, [conversationId, search]);

  return {
    editing,
    startEdit,
    cancelEdit: () => setEditing(null),
    submitEdit,
    canEdit,
    canDeleteEveryone,
    selecting,
    selectedIds,
    selectedMessages,
    startSelect,
    toggleSelect,
    clearSelection,
    copySelection,
    deleteSelectionForMe,
    forwarding,
    openForward,
    closeForward: () => setForwarding(null),
    doForward,
    toggleStar,
    history,
    showHistory,
    closeHistory: () => setHistory(null),
    searchOpen,
    openSearch: () => setSearchOpen(true),
    closeSearch,
    search,
    focusMessageId,
  };
}
