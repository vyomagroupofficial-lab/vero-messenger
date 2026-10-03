import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { friendlyError } from '../../src/core/network/supabase';
import { BotInfo, botRepository, MyBot } from '../../src/features/bots/BotRepository';
import { TokenReveal } from '../../src/features/bots/components/TokenReveal';
import { isValidMiniAppUrl, parseCommandLines } from '../../src/features/bots/validation';
import { Colors } from '../../src/shared/theme/theme';

const confirmAction = (title: string, body: string, action: () => void) => {
  if (Platform.OS === 'web') {
    if (globalThis.confirm?.(`${title}\n\n${body}`)) action();
  } else Alert.alert(title, body, [{ text: 'Cancel', style: 'cancel' }, { text: 'Continue', style: 'destructive', onPress: action }]);
};

export default function BotsScreen() {
  const isDemo = useAuthStore((s) => s.isDemo);
  const [tab, setTab] = useState<'directory' | 'mine'>('directory');
  const [query, setQuery] = useState('');
  const [bots, setBots] = useState<BotInfo[] | null>(null);
  const [mine, setMine] = useState<MyBot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<{ token: string; name: string } | null>(null);
  const [editing, setEditing] = useState<MyBot | null>(null);

  useEffect(() => {
    if (isDemo || tab !== 'directory') return;
    const t = setTimeout(() => {
      setError(null);
      botRepository.listPublic(query).then(setBots).catch((e) => setError(friendlyError(e)));
    }, 300);
    return () => clearTimeout(t);
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
      Alert.alert('Could not start chat', friendlyError(e));
    }
  };

  const rotate = (bot: MyBot) =>
    confirmAction('Issue a new token?', 'The old token stops working and the bot’s current devices are signed out.', async () => {
      try {
        setToken({ token: await botRepository.rotateToken(bot.userId), name: bot.name });
      } catch (e) {
        Alert.alert('Failed', friendlyError(e));
      }
    });

  const remove = (bot: MyBot) =>
    confirmAction(`Delete ${bot.name}?`, 'The bot account is deleted permanently and stops answering.', async () => {
      try {
        await botRepository.remove(bot.userId);
        loadMine();
      } catch (e) {
        Alert.alert('Failed', friendlyError(e));
      }
    });

  if (isDemo) {
    return (
      <SafeAreaView style={styles.container}>
        <Header />
        <Text style={styles.empty}>Bots need a real account.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Header />
      <View style={styles.segment}>
        {(['directory', 'mine'] as const).map((t) => (
          <TouchableOpacity key={t} style={[styles.segBtn, tab === t && styles.segActive]} onPress={() => setTab(t)}>
            <Text style={[styles.segText, tab === t && styles.segTextActive]}>{t === 'directory' ? 'Directory' : 'My bots'}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {tab === 'directory' ? (
        <>
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Search bots"
            placeholderTextColor={Colors.textTertiary}
          />
          <FlatList
            data={bots ?? []}
            keyExtractor={(b) => b.userId}
            contentContainerStyle={styles.list}
            ListEmptyComponent={bots === null ? <ActivityIndicator color={Colors.accent} /> : <Text style={styles.empty}>No public bots found.</Text>}
            renderItem={({ item }) => (
              <View style={styles.item}>
                <View style={styles.avatar}>
                  <Ionicons name="hardware-chip" size={20} color={Colors.white} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>
                    {item.name} <Text style={styles.badge}>BOT</Text>
                  </Text>
                  {item.username ? <Text style={styles.meta}>@{item.username}</Text> : null}
                  {item.description ? (
                    <Text style={styles.desc} numberOfLines={2}>
                      {item.description}
                    </Text>
                  ) : null}
                </View>
                <TouchableOpacity style={styles.chatBtn} onPress={() => startChat(item)}>
                  <Text style={styles.chatBtnText}>Chat</Text>
                </TouchableOpacity>
              </View>
            )}
          />
          <Text style={styles.footnote}>
            Bots are run by their owners. Chats with bots are end-to-end encrypted to the bot’s own device, so the bot’s
            owner can read what you send it.
          </Text>
        </>
      ) : (
        <FlatList
          data={mine ?? []}
          keyExtractor={(b) => b.userId}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <TouchableOpacity style={styles.create} onPress={() => router.push('/bots/new')}>
              <Ionicons name="add-circle" size={20} color={Colors.white} />
              <Text style={styles.createText}>Create a bot</Text>
            </TouchableOpacity>
          }
          ListEmptyComponent={mine === null ? <ActivityIndicator color={Colors.accent} /> : <Text style={styles.empty}>You don’t have any bots yet.</Text>}
          renderItem={({ item }) => (
            <View style={styles.mineItem}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.meta}>
                    @{item.username} · {item.commands.length} commands{item.miniAppUrl ? ' · mini-app' : ''}
                  </Text>
                </View>
                <Text style={styles.meta}>Public</Text>
                <Switch
                  value={item.isPublic}
                  onValueChange={async (v) => {
                    try {
                      await botRepository.update(item.userId, { isPublic: v });
                      loadMine();
                    } catch (e) {
                      Alert.alert('Failed', friendlyError(e));
                    }
                  }}
                />
              </View>
              <View style={styles.actions}>
                <TouchableOpacity style={styles.action} onPress={() => startChat(item)}>
                  <Text style={styles.actionText}>Open chat</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.action} onPress={() => setEditing(item)}>
                  <Text style={styles.actionText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.action} onPress={() => rotate(item)}>
                  <Text style={styles.actionText}>New token</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.action} onPress={() => remove(item)}>
                  <Text style={[styles.actionText, { color: Colors.error }]}>Delete</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        />
      )}

      <TokenReveal token={token?.token ?? null} botName={token?.name ?? ''} onClose={() => setToken(null)} />
      {editing ? <EditBot bot={editing} onClose={(changed) => { setEditing(null); if (changed) loadMine(); }} /> : null}
    </SafeAreaView>
  );
}

function Header() {
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }}>
        <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
      </TouchableOpacity>
      <Text style={styles.title}>Bots</Text>
    </View>
  );
}

function EditBot({ bot, onClose }: { bot: MyBot; onClose: (changed: boolean) => void }) {
  const [description, setDescription] = useState(bot.description ?? '');
  const [commands, setCommands] = useState(bot.commands.map((c) => `${c.command} - ${c.description}`).join('\n'));
  const [miniApp, setMiniApp] = useState(bot.miniAppUrl ?? '');
  const [webhook, setWebhook] = useState(bot.webhookUrl ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const parsed = parseCommandLines(commands);
    if (parsed.error) return setError(parsed.error);
    if (miniApp && !isValidMiniAppUrl(miniApp.trim())) return setError('Mini-app URL must be https://… with a real domain.');
    if (webhook && !isValidMiniAppUrl(webhook.trim())) return setError('Webhook URL must be https://… with a real domain.');
    try {
      await botRepository.update(bot.userId, {
        description: description.trim() || null,
        commands: parsed.commands,
        miniAppUrl: miniApp.trim() || null,
        webhookUrl: webhook.trim() || null,
      });
      onClose(true);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={() => onClose(false)}>
      <Pressable style={styles.backdrop} onPress={() => onClose(false)}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <Text style={styles.title}>Edit {bot.name}</Text>
          <Text style={styles.label}>Description</Text>
          <TextInput style={styles.input} value={description} onChangeText={setDescription} maxLength={512} multiline placeholderTextColor={Colors.textTertiary} />
          <Text style={styles.label}>Commands (one per line: command - description)</Text>
          <TextInput style={[styles.input, { minHeight: 90 }]} value={commands} onChangeText={setCommands} multiline autoCapitalize="none" placeholder={'start - Say hello\nhelp - What I can do'} placeholderTextColor={Colors.textTertiary} />
          <Text style={styles.label}>Mini-app URL (optional, https)</Text>
          <TextInput style={styles.input} value={miniApp} onChangeText={setMiniApp} autoCapitalize="none" keyboardType="url" placeholder="https://example.com/app" placeholderTextColor={Colors.textTertiary} />
          <Text style={styles.label}>Webhook URL (optional wake-up ping, https)</Text>
          <TextInput style={styles.input} value={webhook} onChangeText={setWebhook} autoCapitalize="none" keyboardType="url" placeholder="https://example.com/vero-hook" placeholderTextColor={Colors.textTertiary} />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <TouchableOpacity style={styles.action} onPress={() => onClose(false)}>
              <Text style={styles.actionText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.action, { backgroundColor: Colors.accent, borderColor: Colors.accent }]} onPress={save}>
              <Text style={[styles.actionText, { color: Colors.white }]}>Save</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8, gap: 4 },
  title: { color: Colors.textPrimary, fontSize: 20, fontWeight: '700' },
  segment: { flexDirection: 'row', backgroundColor: Colors.surface, borderRadius: 12, padding: 4, marginHorizontal: 16 },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
  segActive: { backgroundColor: Colors.accent },
  segText: { color: Colors.textSecondary, fontWeight: '500' },
  segTextActive: { color: Colors.white, fontWeight: '600' },
  search: {
    margin: 16,
    marginBottom: 0,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    color: Colors.textPrimary,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  list: { padding: 16 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.border },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.purple, alignItems: 'center', justifyContent: 'center' },
  name: { color: Colors.textPrimary, fontSize: 15, fontWeight: '600' },
  badge: { color: Colors.accent, fontSize: 10, fontWeight: '800' },
  meta: { color: Colors.textTertiary, fontSize: 12, marginTop: 1 },
  desc: { color: Colors.textSecondary, fontSize: 13, marginTop: 3 },
  chatBtn: { backgroundColor: Colors.accent, borderRadius: 10, paddingVertical: 7, paddingHorizontal: 14 },
  chatBtnText: { color: Colors.white, fontWeight: '600' },
  footnote: { color: Colors.textTertiary, fontSize: 11, padding: 16, lineHeight: 16 },
  empty: { color: Colors.textTertiary, textAlign: 'center', padding: 24 },
  error: { color: Colors.error, marginHorizontal: 16, marginTop: 8 },
  create: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.accent,
    borderRadius: 12,
    padding: 12,
    justifyContent: 'center',
    marginBottom: 12,
  },
  createText: { color: Colors.white, fontWeight: '600' },
  mineItem: { backgroundColor: Colors.surfaceElevated, borderRadius: 14, padding: 14, marginBottom: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  action: { borderWidth: 1, borderColor: Colors.border, borderRadius: 10, paddingVertical: 7, paddingHorizontal: 12 },
  actionText: { color: Colors.textPrimary, fontSize: 13 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.surfaceElevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  label: { color: Colors.textSecondary, fontSize: 12, marginTop: 12, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    color: Colors.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
});
