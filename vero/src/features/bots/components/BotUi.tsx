/**
 * Small bot UI pieces for the chat screen: the "BOT" badge and the `/`
 * command menu above the composer.
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Colors } from '../../../shared/theme/theme';
import { useBotInfo } from '../BotRepository';
import { matchCommands } from '../validation';

/** Inline " BOT" tag; a Text so it can sit inside a title <Text>. */
export function BotBadge({ userId }: { userId?: string | null }) {
  const bot = useBotInfo(userId);
  if (!bot) return null;
  return (
    <Text style={styles.badgeText} accessibilityLabel="Bot account">
      {'  BOT'}
    </Text>
  );
}

export function BotCommandSuggestions({
  botUserId,
  text,
  onPick,
}: {
  botUserId?: string | null;
  text: string;
  onPick: (text: string) => void;
}) {
  const bot = useBotInfo(botUserId);
  if (!bot || !text.startsWith('/')) return null;
  const matches = matchCommands(text, bot.commands);
  if (matches.length === 0) return null;
  return (
    <View style={styles.menu}>
      <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 220 }}>
        {matches.map((c) => (
          <TouchableOpacity key={c.command} style={styles.item} onPress={() => onPick(`/${c.command} `)}>
            <Text style={styles.cmd}>/{c.command}</Text>
            {c.description ? (
              <Text style={styles.desc} numberOfLines={1}>
                {c.description}
              </Text>
            ) : null}
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  badgeText: { color: Colors.accent, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  menu: {
    marginHorizontal: 8,
    marginBottom: 4,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, gap: 10 },
  cmd: { color: Colors.accent, fontWeight: '600', fontSize: 14 },
  desc: { color: Colors.textSecondary, fontSize: 13, flex: 1 },
});
