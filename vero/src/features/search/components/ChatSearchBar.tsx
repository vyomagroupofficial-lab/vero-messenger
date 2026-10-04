import React from 'react';
import { ActivityIndicator, Platform, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { Icon, IconButton } from '../../../shared/ui';

/** Search field for one chat with "n of m" and older/newer navigation. Replaces the chat header. */
export function ChatSearchBar({
  query,
  onChangeQuery,
  index,
  total,
  searching,
  onOlder,
  onNewer,
  onClose,
}: {
  query: string;
  onChangeQuery: (q: string) => void;
  index: number;
  total: number;
  searching: boolean;
  onOlder: () => void;
  onNewer: () => void;
  onClose: () => void;
}) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const label = searching || query.trim().length < 2 ? '' : total === 0 ? t('search.none') : t('search.position', { index: index + 1, total });
  return (
    <Animated.View entering={FadeInDown.duration(220)} style={s.bar}>
      <IconButton icon="back" label={t('search.close')} onPress={onClose} />
      <View style={s.field}>
        <Icon name="search" size={17} color={c.faint} />
        <TextInput
          style={s.input}
          value={query}
          onChangeText={onChangeQuery}
          placeholder={t('search.inChat')}
          placeholderTextColor={c.faint}
          selectionColor={c.accent}
          autoFocus
          returnKeyType="search"
          onSubmitEditing={onOlder}
          accessibilityLabel={t('search.inChat')}
        />
        {searching ? (
          <ActivityIndicator size="small" color={c.accent} />
        ) : label ? (
          <Animated.Text key={label} entering={FadeIn} style={[s.count, total === 0 && { color: c.faint }]}>
            {label}
          </Animated.Text>
        ) : null}
      </View>
      <IconButton icon="chevronUp" label={t('search.older')} disabled={total === 0} onPress={onOlder} />
      <IconButton icon="down" label={t('search.newer')} disabled={total === 0} onPress={onNewer} />
    </Animated.View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  bar: { height: 68, flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 8 },
  field: { flex: 1, minWidth: 0, height: 44, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 14, marginHorizontal: 4, borderRadius: 22, backgroundColor: c.field, borderWidth: 1, borderColor: c.accentLine },
  input: { flex: 1, minWidth: 0, height: '100%', fontFamily: f.body, fontSize: 15, color: c.text, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) } as any,
  count: { fontFamily: f.mono, fontSize: 12, color: c.accentText },
}));
