/**
 * Group chat header button: start a voice / video call for the group, or
 * join the one that is already live (shown with a green dot).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { friendlyError } from '../../../core/network/supabase';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { Icon, IconButton, Sheet, SheetRow, notify } from '../../../shared/ui';
import { callService, type CallType } from '../CallService';
import { GROUP_CALL_MAX_PARTICIPANTS } from '../groupCallState';

const POLL_MS = 15_000;

export function GroupCallButton({ conversationId, groupName, memberCount }: { conversationId: string; groupName: string; memberCount: number }) {
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState<{ callId: string; callType: CallType; participantCount: number } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLive(await callService.getLiveGroupCall(conversationId));
    } catch {
      // offline: keep the last state
    }
  }, [conversationId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    // Our own call starting / ending changes what the button should offer.
    let last = '';
    const unsubscribe = callService.subscribe((call) => {
      const key = call ? `${call.id}:${call.status}` : '';
      if (key === last) return;
      last = key;
      void refresh();
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [refresh]);

  const start = async (callType: CallType) => {
    setOpen(false);
    try {
      const id = await callService.startGroupCall({ conversationId, groupName, callType });
      router.push(`/call/${id}`);
    } catch (e) {
      notify(t('groupCall.startFailed'), friendlyError(e));
    }
  };

  const join = async () => {
    setOpen(false);
    if (!live) return;
    try {
      await callService.joinGroupCall({ callId: live.callId, conversationId, groupName, callType: live.callType });
      router.push(`/call/${live.callId}`);
    } catch (e) {
      notify(t('groupCall.joinFailed'), friendlyError(e));
    }
  };

  const tooBig = memberCount > GROUP_CALL_MAX_PARTICIPANTS;

  return (
    <>
      <View>
        <IconButton icon="phone" label={live ? t('groupCall.join') : t('groupCall.start')} color={live ? c.success : undefined} onPress={() => setOpen(true)} />
        {live && (
          <Animated.View entering={ZoomIn.springify()} style={s.dot} pointerEvents="none" />
        )}
      </View>
      <Sheet visible={open} onClose={() => setOpen(false)} title={live ? t('groupCall.joinTitle') : t('groupCall.startTitle', { name: groupName })}>
        {live ? (
          <View style={s.live}>
            <View style={s.liveDot} />
            <Text style={[type.body, { flex: 1 }]}>{t(live.callType === 'video' ? 'groupCall.inVideo' : 'groupCall.inVoice', { count: live.participantCount })}</Text>
          </View>
        ) : (
          <Text style={type.bodyMuted}>{t('groupCall.everyone')}</Text>
        )}
        {tooBig && (
          <View style={s.notice}>
            <Icon name="info" size={15} color={c.accentText} />
            <Text style={[type.caption, { flex: 1, color: c.notice }]}>{t('groupCall.limit', { max: GROUP_CALL_MAX_PARTICIPANTS, members: memberCount })}</Text>
          </View>
        )}
        {live ? (
          <SheetRow icon={live.callType === 'video' ? 'video' : 'phone'} tone="brass" label={t('groupCall.joinNow')} onPress={() => void join()} />
        ) : (
          <>
            <SheetRow icon="phone" tone="brass" label={t('calls.voice')} onPress={() => void start('voice')} />
            <SheetRow icon="video" tone="brass" label={t('calls.video')} onPress={() => void start('video')} />
          </>
        )}
      </Sheet>
    </>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  dot: { position: 'absolute', top: 9, right: 9, width: 10, height: 10, borderRadius: 5, backgroundColor: c.success, borderWidth: 2, borderColor: c.bg },
  live: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, backgroundColor: c.successTint },
  liveDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: c.success },
  notice: { flexDirection: 'row', gap: 8, padding: 12, borderRadius: 14, backgroundColor: c.accentTint },
}));
