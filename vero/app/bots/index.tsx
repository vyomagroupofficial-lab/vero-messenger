import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { friendlyError } from '../../src/core/network/supabase';
import { BotInfo, botRepository, MyBot } from '../../src/features/bots/BotRepository';
import { TokenReveal } from '../../src/features/bots/components/TokenReveal';
import { isValidMiniAppUrl, parseCommandLines } from '../../src/features/bots/validation';
import { ScreenHeader } from '../../src/features/groups/components/GroupComponents';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Button, EmptyState, Grain, Icon, Pill, Rise, SearchField, Segmented, Sheet, TextField, Toggle, confirmAction, notify } from '../../src/shared/ui';

export default function BotsScreen() {
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const isDemo = useAuthStore((st) => st.isDemo);
  const [tab, setTab] = useState<'directory' | 'mine'>('directory');
  const [query, setQuery] = useState('');
  const [bots, setBots] = useState<BotInfo[] | null>(null);
  const [mine, setMine] = useState<MyBot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<{ token: string; name: string } | null>(null);
  const [editing, setEditing] = useState<MyBot | null>(null);

  useEffect(() => {
    if (isDemo || tab !== 'directory') return;
    const timer = setTimeout(() => {
      setError(null);
      botRepository.listPublic(query).then(setBots).catch((e) => setError(friendlyError(e)));
    }, 300);
    return () => clearTimeout(timer);
  }, [query, tab, isDemo]);

  const loadMine = useCallback(() => {
    if (isDemo) return;
    botRepository.myBots().then(setMine).catch((e) => setError(friendlyError(e)));
  }, [isDemo]);
  useFocusEffect(loadMine);

  const startChat = async (bot: BotInfo) => {
    try {
      const id = await conversationRepository.createDirectConversation(bot.userId);
      router.push(`/chat/${id}`);
    } catch (e) {
      notify(t('contacts.startFailed'), friendlyError(e));
    }
  };

  const rotate = (bot: MyBot) =>
    confirmAction({
      title: t('bots.rotateTitle'),
      message: t('bots.rotateBody'),
      confirmLabel: t('bots.rotate'),
      destructive: true,
      onConfirm: async () => {
        try {
          setToken({ token: await botRepository.rotateToken(bot.userId), name: bot.name });
        } catch (e) {
          notify(t('bots.failed'), friendlyError(e));
        }
      },
    });

  const remove = (bot: MyBot) =>
    confirmAction({
      title: t('bots.deleteTitle', { name: bot.name }),
      message: t('bots.deleteBody'),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: async () => {
        try {
          await botRepository.remove(bot.userId);
          loadMine();
        } catch (e) {
          notify(t('bots.failed'), friendlyError(e));
        }
      },
    });

  const back = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/settings'));

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <Grain />
      <ScreenHeader title={t('settings.bots')} onBack={back} />
      {isDemo ? (
        <EmptyState icon="bot" title={t('settings.bots')} body={t('bots.demo')} />
      ) : (
        <View style={s.inner}>
          <View style={{ alignItems: 'center', paddingTop: 14 }}>
            <Segmented
              label={t('settings.bots')}
              value={tab}
              onChange={setTab}
              options={[
                { value: 'directory', label: t('bots.directory') },
                { value: 'mine', label: t('bots.mine') },
              ]}
            />
          </View>
          {error ? <Text style={[type.caption, { color: c.danger, paddingHorizontal: 20, paddingTop: 8 }]}>{error}</Text> : null}

          {tab === 'directory' ? (
            <FlatList
              data={bots ?? []}
              keyExtractor={(b) => b.userId}
              contentContainerStyle={[s.list, { paddingBottom: insets.bottom + 32 }]}
              ListHeaderComponent={<SearchField value={query} onChangeText={setQuery} placeholder={t('bots.search')} onClear={() => setQuery('')} style={{ marginBottom: 10 }} />}
              ListEmptyComponent={bots === null ? <ActivityIndicator color={c.accent} /> : <EmptyState icon="bot" title={t('bots.noneTitle')} body={t('bots.none')} />}
              ListFooterComponent={
                <View style={s.footnote}>
                  <Icon name="info" size={14} color={c.faint} />
                  <Text style={[type.caption, { flex: 1 }]}>{t('bots.footnote')}</Text>
                </View>
              }
              renderItem={({ item, index }) => (
                <Rise index={Math.min(index, 10)}>
                  <View style={s.item}>
                    <View style={s.avatar}>
                      <Icon name="bot" size={22} color={c.accentText} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Text style={s.name} numberOfLines={1}>
                        {item.name} <Text style={s.badge}> BOT</Text>
                      </Text>
                      {item.username ? <Text style={s.handle}>@{item.username}</Text> : null}
                      {item.description ? (
                        <Text style={type.caption} numberOfLines={2}>
                          {item.description}
                        </Text>
                      ) : null}
                    </View>
                    <Button label={t('bots.chat')} icon="chat" size="sm" onPress={() => startChat(item)} />
                  </View>
                </Rise>
              )}
            />
          ) : (
            <FlatList
              data={mine ?? []}
              keyExtractor={(b) => b.userId}
              contentContainerStyle={[s.list, { paddingBottom: insets.bottom + 32 }]}
              ListHeaderComponent={<Button label={t('bots.create')} icon="plus" onPress={() => router.push('/bots/new')} style={{ marginBottom: 12 }} />}
              ListEmptyComponent={mine === null ? <ActivityIndicator color={c.accent} /> : <EmptyState icon="bot" title={t('bots.mineEmptyTitle')} body={t('bots.mineEmpty')} />}
              renderItem={({ item, index }) => (
                <Rise index={Math.min(index, 10)}>
                  <View style={s.mineItem}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <View style={s.avatar}>
                        <Icon name="bot" size={22} color={c.accentText} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={s.name}>{item.name}</Text>
                        <Text style={s.handle}>@{item.username}</Text>
                      </View>
                      <Text style={type.caption}>{t('bots.public')}</Text>
                      <Toggle
                        label={t('bots.public')}
                        value={item.isPublic}
                        onValueChange={async (v) => {
                          try {
                            await botRepository.update(item.userId, { isPublic: v });
                            loadMine();
                          } catch (e) {
                            notify(t('bots.failed'), friendlyError(e));
                          }
                        }}
                      />
                    </View>
                    <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                      <Pill icon="sliders" label={t('bots.commands', { count: item.commands.length })} tone="stage" />
                      {item.miniAppUrl ? <Pill icon="grid" label={t('bots.miniApp')} tone="brass" /> : null}
                    </View>
                    <View style={s.actions}>
                      <Button label={t('bots.openChat')} icon="chat" size="sm" variant="secondary" onPress={() => startChat(item)} />
                      <Button label={t('bots.edit')} icon="edit" size="sm" variant="secondary" onPress={() => setEditing(item)} />
                      <Button label={t('bots.newToken')} icon="key" size="sm" variant="secondary" onPress={() => rotate(item)} />
                      <Button label={t('common.delete')} icon="trash" size="sm" variant="dangerSoft" onPress={() => remove(item)} />
                    </View>
                  </View>
                </Rise>
              )}
            />
          )}
        </View>
      )}

      <TokenReveal token={token?.token ?? null} botName={token?.name ?? ''} onClose={() => setToken(null)} />
      {editing ? (
        <EditBot
          bot={editing}
          onClose={(changed) => {
            setEditing(null);
            if (changed) loadMine();
          }}
        />
      ) : null}
    </View>
  );
}

function EditBot({ bot, onClose }: { bot: MyBot; onClose: (changed: boolean) => void }) {
  const { c, type } = useTheme();
  const t = useT();
  const [description, setDescription] = useState(bot.description ?? '');
  const [commands, setCommands] = useState(bot.commands.map((cmd) => `${cmd.command} - ${cmd.description}`).join('\n'));
  const [miniApp, setMiniApp] = useState(bot.miniAppUrl ?? '');
  const [webhook, setWebhook] = useState(bot.webhookUrl ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const parsed = parseCommandLines(commands);
    if (parsed.error) return setError(parsed.error);
    if (miniApp && !isValidMiniAppUrl(miniApp.trim())) return setError(t('bots.badMiniApp'));
    if (webhook && !isValidMiniAppUrl(webhook.trim())) return setError(t('bots.badWebhook'));
    try {
      await botRepository.update(bot.userId, { description: description.trim() || null, commands: parsed.commands, miniAppUrl: miniApp.trim() || null, webhookUrl: webhook.trim() || null });
      onClose(true);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  return (
    <Sheet visible onClose={() => onClose(false)} title={t('bots.editTitle', { name: bot.name })}>
      <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
        <TextField label={t('channels.description')} value={description} onChangeText={setDescription} maxLength={512} multiline />
        <TextField label={t('bots.commandsLabel')} value={commands} onChangeText={setCommands} multiline autoCapitalize="none" placeholder={'start - Say hello\nhelp - What I can do'} />
        <TextField label={t('bots.miniAppUrl')} icon="link" value={miniApp} onChangeText={setMiniApp} autoCapitalize="none" keyboardType="url" placeholder="https://example.com/app" />
        <TextField label={t('bots.webhookUrl')} icon="link" value={webhook} onChangeText={setWebhook} autoCapitalize="none" keyboardType="url" placeholder="https://example.com/vero-hook" />
        {error ? <Text style={[type.caption, { color: c.danger }]}>{error}</Text> : null}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label={t('common.cancel')} variant="secondary" size="md" style={{ flex: 1 }} onPress={() => onClose(false)} />
        <Button label={t('common.save')} size="md" style={{ flex: 1 }} onPress={save} />
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  root: { flex: 1, backgroundColor: c.bg },
  inner: { flex: 1, width: '100%', maxWidth: 760, alignSelf: 'center' },
  list: { padding: 16, gap: 10 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 20, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line },
  avatar: { width: 46, height: 46, borderRadius: 15, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2, alignItems: 'center', justifyContent: 'center' },
  name: { fontFamily: f.semibold, color: c.text, fontSize: 15.5 },
  badge: { fontFamily: f.mono, color: c.accentText, fontSize: 10, letterSpacing: 1 },
  handle: { fontFamily: f.mono, color: c.muted, fontSize: 12 },
  footnote: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingTop: 12, paddingHorizontal: 4 },
  mineItem: { backgroundColor: c.panel, borderRadius: 22, padding: 14, gap: 12, borderWidth: 1, borderColor: c.line },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
}));
