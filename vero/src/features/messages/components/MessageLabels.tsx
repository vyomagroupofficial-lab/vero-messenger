/**
 * Small pieces rendered inside a message bubble: "Forwarded" label, deleted
 * placeholder, "edited" and star markers.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Message } from '../../../shared/models/Message';
import { Colors } from '../../../shared/theme/theme';
import { forwardLabel, isFrequentlyForwarded } from '../forward';

export function ForwardedLabel({ hops }: { hops?: number }) {
  const label = forwardLabel(hops);
  if (!label) return null;
  return (
    <View style={styles.row}>
      <Ionicons
        name={isFrequentlyForwarded(hops) ? 'play-forward' : 'arrow-redo'}
        size={12}
        color={Colors.textSecondary}
      />
      <Text style={styles.forwarded}>{label}</Text>
    </View>
  );
}

export function RevokedBody({ isOwn }: { isOwn: boolean }) {
  return (
    <View style={styles.row}>
      <Ionicons name="ban-outline" size={14} color={Colors.textTertiary} />
      <Text style={styles.revoked}>{isOwn ? 'You deleted this message' : 'This message was deleted'}</Text>
    </View>
  );
}

/** Footer markers before the time: ★ and "edited". */
export function FooterMarkers({ message }: { message: Pick<Message, 'starred' | 'editedAt' | 'revokedAt'> }) {
  if (message.revokedAt) return null;
  return (
    <>
      {message.starred && <Ionicons name="star" size={11} color={Colors.warning} style={styles.star} />}
      {!!message.editedAt && <Text style={styles.edited}>edited</Text>}
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 },
  forwarded: { fontSize: 11, fontStyle: 'italic', color: Colors.textSecondary },
  revoked: { fontSize: 13, fontStyle: 'italic', color: Colors.textTertiary },
  edited: { fontSize: 10, fontStyle: 'italic', color: Colors.textTertiary, marginRight: 4 },
  star: { marginRight: 4 },
});
