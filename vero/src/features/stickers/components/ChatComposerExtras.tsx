/**
 * Composer button + sheet for stickers, GIFs, payments and (in bot chats)
 * the bot's mini-app. The chat screen renders this next to the attach button.
 */

import React, { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../auth/useAuthStore';
import { Colors } from '../../../shared/theme/theme';
import type { Conversation, Message } from '../../../shared/models/Message';
import { useBotInfo } from '../../bots/BotRepository';
import { MiniAppSheet } from '../../bots/components/MiniAppSheet';
import { GifPicker } from '../../gifs/components/GifPicker';
import { gifService } from '../../gifs/GifService';
import { PaymentComposer } from '../../payments/components/PaymentComposer';
import { stickerService } from '../StickerService';
import { StickerPicker } from './StickerPicker';

type Tab = 'stickers' | 'gifs' | 'pay';

export function ChatComposerExtras({
  conversation,
  replyTo,
  onSent,
  disabled,
}: {
  conversation: Conversation | null;
  replyTo?: Message | null;
  onSent?: () => void;
  disabled?: boolean;
}) {
  const user = useAuthStore((s) => s.user);
  const isDemo = useAuthStore((s) => s.isDemo);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('stickers');
  const [miniApp, setMiniApp] = useState(false);
  const bot = useBotInfo(conversation?.conversationType === 'direct' ? conversation.otherUser?.id : null);

  if (!conversation || !user) return null;
  const close = () => setOpen(false);
  const sent = () => {
    close();
    onSent?.();
  };

  const tabs: { id: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { id: 'stickers', label: 'Stickers', icon: 'happy-outline' },
    { id: 'gifs', label: 'GIFs', icon: 'film-outline' },
    { id: 'pay', label: '₹ Pay', icon: 'wallet-outline' },
  ];

  return (
    <>
      {bot?.miniAppUrl ? (
        <TouchableOpacity style={styles.btn} onPress={() => setMiniApp(true)} accessibilityLabel={`Open ${bot.name} app`}>
          <Ionicons name="apps-outline" size={23} color={Colors.accent} />
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity
        style={styles.btn}
        onPress={() => setOpen(true)}
        disabled={disabled}
        accessibilityLabel="Stickers, GIFs and payments"
      >
        <Ionicons name="happy-outline" size={24} color={Colors.accent} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
        <Pressable style={styles.backdrop} onPress={close}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetWrap}>
            <Pressable style={styles.sheet} onPress={() => undefined}>
              <View style={styles.handle} />
              <View style={styles.tabs}>
                {tabs.map((t) => (
                  <TouchableOpacity key={t.id} onPress={() => setTab(t.id)} style={[styles.tab, tab === t.id && styles.tabActive]}>
                    <Ionicons name={t.icon} size={16} color={tab === t.id ? Colors.white : Colors.textSecondary} />
                    <Text style={[styles.tabText, tab === t.id && styles.tabTextActive]}>{t.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.body}>
                {tab === 'stickers' ? (
                  <StickerPicker
                    userId={user.id}
                    onSend={async (item) => {
                      await stickerService.send(conversation.id, item, replyTo);
                      sent();
                    }}
                  />
                ) : tab === 'gifs' ? (
                  <GifPicker
                    isDemo={isDemo}
                    onSend={async (gif) => {
                      await gifService.send(conversation.id, gif, replyTo);
                      sent();
                    }}
                  />
                ) : (
                  <PaymentComposer conversation={conversation} isDemo={isDemo} onDone={sent} />
                )}
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      {bot?.miniAppUrl ? (
        <MiniAppSheet bot={bot} conversationId={conversation.id} visible={miniApp} onClose={() => setMiniApp(false)} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  btn: { paddingHorizontal: 4, paddingVertical: 6, justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheetWrap: { width: '100%' },
  sheet: {
    height: 460,
    maxHeight: '85%',
    backgroundColor: Colors.surfaceElevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border, alignSelf: 'center', marginTop: 8 },
  tabs: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingTop: 10 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16 },
  tabActive: { backgroundColor: Colors.accent },
  tabText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '500' },
  tabTextActive: { color: Colors.white, fontWeight: '600' },
  body: { flex: 1 },
});
