import React, { useState } from 'react';
import { ScrollView, TextInput } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { friendlyError } from '../../src/core/network/supabase';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { communitiesStore } from '../../src/features/communities/useCommunitiesStore';
import { Banner, groupStyles as gs, PrimaryButton, ScreenHeader, SectionHeader } from '../../src/features/groups/components/GroupComponents';
import { notify } from '../../src/features/groups/components/ui';
import { Colors } from '../../src/shared/theme/theme';

export default function NewCommunityScreen() {
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
      notify('Could not create community', friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={gs.container} edges={['top']}>
      <ScreenHeader title="New community" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={gs.scroll} keyboardShouldPersistTaps="handled">
        <Banner
          icon="megaphone-outline"
          text="You'll get an announcements group where only admins can post. Add your existing groups or create new ones."
        />
        <SectionHeader title="Name" />
        <TextInput style={gs.input} value={name} onChangeText={setName} maxLength={48} placeholder="Community name" placeholderTextColor={Colors.textTertiary} />
        <SectionHeader title="Description" />
        <TextInput
          style={[gs.input, { minHeight: 80 }]}
          value={description}
          onChangeText={setDescription}
          maxLength={1024}
          multiline
          placeholder="What brings these groups together? (optional)"
          placeholderTextColor={Colors.textTertiary}
        />
        <PrimaryButton label="Create community" onPress={() => void create()} disabled={saving || !name.trim()} />
      </ScrollView>
    </SafeAreaView>
  );
}
