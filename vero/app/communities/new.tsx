import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { friendlyError } from '../../src/core/network/supabase';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { communitiesStore } from '../../src/features/communities/useCommunitiesStore';
import { Banner, EntityAvatar, ScreenHeader, useGroupStyles } from '../../src/features/groups/components/GroupComponents';
import { notify } from '../../src/features/groups/components/ui';
import { useT } from '../../src/shared/i18n';
import { Button, TextField } from '../../src/shared/ui';

export default function NewCommunityScreen() {
  const insets = useSafeAreaInsets();
  const gs = useGroupStyles();
  const t = useT();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const create = async () => {
    setSaving(true);
    try {
      const id = await communitiesStore.getState().create(name, description);
      void useChatsStore.getState().load({ sync: false }); // the announcements group
      router.replace(`/communities/${id}`);
    } catch (e) {
      notify(t('communities.createFailed'), friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[gs.container, { paddingTop: insets.top }]}>
      <ScreenHeader title={t('communities.new')} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={[gs.scroll, { paddingHorizontal: 16, gap: 14, paddingTop: 16 }]} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: 'center', paddingVertical: 8 }}>
          <EntityAvatar name={name} size={84} icon="grid" />
        </View>
        <View style={{ marginHorizontal: -16 }}>
          <Banner icon="megaphone" text={t('communities.newNote')} />
        </View>
        <TextField label={t('channels.name')} icon="grid" value={name} onChangeText={setName} maxLength={48} placeholder={t('communities.namePlaceholder')} />
        <TextField label={t('channels.description')} icon="edit" value={description} onChangeText={setDescription} maxLength={1024} multiline placeholder={t('communities.descriptionPlaceholder')} />
        <Button label={t('communities.create')} icon="grid" loading={saving} disabled={!name.trim()} onPress={() => void create()} style={{ marginBottom: insets.bottom + 16 }} />
      </ScrollView>
    </View>
  );
}
