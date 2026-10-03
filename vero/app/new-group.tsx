import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeInRight, FadeOutLeft, ZoomIn, ZoomOut, LinearTransition } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../src/features/auth/useAuthStore';
import { conversationRepository } from '../src/features/chats/ConversationRepository';
import { DEMO_CONTACTS, DEMO_MEMBERS, DEMO_MESSAGES, DEMO_USER_ID } from '../src/features/demo/demoData';
import { User } from '../src/shared/models/Message';
import { AvatarTones, Colors, Fonts, Type } from '../src/shared/theme/theme';
import { Avatar, Button, Chip, DotWall, Grain, Icon, IconButton, Pressy, SearchField, notify, useLayout } from '../src/shared/ui';

const TIMERS = ['Off', '24 hours', '7 days', '90 days'];

function Check({ on }: { on: boolean }) {
  return (
    <View style={[styles.check, on && styles.checkOn]}>
      {on && (
        <Animated.View entering={ZoomIn.springify().damping(12)}>
          <Icon name="check" size={15} color={Colors.brassInk} strokeWidth={2.6} />
        </Animated.View>
      )}
    </View>
  );
}

export default function NewGroupScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { user } = useAuthStore();
  const isDemo = user?.id === DEMO_USER_ID;

  const [contacts, setContacts] = useState<User[]>(isDemo ? DEMO_CONTACTS : []);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [tone, setTone] = useState<string>(AvatarTones[1]);
  const [timer, setTimer] = useState('Off');
  const [step, setStep] = useState<1 | 2>(1);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (isDemo || !user?.id) return;
    conversationRepository
      .searchUsers('a', user.id)
      .then((r) => setContacts(r.length ? r : DEMO_CONTACTS))
      .catch(() => setContacts(DEMO_CONTACTS));
  }, [user?.id]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return contacts.filter((c) => c.displayName.toLowerCase().includes(q) || c.username.toLowerCase().includes(q));
  }, [contacts, query]);
  const picked = contacts.filter((c) => selected.has(c.id));

  const close = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'));

  const create = async () => {
    if (!groupName.trim()) {
      notify('Name your group', 'Give the group a name so everyone knows what it’s for.');
      return;
    }
    if (picked.length === 0) {
      notify('Add people', 'Pick at least one person for the group.');
      return;
    }
    if (!user?.id) return;
    if (isDemo) {
      const cid = `demo-group-${Date.now()}`;
      DEMO_MEMBERS[cid] = [{ id: user.id, displayName: user.displayName || 'You', username: user.username || 'you' }, ...picked];
      DEMO_MESSAGES[cid] = [];
      router.replace({ pathname: '/chat/[id]', params: { id: cid, name: groupName.trim(), group: '1' } } as any);
      return;
    }
    setCreating(true);
    try {
      const res = await conversationRepository.createGroupConversation(user.id, picked.map((p) => p.id), groupName.trim());
      if (res) router.replace({ pathname: '/chat/[id]', params: { id: res.conversationId, name: groupName.trim(), group: '1' } } as any);
      else notify('Couldn’t create the group', 'Check your connection and try again.');
    } finally {
      setCreating(false);
    }
  };

  const countText = picked.length ? `${picked.length} of 1,000 selected` : 'Choose who to add';

  const chips = picked.length > 0 && (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
      {picked.map((p) => (
        <Animated.View key={p.id} entering={ZoomIn.springify().damping(13)} exiting={ZoomOut.duration(160)} layout={LinearTransition.springify()}>
          <View style={styles.chip}>
            <Avatar name={p.displayName} size={28} />
            <Text style={styles.chipText}>{p.displayName.split(' ')[0]}</Text>
            <Pressy onPress={() => toggle(p.id)} accessibilityLabel={`Remove ${p.displayName}`} style={styles.chipX} scaleTo={0.85}>
              <Icon name="close" size={13} color={Colors.muted} />
            </Pressy>
          </View>
        </Animated.View>
      ))}
    </ScrollView>
  );

  const list = (
    <FlatList
      data={filtered}
      keyExtractor={(c) => c.id}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: isWide ? 8 : 120 }}
      renderItem={({ item, index }) => {
        const on = selected.has(item.id);
        return (
          <Animated.View entering={FadeInDown.delay(Math.min(index, 10) * 35).duration(380)}>
            <Pressy
              onPress={() => toggle(item.id)}
              scaleTo={0.98}
              accessibilityState={{ selected: on }}
              accessibilityLabel={item.displayName}
              hoverStyle={{ backgroundColor: Colors.creamTint }}
              style={styles.row}
            >
              <Avatar name={item.displayName} size={isWide ? 44 : 50} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={Type.name} numberOfLines={1}>
                  {item.displayName}
                </Text>
                <Text style={Type.caption} numberOfLines={1}>
                  {item.about || `@${item.username}`}
                </Text>
              </View>
              <Check on={on} />
            </Pressy>
          </Animated.View>
        );
      }}
    />
  );

  const details = (
    <View style={{ gap: 20 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
        <Pressy
          onPress={() => notify('Group photo', 'Choose a photo from your library, or keep the colour tile.')}
          style={[styles.groupPhoto, { backgroundColor: tone }]}
          accessibilityLabel="Add group photo"
        >
          {groupName.trim() ? (
            <Text style={{ fontFamily: Fonts.display, fontSize: 30, color: Colors.avatarText }}>{groupName.trim().slice(0, 2).toUpperCase()}</Text>
          ) : (
            <Icon name="camera" size={28} color={Colors.cream} />
          )}
        </Pressy>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', flex: 1 }}>
          {AvatarTones.slice(0, 6).map((t) => (
            <Pressy
              key={t}
              onPress={() => setTone(t)}
              scaleTo={0.85}
              accessibilityLabel="Group colour"
              accessibilityState={{ selected: tone === t }}
              style={[styles.swatch, { backgroundColor: t }, tone === t && styles.swatchOn]}
            />
          ))}
        </View>
      </View>
      <View style={{ gap: 8 }}>
        <Text style={Type.label}>Group name</Text>
        <TextInput
          value={groupName}
          onChangeText={setGroupName}
          placeholder="Weekend shoot"
          placeholderTextColor={Colors.faint}
          selectionColor={Colors.brass}
          maxLength={50}
          accessibilityLabel="Group name"
          style={[styles.nameInput, groupName.length > 0 && { borderColor: Colors.brass }]}
        />
        <Text style={[Type.small, { alignSelf: 'flex-end' }]}>{groupName.length}/50</Text>
      </View>
      <View style={{ gap: 10 }}>
        <Text style={Type.label}>Disappearing messages</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {TIMERS.map((t) => (
            <Chip key={t} label={t} active={timer === t} onPress={() => setTimer(t)} />
          ))}
        </View>
      </View>
      <View style={styles.note}>
        <Icon name="lock" size={16} color={Colors.sage} />
        <Text style={[Type.caption, { flex: 1, color: '#B7D3C1' }]}>Group messages are end-to-end encrypted for every member.</Text>
      </View>
    </View>
  );

  if (isWide) {
    return (
      <View style={styles.wideBg}>
        <DotWall />
        <View style={styles.dim} />
        <Grain />
        <Animated.View entering={FadeInDown.springify().damping(18)} style={styles.dialog} accessibilityViewIsModal>
          <View style={styles.dialogLeft}>
            <View style={styles.dialogHead}>
              <View>
                <Text style={Type.h2}>New group</Text>
                <Text style={Type.caption}>{countText}</Text>
              </View>
              <IconButton icon="close" label="Close" variant="filled" onPress={close} />
            </View>
            {chips}
            <SearchField value={query} onChangeText={setQuery} placeholder="Search people" />
            <View style={{ flex: 1, minHeight: 0 }}>{list}</View>
          </View>
          <View style={styles.dialogRight}>
            <Text style={Type.eyebrow}>GROUP DETAILS</Text>
            {details}
            <View style={{ flex: 1 }} />
            <Button label="Create group" iconRight="arrowRight" loading={creating} disabled={!groupName.trim() || picked.length === 0} onPress={create} />
          </View>
        </Animated.View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Grain />
      <View style={styles.header}>
        <IconButton icon="back" label="Back" onPress={() => (step === 2 ? setStep(1) : close())} />
        <View style={{ flex: 1 }}>
          <Text style={Type.h3}>{step === 1 ? 'New group' : 'Group details'}</Text>
          <Animated.Text key={countText} entering={FadeIn} style={Type.caption}>
            {step === 1 ? countText : `${picked.length} ${picked.length === 1 ? 'person' : 'people'}`}
          </Animated.Text>
        </View>
        <Text style={[Type.eyebrow, { paddingRight: 12 }]}>{step}/2</Text>
      </View>

      {step === 1 ? (
        <Animated.View key="s1" entering={FadeIn} exiting={FadeOutLeft.duration(180)} style={{ flex: 1, gap: 12 }}>
          <View style={{ paddingHorizontal: 20, gap: 12 }}>
            {chips}
            <SearchField value={query} onChangeText={setQuery} placeholder="Search people" />
          </View>
          {list}
        </Animated.View>
      ) : (
        <Animated.View key="s2" entering={FadeInRight.springify().damping(18)} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 140 }} keyboardShouldPersistTaps="handled">
            {details}
          </ScrollView>
        </Animated.View>
      )}

      {picked.length > 0 && (
        <Animated.View entering={FadeInDown.springify().damping(16)} style={[styles.bottom, { bottom: insets.bottom + 24 }]}>
          {step === 1 ? (
            <Button label="Next" iconRight="arrowRight" onPress={() => setStep(2)} style={styles.floatBtn} />
          ) : (
            <Button label="Create group" iconRight="check" loading={creating} disabled={!groupName.trim()} onPress={create} style={styles.floatBtn} />
          )}
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.ink },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 10 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 38,
    paddingLeft: 5,
    paddingRight: 6,
    borderRadius: 19,
    backgroundColor: Colors.raised,
    borderWidth: 1,
    borderColor: Colors.line2,
  },
  chipText: { fontFamily: Fonts.medium, fontSize: 13.5, color: Colors.cream },
  chipX: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.field },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 20, paddingVertical: 9, borderRadius: 14 },
  check: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, borderColor: Colors.line3, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: Colors.brass, borderColor: Colors.brass },
  groupPhoto: { width: 84, height: 84, borderRadius: 26, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.line2 },
  swatch: { width: 30, height: 30, borderRadius: 10 },
  swatchOn: { borderWidth: 2, borderColor: Colors.brass },
  nameInput: {
    height: 52,
    paddingHorizontal: 16,
    borderRadius: 15,
    backgroundColor: Colors.raised,
    borderWidth: 1.5,
    borderColor: Colors.line,
    fontFamily: Fonts.body,
    fontSize: 16,
    color: Colors.cream,
    outlineStyle: 'none',
  } as any,
  note: { flexDirection: 'row', gap: 10, alignItems: 'center', padding: 14, borderRadius: 14, backgroundColor: Colors.sageTint },
  bottom: { position: 'absolute', left: 20, right: 20 },
  floatBtn: { height: 58, borderRadius: 18, shadowColor: '#000', shadowOffset: { width: 0, height: 14 }, shadowOpacity: 0.5, shadowRadius: 30, elevation: 12 },
  wideBg: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: Colors.ink },
  dim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(6,7,7,0.6)' },
  dialog: {
    width: '100%',
    maxWidth: 980,
    height: '100%',
    maxHeight: 720,
    flexDirection: 'row',
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: Colors.panel,
    borderWidth: 1,
    borderColor: Colors.line2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 40 },
    shadowOpacity: 0.6,
    shadowRadius: 80,
  },
  dialogLeft: { flex: 1.15, padding: 24, gap: 14, borderRightWidth: 1, borderRightColor: Colors.line },
  dialogHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dialogRight: { flex: 1, padding: 28, gap: 20, backgroundColor: '#0F1211' },
});
