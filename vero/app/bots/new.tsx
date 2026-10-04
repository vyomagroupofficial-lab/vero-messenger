import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { friendlyError } from '../../src/core/network/supabase';
import { botRepository } from '../../src/features/bots/BotRepository';
import { TokenReveal } from '../../src/features/bots/components/TokenReveal';
import { isValidMiniAppUrl, parseCommandLines, validateBotUsername } from '../../src/features/bots/validation';
import { Banner, ScreenHeader, ToggleRow } from '../../src/features/groups/components/GroupComponents';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Button, Icon, TextField } from '../../src/shared/ui';

export default function NewBotScreen() {
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [description, setDescription] = useState('');
  const [commands, setCommands] = useState('start - Say hello\nhelp - What I can do');
  const [miniApp, setMiniApp] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    if (!name.trim()) return setError(t('bots.nameRequired'));
    const u = username.trim().toLowerCase();
    const uErr = validateBotUsername(u);
    if (uErr) return setError(uErr);
    const parsed = parseCommandLines(commands);
    if (parsed.error) return setError(parsed.error);
    if (miniApp.trim() && !isValidMiniAppUrl(miniApp.trim())) return setError(t('bots.badMiniApp'));
    setBusy(true);
    try {
      const res = await botRepository.create({ username: u, name: name.trim(), description: description.trim(), commands: parsed.commands, miniAppUrl: miniApp.trim() || undefined, isPublic });
      setToken(res.token);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <ScreenHeader title={t('bots.newTitle')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/bots'))} />
      <ScrollView contentContainerStyle={[s.body, { paddingBottom: insets.bottom + 40 }]} keyboardShouldPersistTaps="handled">
        <View style={s.hero}>
          <View style={s.avatar}>
            <Icon name="bot" size={34} color={c.accentText} />
          </View>
          <Text style={[type.h2, { textAlign: 'center' }]}>{name.trim() || t('bots.newTitle')}</Text>
          {!!username && <Text style={s.handle}>@{username.trim().toLowerCase()}</Text>}
        </View>
        <View style={{ marginHorizontal: -16 }}>
          <Banner icon="info" text={t('bots.intro')} />
        </View>
        <TextField label={t('channels.name')} icon="bot" value={name} onChangeText={setName} maxLength={64} placeholder="Weather" />
        <TextField label={t('bots.usernameLabel')} icon="at" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} maxLength={30} placeholder="weather_bot" />
        <TextField label={t('channels.description')} icon="edit" value={description} onChangeText={setDescription} multiline maxLength={512} />
        <TextField label={t('bots.commandsLabel')} icon="sliders" value={commands} onChangeText={setCommands} multiline autoCapitalize="none" />
        <TextField label={t('bots.miniAppUrl')} icon="link" value={miniApp} onChangeText={setMiniApp} autoCapitalize="none" keyboardType="url" placeholder="https://example.com/app" />
        <View style={{ marginHorizontal: -16 }}>
          <ToggleRow label={t('bots.listPublic')} sublabel={t('bots.listPublicHint')} value={isPublic} onChange={setIsPublic} />
        </View>
        {error ? (
          <Animated.Text entering={FadeIn} style={[type.caption, { color: c.danger }]}>
            {error}
          </Animated.Text>
        ) : null}
        <Button label={t('bots.createBtn')} icon="bot" loading={busy} onPress={create} />
      </ScrollView>
      <TokenReveal
        token={token}
        botName={name}
        onClose={() => {
          setToken(null);
          router.back();
        }}
      />
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  root: { flex: 1, backgroundColor: c.bg },
  body: { padding: 16, gap: 14, maxWidth: 640, width: '100%', alignSelf: 'center' },
  hero: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  avatar: { width: 80, height: 80, borderRadius: 26, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2, alignItems: 'center', justifyContent: 'center' },
  handle: { fontFamily: f.mono, color: c.muted, fontSize: 13 },
}));
