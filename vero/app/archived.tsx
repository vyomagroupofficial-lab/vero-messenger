import React, { useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useChatsStore } from '../src/features/chats/useChatsStore';
import { useChatPrefsStore } from '../src/features/chats/useChatPrefsStore';
import { splitArchived } from '../src/features/chats/chatList';
import { ChatActionSheet, ChatListRow } from '../src/features/chats/components/ChatRowParts';
import { ScreenHeader } from '../src/features/groups/components/GroupComponents';
import { Conversation } from '../src/shared/models/Message';
import { makeStyles, useTheme } from '../src/shared/theme/ThemeProvider';
import { useT } from '../src/shared/i18n';
import { EmptyState, Grain, Icon, Toggle } from '../src/shared/ui';

export default function ArchivedScreen() {
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const conversations = useChatsStore((st) => st.conversations);
  const archived = useMemo(() => splitArchived(conversations).archived, [conversations]);
  const keepArchived = useChatPrefsStore((st) => st.keepArchived);
  const setKeepArchived = useChatPrefsStore((st) => st.setKeepArchived);
  const [actionChat, setActionChat] = useState<Conversation | null>(null);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <Grain />
      <ScreenHeader title={t('chats.archived')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))} />
      <FlatList
        data={archived}
        keyExtractor={(cv) => cv.id}
        contentContainerStyle={[s.list, { paddingBottom: insets.bottom + 32 }]}
        ListHeaderComponent={
          <View style={s.setting}>
            <View style={s.settingIcon}>
              <Icon name="archive" size={18} color={c.accentText} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={s.settingTitle}>{t('archived.keep')}</Text>
              <Text style={type.caption}>{t('archived.keepHint')}</Text>
            </View>
            <Toggle label={t('archived.keep')} value={keepArchived} onValueChange={setKeepArchived} />
          </View>
        }
        renderItem={({ item, index }) => (
          <ChatListRow conversation={item} index={index} onPress={() => router.push(`/chat/${item.id}`)} onLongPress={() => setActionChat(item)} />
        )}
        ListEmptyComponent={<EmptyState icon="archive" title={t('archived.emptyTitle')} body={t('archived.empty')} />}
      />
      <ChatActionSheet conversation={actionChat} onClose={() => setActionChat(null)} />
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  root: { flex: 1, backgroundColor: c.bg },
  list: { paddingTop: 8, width: '100%', maxWidth: 720, alignSelf: 'center' },
  setting: { flexDirection: 'row', alignItems: 'center', gap: 12, margin: 16, marginBottom: 12, padding: 14, borderRadius: 20, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line },
  settingIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center' },
  settingTitle: { fontFamily: f.semibold, fontSize: 15, color: c.text },
}));
