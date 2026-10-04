import React from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StarredList } from '../src/features/messages/components/StarredList';
import { useChatsStore } from '../src/features/chats/useChatsStore';
import { ScreenHeader } from '../src/features/groups/components/GroupComponents';
import { conversationTitle } from '../src/shared/models/Message';
import { makeStyles } from '../src/shared/theme/ThemeProvider';
import { useT } from '../src/shared/i18n';
import { DotWall } from '../src/shared/ui';

/** Starred messages: all chats, or one chat with ?conversationId=<id>. */
export default function StarredScreen() {
  const insets = useSafeAreaInsets();
  const s = useStyles();
  const t = useT();
  const { conversationId } = useLocalSearchParams<{ conversationId?: string }>();
  const chat = useChatsStore((st) => st.conversations.find((cv) => cv.id === conversationId));
  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <ScreenHeader
        title={t('thread.starred')}
        subtitle={chat ? conversationTitle(chat) : undefined}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))}
      />
      <View style={{ flex: 1 }}>
        <DotWall />
        <StarredList conversationId={conversationId || undefined} />
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
}));
