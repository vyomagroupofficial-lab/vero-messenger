/**
 * Mini-app sheet: hosts the bot's https page and answers its bridge calls.
 * The page itself is rendered by MiniAppView (WebView on native, sandboxed
 * iframe on web); both hand every message to `handle` below.
 */

import React, { useCallback, useRef } from 'react';
import { Alert, Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getSodium } from '../../../core/crypto/sodium';
import { requireSession } from '../../../core/session';
import { Colors } from '../../../shared/theme/theme';
import { useMessagesStore } from '../../messages/useMessagesStore';
import type { BotInfo } from '../BotRepository';
import { bridgeResponse, BridgeRequest, BridgeResponse, httpsOrigin, opaqueUserId } from '../miniAppBridge';
import { MiniAppView } from './MiniAppView';

const MAX_SENDS_PER_SESSION = 50;
const MIN_SEND_INTERVAL_MS = 1000;

function askConsent(botName: string): Promise<boolean> {
  const text = `${botName} wants to know your display name. It gets a pseudonymous id that only works for this bot - never your Vero account id.`;
  if (Platform.OS === 'web') return Promise.resolve(globalThis.confirm?.(`Share your name?\n\n${text}`) === true);
  return new Promise((resolve) =>
    Alert.alert('Share your name?', text, [
      { text: 'Don’t allow', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Allow', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) })
  );
}

export function MiniAppSheet({
  bot,
  conversationId,
  visible,
  onClose,
}: {
  bot: BotInfo;
  conversationId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const consent = useRef<boolean | null>(null);
  const sends = useRef({ count: 0, last: 0 });

  const handle = useCallback(
    async (req: BridgeRequest): Promise<BridgeResponse> => {
      switch (req.method) {
        case 'close':
          onClose();
          return bridgeResponse(req.id, { ok: true, result: null });
        case 'getUser': {
          if (consent.current === null) consent.current = await askConsent(bot.name);
          if (!consent.current) return bridgeResponse(req.id, { ok: false, error: 'The user declined' });
          const session = requireSession();
          const sodium = await getSodium();
          return bridgeResponse(req.id, {
            ok: true,
            result: { displayName: session.displayName, id: opaqueUserId(sodium, session.userId, bot.userId) },
          });
        }
        case 'sendData': {
          const now = Date.now();
          if (sends.current.count >= MAX_SENDS_PER_SESSION || now - sends.current.last < MIN_SEND_INTERVAL_MS) {
            return bridgeResponse(req.id, { ok: false, error: 'Too many messages, slow down' });
          }
          sends.current = { count: sends.current.count + 1, last: now };
          const sent = await useMessagesStore.getState().send(conversationId, { t: 'bot_data', data: req.data });
          return sent && sent.status !== 'failed'
            ? bridgeResponse(req.id, { ok: true, result: true })
            : bridgeResponse(req.id, { ok: false, error: 'Message not sent' });
        }
      }
    },
    [bot.name, bot.userId, conversationId, onClose]
  );

  if (!bot.miniAppUrl) return null;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} accessibilityLabel="Close mini-app" style={styles.close}>
            <Ionicons name="close" size={22} color={Colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.titleWrap}>
            <Text style={styles.title} numberOfLines={1}>
              {bot.name}
            </Text>
            <Text style={styles.origin} numberOfLines={1}>
              {httpsOrigin(bot.miniAppUrl)?.replace('https://', '')}
            </Text>
          </View>
          <Ionicons name="lock-closed" size={14} color={Colors.textTertiary} />
        </View>
        {visible ? <MiniAppView url={bot.miniAppUrl} onRequest={handle} /> : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 8,
  },
  close: { padding: 4 },
  titleWrap: { flex: 1 },
  title: { color: Colors.textPrimary, fontSize: 16, fontWeight: '600' },
  origin: { color: Colors.textTertiary, fontSize: 11 },
});
