import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { friendlyError } from '../../src/core/network/supabase';
import { channelRepository } from '../../src/features/channels/ChannelRepository';
import { isValidHandle, normalizeHandle, suggestHandle } from '../../src/features/channels/channelUtils';
import { channelsStore } from '../../src/features/channels/useChannelsStore';
import { Banner, EntityAvatar, ScreenHeader, ToggleRow, useGroupStyles } from '../../src/features/groups/components/GroupComponents';
import { notify } from '../../src/features/groups/components/ui';
import { useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Button, TextField } from '../../src/shared/ui';

export default function NewChannelScreen() {
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const gs = useGroupStyles();
  const t = useT();
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
    const timer = setTimeout(() => {
      channelRepository
        .handleAvailable(handle)
        .then((ok) => !cancelled && setAvailable(ok))
        .catch(() => undefined);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [handle]);

  const create = async () => {
    setSaving(true);
    try {
      const id = await channelRepository.create({ name: name.trim(), handle, description: description.trim() || undefined, visibility: isPrivate ? 'private' : 'public' });
      void channelsStore.getState().loadMine().catch(() => undefined);
      router.replace(`/channels/${id}`);
    } catch (e) {
      notify(t('channels.createFailed'), friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  const valid = isValidHandle(handle);
  const handleHint = !handle ? t('channels.handleRule') : !valid ? t('channels.handleInvalid') : available === false ? t('channels.handleTaken') : available ? t('channels.handleOk') : t('channels.handleChecking');
  const hintColor = available === false || (handle && !valid) ? c.danger : available ? c.success : c.muted;

  return (
    <View style={[gs.container, { paddingTop: insets.top }]}>
      <ScreenHeader title={t('channels.new')} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={[gs.scroll, { paddingHorizontal: 16, gap: 14, paddingTop: 16 }]} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: 'center', paddingVertical: 8 }}>
          <EntityAvatar name={name} size={84} icon="megaphone" />
        </View>
        <View style={{ marginHorizontal: -16 }}>
          <Banner icon="info" tone="warning" text={`${t('channels.notice')} ${t('channels.anonNote')}`} />
        </View>
        <TextField label={t('channels.name')} icon="megaphone" value={name} onChangeText={setName} maxLength={64} placeholder={t('channels.namePlaceholder')} />
        <View style={{ gap: 6 }}>
          <TextField
            label={t('channels.handle')}
            icon="at"
            value={handle}
            onChangeText={(v) => {
              setHandleTouched(true);
              setHandle(normalizeHandle(v));
            }}
            autoCapitalize="none"
            placeholder="handle"
          />
          <Animated.Text key={handleHint} entering={FadeIn} style={[type.caption, { color: hintColor, paddingHorizontal: 4 }]}>
            {handleHint}
          </Animated.Text>
        </View>
        <TextField
          label={t('channels.description')}
          icon="edit"
          value={description}
          onChangeText={setDescription}
          maxLength={1024}
          multiline
          placeholder={t('channels.descriptionPlaceholder')}
        />
        <View style={{ marginHorizontal: -16 }}>
          <ToggleRow label={t('channels.private')} sublabel={t('channels.privateHint')} value={isPrivate} onChange={setIsPrivate} />
        </View>
        <Button
          label={t('channels.create')}
          icon="megaphone"
          loading={saving}
          disabled={!name.trim() || !valid || available === false}
          onPress={() => void create()}
          style={{ marginBottom: insets.bottom + 16 }}
        />
      </ScrollView>
    </View>
  );
}
