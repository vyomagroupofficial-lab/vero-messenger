import React, { useState } from 'react';
import { Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useT } from '../../../shared/i18n';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { Button, Icon, Sheet } from '../../../shared/ui';

/** Shows a freshly issued bot token exactly once. */
export function TokenReveal({ token, botName, onClose }: { token: string | null; botName: string; onClose: () => void }) {
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Sheet visible={!!token} onClose={() => undefined} title={t('bots.tokenFor', { name: botName })}>
      <View style={s.warn}>
        <Icon name="key" size={16} color={c.danger} />
        <Text style={[type.caption, { flex: 1 }]}>{t('bots.tokenWarning')}</Text>
      </View>
      <Text style={s.token} selectable>
        {token}
      </Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button
          label={copied ? t('verify.copied') : t('bots.copyToken')}
          icon={copied ? 'check' : 'copy'}
          variant="secondary"
          size="md"
          style={{ flex: 1 }}
          onPress={async () => {
            if (token) await Clipboard.setStringAsync(token);
            setCopied(true);
          }}
        />
        <Button
          label={t('bots.saved')}
          size="md"
          style={{ flex: 1 }}
          onPress={() => {
            setCopied(false);
            onClose();
          }}
        />
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  warn: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', padding: 12, borderRadius: 14, backgroundColor: c.dangerTint },
  token: { fontFamily: f.mono, fontSize: 12.5, lineHeight: 19, color: c.text, backgroundColor: c.field, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: c.line },
}));
