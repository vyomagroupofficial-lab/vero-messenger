import React, { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { friendlyError } from '../../src/core/network/supabase';
import { botRepository } from '../../src/features/bots/BotRepository';
import { TokenReveal } from '../../src/features/bots/components/TokenReveal';
import { isValidMiniAppUrl, parseCommandLines, validateBotUsername } from '../../src/features/bots/validation';
import { Colors } from '../../src/shared/theme/theme';

export default function NewBotScreen() {
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
    if (!name.trim()) return setError('Give your bot a name.');
    const u = username.trim().toLowerCase();
    const uErr = validateBotUsername(u);
    if (uErr) return setError(uErr);
    const parsed = parseCommandLines(commands);
    if (parsed.error) return setError(parsed.error);
    if (miniApp.trim() && !isValidMiniAppUrl(miniApp.trim())) return setError('Mini-app URL must be https://… with a real domain.');
    setBusy(true);
    try {
      const res = await botRepository.create({
        username: u,
        name: name.trim(),
        description: description.trim(),
        commands: parsed.commands,
        miniAppUrl: miniApp.trim() || undefined,
        isPublic,
      });
      setToken(res.token);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }}>
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>New bot</Text>
      </View>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.intro}>
          A bot is its own Vero account. You get a token once; run the bot with the Vero bot SDK (bots/README.md) on
          your own server. Messages to your bot are end-to-end encrypted to the bot’s device.
        </Text>
        <Text style={styles.label}>Name</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={64} placeholder="Weather" placeholderTextColor={Colors.textTertiary} />
        <Text style={styles.label}>Username (must end in “bot”)</Text>
        <TextInput
          style={styles.input}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={30}
          placeholder="weather_bot"
          placeholderTextColor={Colors.textTertiary}
        />
        <Text style={styles.label}>Description</Text>
        <TextInput style={[styles.input, { minHeight: 60 }]} value={description} onChangeText={setDescription} multiline maxLength={512} placeholderTextColor={Colors.textTertiary} />
        <Text style={styles.label}>Commands (one per line: command - description)</Text>
        <TextInput style={[styles.input, { minHeight: 90 }]} value={commands} onChangeText={setCommands} multiline autoCapitalize="none" placeholderTextColor={Colors.textTertiary} />
        <Text style={styles.label}>Mini-app URL (optional, https only)</Text>
        <TextInput
          style={styles.input}
          value={miniApp}
          onChangeText={setMiniApp}
          autoCapitalize="none"
          keyboardType="url"
          placeholder="https://example.com/app"
          placeholderTextColor={Colors.textTertiary}
        />
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchLabel}>List in the bot directory</Text>
            <Text style={styles.hint}>Anyone can find and chat with public bots.</Text>
          </View>
          <Switch value={isPublic} onValueChange={setIsPublic} />
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity style={[styles.submit, busy && { opacity: 0.6 }]} onPress={create} disabled={busy}>
          {busy ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.submitText}>Create bot</Text>}
        </TouchableOpacity>
      </ScrollView>
      <TokenReveal
        token={token}
        botName={name}
        onClose={() => {
          setToken(null);
          router.back();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8, gap: 4 },
  title: { color: Colors.textPrimary, fontSize: 20, fontWeight: '700' },
  body: { padding: 16, paddingBottom: 40, maxWidth: 640, width: '100%', alignSelf: 'center' },
  intro: { color: Colors.textSecondary, fontSize: 13, lineHeight: 18 },
  label: { color: Colors.textSecondary, fontSize: 12, marginTop: 14, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    color: Colors.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16 },
  switchLabel: { color: Colors.textPrimary, fontSize: 14 },
  hint: { color: Colors.textTertiary, fontSize: 12 },
  error: { color: Colors.error, marginTop: 12 },
  submit: { backgroundColor: Colors.accent, borderRadius: 12, alignItems: 'center', paddingVertical: 13, marginTop: 20 },
  submitText: { color: Colors.white, fontWeight: '600', fontSize: 15 },
});
