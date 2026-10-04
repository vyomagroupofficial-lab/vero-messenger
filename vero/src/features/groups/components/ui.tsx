/**
 * Cross-platform dialogs for the group/channel/community screens.
 * (react-native-web's Alert.alert ignores buttons, so web uses window.confirm.)
 */

import React from 'react';
import { Alert, Platform, Share, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import i18n from '../../../shared/i18n';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { Glyph, GlyphName, Pressy, Sheet } from '../../../shared/ui';

export function notify(title: string, message?: string): void {
  if (Platform.OS === 'web') {
    (globalThis as any).alert?.(message ? `${title}\n\n${message}` : title);
  } else {
    Alert.alert(title, message);
  }
}

export function confirmAction(title: string, message: string, confirmLabel: string, destructive = false): Promise<boolean> {
  if (Platform.OS === 'web') {
    return Promise.resolve(!!(globalThis as any).confirm?.(`${title}\n\n${message}`));
  }
  return new Promise((resolve) =>
    Alert.alert(
      title,
      message,
      [
        { text: i18n.t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    )
  );
}

/** OS share sheet; falls back to the clipboard where sharing isn't available. */
export async function shareLink(url: string, title: string): Promise<void> {
  try {
    if (Platform.OS === 'web' && !(globalThis as any).navigator?.share) throw new Error('no share');
    await Share.share(Platform.OS === 'ios' ? { url, message: title } : { message: `${title}\n${url}`, title });
  } catch {
    await Clipboard.setStringAsync(url);
    notify(i18n.t('groups.linkCopied'), url);
  }
}

export async function copyLink(url: string): Promise<void> {
  await Clipboard.setStringAsync(url);
  notify(i18n.t('groups.linkCopied'), url);
}

export interface SheetOption {
  label: string;
  icon?: GlyphName;
  destructive?: boolean;
  onPress: () => void;
}

export function ActionSheet({ visible, title, options, onClose }: { visible: boolean; title?: string; options: SheetOption[]; onClose: () => void }) {
  const { c } = useTheme();
  const s = useStyles();
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <View style={{ gap: 2 }}>
        {options.map((o, i) => (
          <Animated.View key={o.label} entering={FadeInDown.delay(i * 35).duration(260)}>
            <Pressy
              onPress={() => {
                onClose();
                o.onPress();
              }}
              scaleTo={0.98}
              hoverStyle={{ backgroundColor: c.tint }}
              style={s.option}
              accessibilityLabel={o.label}
            >
              <View style={[s.icon, o.destructive && { backgroundColor: c.dangerTint }]}>
                {o.icon ? <Glyph name={o.icon} size={19} color={o.destructive ? c.danger : c.accentText} /> : null}
              </View>
              <Text style={[s.label, o.destructive && { color: c.danger }]}>{o.label}</Text>
            </Pressy>
          </Animated.View>
        ))}
        <Pressy onPress={onClose} scaleTo={0.98} hoverStyle={{ backgroundColor: c.tint }} style={s.option} accessibilityLabel={i18n.t('common.cancel')}>
          <View style={s.icon}>
            <Glyph name="close" size={19} color={c.muted} />
          </View>
          <Text style={[s.label, { color: c.muted }]}>{i18n.t('common.cancel')}</Text>
        </Pressy>
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 14 },
  icon: { width: 38, height: 38, borderRadius: 12, backgroundColor: c.raised, alignItems: 'center', justifyContent: 'center' },
  label: { fontFamily: f.medium, fontSize: 15.5, color: c.text, flex: 1 },
}));
