import React, { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { friendlyError } from '../../src/core/network/supabase';
import { channelRepository } from '../../src/features/channels/ChannelRepository';
import { CHANNELS_E2EE_NOTICE, isValidHandle, normalizeHandle, suggestHandle } from '../../src/features/channels/channelUtils';
import { channelsStore } from '../../src/features/channels/useChannelsStore';
import { Banner, groupStyles as gs, PrimaryButton, ScreenHeader, SectionHeader, ToggleRow } from '../../src/features/groups/components/GroupComponents';
import { notify } from '../../src/features/groups/components/ui';
import { Colors } from '../../src/shared/theme/theme';

export default function NewChannelScreen() {
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [handleTouched, setHandleTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!handleTouched) setHandle(name.trim() ? suggestHandle(name) : '');
  }, [name, handleTouched]);

  useEffect(() => {
    setAvailable(null);
    if (!isValidHandle(handle)) return;
    let cancelled = false;
    const t = setTimeout(() => {
      channelRepository
        .handleAvailable(handle)
        .then((ok) => !cancelled && setAvailable(ok))
        .catch(() => undefined);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [handle]);

  const create = async () => {
    setSaving(true);
    try {
      const id = await channelRepository.create({
        name: name.trim(),
        handle,
        description: description.trim() || undefined,
        visibility: isPrivate ? 'private' : 'public',
      });
      void channelsStore.getState().loadMine().catch(() => undefined);
      router.replace(`/channels/${id}`);
    } catch (e) {
      notify('Could not create channel', friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleHint = !handle
    ? '3-32 lowercase letters, digits or _'
    : !isValidHandle(handle)
      ? 'Use 3-32 lowercase letters, digits or _'
      : available === false
        ? 'That handle is taken'
        : available
          ? 'Available'
          : 'Checking…';

  return (
    <SafeAreaView style={gs.container} edges={['top']}>
      <ScreenHeader title="New channel" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={gs.scroll} keyboardShouldPersistTaps="handled">
        <Banner icon="information-circle-outline" tone="warning" text={CHANNELS_E2EE_NOTICE + ' Followers can\'t see who runs the channel or who else follows it.'} />
        <SectionHeader title="Name" />
        <TextInput style={gs.input} value={name} onChangeText={setName} maxLength={64} placeholder="Channel name" placeholderTextColor={Colors.textTertiary} />
        <SectionHeader title="Handle" />
        <TextInput
          style={gs.input}
          value={handle}
          onChangeText={(t) => {
            setHandleTouched(true);
            setHandle(normalizeHandle(t));
          }}
          autoCapitalize="none"
          placeholder="handle"
          placeholderTextColor={Colors.textTertiary}
        />
        <Text style={[gs.muted, { paddingHorizontal: 16, color: available === false ? Colors.error : Colors.textTertiary }]}>{handleHint}</Text>
        <SectionHeader title="Description" />
        <TextInput
          style={[gs.input, { minHeight: 80 }]}
          value={description}
          onChangeText={setDescription}
          maxLength={1024}
          multiline
          placeholder="What is this channel about? (optional)"
          placeholderTextColor={Colors.textTertiary}
        />
        <ToggleRow
          label="Private channel"
          sublabel="Hidden from search; people follow it with an invite link"
          value={isPrivate}
          onChange={setIsPrivate}
        />
        <View style={{ height: 12 }} />
        <PrimaryButton label="Create channel" onPress={() => void create()} disabled={saving || !name.trim() || !isValidHandle(handle) || available === false} />
      </ScrollView>
    </SafeAreaView>
  );
}
