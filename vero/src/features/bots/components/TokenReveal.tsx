import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Colors } from '../../../shared/theme/theme';

/** Shows a freshly issued bot token exactly once. */
export function TokenReveal({ token, botName, onClose }: { token: string | null; botName: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal visible={!!token} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Token for {botName}</Text>
          <Text style={styles.body}>
            Copy it now - it won’t be shown again. Anyone with this token can sign in as your bot. Put it in your bot
            host’s VERO_BOT_TOKEN environment variable (see bots/README.md).
          </Text>
          <Text style={styles.token} selectable>
            {token}
          </Text>
          <View style={styles.row}>
            <TouchableOpacity
              style={styles.secondary}
              onPress={async () => {
                if (token) await Clipboard.setStringAsync(token);
                setCopied(true);
              }}
            >
              <Text style={styles.secondaryText}>{copied ? 'Copied' : 'Copy token'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.primary}
              onPress={() => {
                setCopied(false);
                onClose();
              }}
            >
              <Text style={styles.primaryText}>I’ve saved it</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: Colors.surfaceElevated, borderRadius: 18, padding: 20, maxWidth: 480, width: '100%', alignSelf: 'center' },
  title: { color: Colors.textPrimary, fontSize: 17, fontWeight: '700' },
  body: { color: Colors.textSecondary, fontSize: 13, marginTop: 6, lineHeight: 18 },
  token: {
    color: Colors.textPrimary,
    fontFamily: 'monospace',
    fontSize: 12,
    backgroundColor: Colors.background,
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
  },
  row: { flexDirection: 'row', gap: 10, marginTop: 16, justifyContent: 'flex-end' },
  primary: { backgroundColor: Colors.accent, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16 },
  primaryText: { color: Colors.white, fontWeight: '600' },
  secondary: { borderWidth: 1, borderColor: Colors.border, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16 },
  secondaryText: { color: Colors.textPrimary },
});
