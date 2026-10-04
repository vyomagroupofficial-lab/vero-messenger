/**
 * Mini-app sheet: hosts the bot's https page and answers its bridge calls.
 * The page itself is rendered by MiniAppView (WebView on native, sandboxed
 * iframe on web); both hand every message to `handle` below.
 */

import React, { useCallback, useRef } from 'react';
import { Alert, Modal, Platform, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getSodium } from '../../../core/crypto/sodium';
import { requireSession } from '../../../core/session';
import i18n, { useT } from '../../../shared/i18n';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { Icon, IconButton } from '../../../shared/ui';
import { useMessagesStore } from '../../messages/useMessagesStore';
import type { BotInfo } from '../BotRepository';
import { bridgeResponse, BridgeRequest, BridgeResponse, httpsOrigin, opaqueUserId } from '../miniAppBridge';
import { MiniAppView } from './MiniAppView';

const MAX_SENDS_PER_SESSION = 50;
const MIN_SEND_INTERVAL_MS = 1000;

function askConsent(botName: string): Promise<boolean> {
  const text = i18n.t('bots.consentBody', { name: botName });
  const title = i18n.t('bots.consentTitle');
  if (Platform.OS === 'web') return Promise.resolve(globalThis.confirm?.(`${title}\n\n${text}`) === true);
  return new Promise((resolve) =>
    Alert.alert(title, text, [
      { text: i18n.t('bots.dontAllow'), style: 'cancel', onPress: () => resolve(false) },
      { text: i18n.t('bots.allow'), onPress: () => resolve(true) },
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
  const { c } = useTheme();
  const styles = useStyles();
  const t = useT();
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
          <IconButton icon="close" label={t('bots.closeApp')} onPress={onClose} />
          <View style={styles.titleWrap}>
            <Text style={styles.title} numberOfLines={1}>
              {bot.name}
            </Text>
            <Text style={styles.origin} numberOfLines={1}>
              {httpsOrigin(bot.miniAppUrl)?.replace('https://', '')}
            </Text>
          </View>
          <View style={styles.lock}>
            <Icon name="lock" size={13} color={c.success} />
          </View>
        </View>
        {visible ? <MiniAppView url={bot.miniAppUrl} onRequest={handle} /> : null}
      </SafeAreaView>
    </Modal>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line, gap: 8 },
  titleWrap: { flex: 1 },
  title: { fontFamily: f.semibold, color: c.text, fontSize: 16 },
  origin: { fontFamily: f.mono, color: c.faint, fontSize: 11 },
  lock: { width: 30, height: 30, borderRadius: 10, backgroundColor: c.successTint, alignItems: 'center', justifyContent: 'center', marginRight: 6 },
}));
