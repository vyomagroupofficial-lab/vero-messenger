/**
 * Group chat header button: start a voice / video call for the group, or
 * join the one that is already live (shown with a green dot).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, TouchableOpacity, View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../../shared/theme/theme';
import { friendlyError } from '../../../core/network/supabase';
import { callService, groupSizeNotice, type CallType } from '../CallService';

const POLL_MS = 15_000;

export function GroupCallButton({
  conversationId,
  groupName,
  memberCount,
  style,
  iconColor = Colors.textPrimary,
}: {
  conversationId: string;
  groupName: string;
  memberCount: number;
  style?: StyleProp<ViewStyle>;
  iconColor?: string;
}) {
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
    try {
      const id = await callService.startGroupCall({ conversationId, groupName, callType });
      router.push(`/call/${id}`);
    } catch (e) {
      Alert.alert("Couldn't start the call", friendlyError(e));
    }
  };

  const join = async () => {
    if (!live) return;
    try {
      await callService.joinGroupCall({ callId: live.callId, conversationId, groupName, callType: live.callType });
      router.push(`/call/${live.callId}`);
    } catch (e) {
      Alert.alert("Couldn't join the call", friendlyError(e));
    }
  };

  const onPress = () => {
    const notice = groupSizeNotice(memberCount);
    if (live) {
      const who = live.participantCount === 1 ? '1 person is' : `${live.participantCount} people are`;
      Alert.alert('Join group call?', [`${who} in the ${live.callType} call.`, notice].filter(Boolean).join('\n\n'), [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Join', onPress: () => void join() },
      ]);
      return;
    }
    Alert.alert(`Call ${groupName}`, notice ?? 'Everyone in the group will be invited. Calls are end-to-end encrypted.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Voice call', onPress: () => void start('voice') },
      { text: 'Video call', onPress: () => void start('video') },
    ]);
  };

  return (
    <TouchableOpacity
      style={style}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={live ? 'Join group call' : 'Start group call'}
    >
      <View>
        <Ionicons name={live ? 'call' : 'call-outline'} size={22} color={live ? Colors.emerald : iconColor} />
        {live && <View style={styles.dot} />}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  dot: {
    position: 'absolute',
    top: -2,
    right: -4,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: Colors.emerald,
    borderWidth: 1.5,
    borderColor: Colors.background,
  },
});
