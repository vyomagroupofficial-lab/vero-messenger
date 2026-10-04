/**
 * Small bot UI pieces for the chat screen: the "BOT" badge and the `/`
 * command menu above the composer.
 */

import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useT } from '../../../shared/i18n';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { Pressy } from '../../../shared/ui';
import { useBotInfo } from '../BotRepository';
import { matchCommands } from '../validation';

/** Inline " BOT" tag; a Text so it can sit inside a title <Text>. */
export function BotBadge({ userId }: { userId?: string | null }) {
  const s = useStyles();
  const t = useT();
  const bot = useBotInfo(userId);
  if (!bot) return null;
  return (
    <Text style={s.badgeText} accessibilityLabel={t('bots.botAccount')}>
      {'  BOT'}
    </Text>
  );
}

export function BotCommandSuggestions({ botUserId, text, onPick }: { botUserId?: string | null; text: string; onPick: (text: string) => void }) {
  const { c } = useTheme();
  const s = useStyles();
  const bot = useBotInfo(botUserId);
  if (!bot || !text.startsWith('/')) return null;
  const matches = matchCommands(text, bot.commands);
  if (matches.length === 0) return null;
  return (
    <Animated.View entering={FadeInDown.springify().damping(18)} style={s.menu}>
      <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 220 }}>
        {matches.map((cmd) => (
          <Pressy key={cmd.command} style={s.item} onPress={() => onPick(`/${cmd.command} `)} hoverStyle={{ backgroundColor: c.tint }} accessibilityLabel={`/${cmd.command}`}>
            <Text style={s.cmd}>/{cmd.command}</Text>
            {cmd.description ? (
              <Text style={s.desc} numberOfLines={1}>
                {cmd.description}
              </Text>
            ) : null}
          </Pressy>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  badgeText: { fontFamily: f.mono, color: c.accentText, fontSize: 10.5, letterSpacing: 1 },
  menu: { marginHorizontal: 12, marginBottom: 6, backgroundColor: c.raised, borderRadius: 18, borderWidth: 1, borderColor: c.line, overflow: 'hidden' },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 11, gap: 12 },
  cmd: { fontFamily: f.mono, color: c.accentText, fontSize: 14 },
  desc: { fontFamily: f.body, color: c.muted, fontSize: 13, flex: 1 },
}));
