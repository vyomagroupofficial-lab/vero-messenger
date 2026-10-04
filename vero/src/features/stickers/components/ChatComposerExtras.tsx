/**
 * Composer button + sheet for stickers, GIFs, payments and (in bot chats)
 * the bot's mini-app. The chat screen renders this next to the attach button.
 */

import React, { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native';
import Animated, { FadeIn, SlideInDown } from 'react-native-reanimated';
import { useAuthStore } from '../../auth/useAuthStore';
import { useT } from '../../../shared/i18n';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { IconButton, Segmented, useLayout } from '../../../shared/ui';
import type { Conversation, Message } from '../../../shared/models/Message';
import { useBotInfo } from '../../bots/BotRepository';
import { MiniAppSheet } from '../../bots/components/MiniAppSheet';
import { GifPicker } from '../../gifs/components/GifPicker';
import { gifService } from '../../gifs/GifService';
import { PaymentComposer } from '../../payments/components/PaymentComposer';
import { stickerService } from '../StickerService';
import { StickerPicker } from './StickerPicker';

type Tab = 'stickers' | 'gifs' | 'pay';

export function ChatComposerExtras({ conversation, replyTo, onSent, disabled }: { conversation: Conversation | null; replyTo?: Message | null; onSent?: () => void; disabled?: boolean }) {
  const { c } = useTheme();
  const { isWide } = useLayout();
  const s = useStyles();
  const t = useT();
  const user = useAuthStore((st) => st.user);
  const isDemo = useAuthStore((st) => st.isDemo);
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

  return (
    <>
      {bot?.miniAppUrl ? <IconButton icon="grid" label={t('bots.openApp', { name: bot.name })} variant="filled" size={46} onPress={() => setMiniApp(true)} /> : null}
      <IconButton icon="smile" label={t('stickers.extras')} variant="filled" size={46} disabled={disabled} onPress={() => setOpen(true)} />

      <Modal visible={open} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
        <Pressable style={[s.backdrop, isWide && s.backdropWide]} onPress={close} accessibilityLabel={t('common.close')}>
          <Animated.View entering={FadeIn.duration(160)} style={StyleFill} pointerEvents="none" />
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[s.sheetWrap, isWide && { width: 520 }]}>
            <Animated.View entering={SlideInDown.springify().damping(20).stiffness(180)}>
              <Pressable style={[s.sheet, isWide && s.sheetWide]} onPress={() => undefined}>
                {!isWide && <View style={s.handle} />}
                <View style={s.tabs}>
                  <Segmented
                    label={t('stickers.extras')}
                    value={tab}
                    onChange={setTab}
                    options={[
                      { value: 'stickers', label: t('stickers.stickers') },
                      { value: 'gifs', label: 'GIF' },
                      { value: 'pay', label: t('stickers.pay') },
                    ]}
                  />
                </View>
                <View style={s.body}>
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
            </Animated.View>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      {bot?.miniAppUrl ? <MiniAppSheet bot={bot} conversationId={conversation.id} visible={miniApp} onClose={() => setMiniApp(false)} /> : null}
    </>
  );
}

const StyleFill = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };

const useStyles = makeStyles((c, t, f) => ({
  backdrop: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
  backdropWide: { justifyContent: 'center', alignItems: 'center' },
  sheetWrap: { width: '100%' },
  sheet: { height: 480, maxHeight: '85%', backgroundColor: c.panel, borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden', width: '100%', maxWidth: 640, alignSelf: 'center', borderWidth: 1, borderColor: c.line },
  sheetWide: { borderRadius: 28, height: 520 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: c.line3, alignSelf: 'center', marginTop: 10 },
  tabs: { alignItems: 'center', paddingTop: 12, paddingBottom: 4 },
  body: { flex: 1 },
}));
