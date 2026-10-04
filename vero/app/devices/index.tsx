import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { Note, ScreenHeader, useLinkStyles } from '../../src/features/linking/ui';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Icon, IconName, Pressy, Rise } from '../../src/shared/ui';

export default function DevicesHubScreen() {
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const ui = useLinkStyles();
  const s = useStyles();
  const t = useT();
  const isDemo = useAuthStore((st) => st.isDemo);

  const items: { icon: IconName; key: string; go: () => void }[] = [
    { icon: 'laptop', key: 'link', go: () => router.push({ pathname: '/qr/scan', params: { expect: 'link' } }) },
    { icon: 'arrowOut', key: 'send', go: () => router.push({ pathname: '/qr/scan', params: { expect: 'transfer' } }) },
    { icon: 'arrowIn', key: 'receive', go: () => router.push('/devices/receive-transfer') },
  ];

  return (
    <View style={[ui.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title={t('settings.transfer')} />
      <ScrollView contentContainerStyle={[ui.content, { paddingBottom: insets.bottom + 40 }]}>
        {isDemo ? (
          <Note icon="info">{t('devices.demo')}</Note>
        ) : (
          items.map((item, i) => (
            <Rise key={item.key} index={i}>
              <Pressy onPress={item.go} scaleTo={0.98} hoverStyle={{ borderColor: c.accentLine }} style={s.item} accessibilityLabel={t(`devices.${item.key}Title`)}>
                <View style={s.icon}>
                  <Icon name={item.icon} size={24} color={c.accentText} />
                </View>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={[type.name, { fontSize: 16 }]}>{t(`devices.${item.key}Title`)}</Text>
                  <Text style={type.caption}>{t(`devices.${item.key}Body`)}</Text>
                </View>
                <Icon name="forwardChevron" size={18} color={c.faint} />
              </Pressy>
            </Rise>
          ))
        )}
        <Note icon="key">{t('devices.keysNote')}</Note>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  item: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, backgroundColor: c.panel, borderRadius: 22, borderWidth: 1, borderColor: c.line },
  icon: { width: 50, height: 50, borderRadius: 16, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2, alignItems: 'center', justifyContent: 'center' },
}));
