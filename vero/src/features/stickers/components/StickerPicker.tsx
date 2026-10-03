/**
 * Sticker tab: recents, favourites, my stickers (incl. "create from photo")
 * and the bundled packs. Tap = send, long-press = favourite / delete.
 */

import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { friendlyError } from '../../../core/network/supabase';
import { Colors } from '../../../shared/theme/theme';
import { BUNDLED_STICKER_ASSETS } from '../bundledAssets';
import { STICKER_PACKS } from '../packs';
import { stickerService } from '../StickerService';
import { itemKey, StickerItem, useStickerStore } from '../useStickerStore';

export function stickerSource(item: StickerItem): number | { uri: string } | null {
  if (item.kind === 'bundled') return BUNDLED_STICKER_ASSETS[`${item.pack}/${item.id}`] ?? null;
  return { uri: item.uri };
}

function Cell({ item, onSend, onLong }: { item: StickerItem; onSend: (i: StickerItem) => void; onLong: (i: StickerItem) => void }) {
  const source = stickerSource(item);
  if (!source) return null;
  return (
    <TouchableOpacity
      style={styles.cell}
      onPress={() => onSend(item)}
      onLongPress={() => onLong(item)}
      accessibilityLabel={`Sticker ${item.emoji ?? ''}`}
    >
      <Image source={source} style={styles.img} contentFit="contain" />
    </TouchableOpacity>
  );
}

export function StickerPicker({ userId, onSend }: { userId: string; onSend: (item: StickerItem) => Promise<void> }) {
  const account = useStickerStore((s) => s.accounts[userId]);
  const toggleFavourite = useStickerStore((s) => s.toggleFavourite);
  const [section, setSection] = useState<string>('recent');
  const [busy, setBusy] = useState(false);

  const recents = account?.recents ?? [];
  const favourites = account?.favourites ?? [];
  const custom = account?.custom ?? [];

  const sections = useMemo(
    () => [
      { id: 'recent', icon: 'time-outline' as const },
      { id: 'favourites', icon: 'star-outline' as const },
      { id: 'mine', icon: 'images-outline' as const },
      ...STICKER_PACKS.map((p) => ({ id: p.id, icon: null, pack: p })),
    ],
    []
  );

  const send = async (item: StickerItem) => {
    setBusy(true);
    try {
      await onSend(item);
    } catch (e) {
      Alert.alert('Sticker not sent', friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const onLong = (item: StickerItem) => {
    const fav = favourites.some((f) => itemKey(f) === itemKey(item));
    if (Platform.OS === 'web') {
      // react-native-web has no multi-button Alert.
      if (globalThis.confirm?.(fav ? 'Remove from favourites?' : 'Add to favourites?')) toggleFavourite(userId, item);
      else if (item.kind === 'custom' && globalThis.confirm?.('Delete this sticker?')) void stickerService.removeCustom(item);
      return;
    }
    const buttons: { text: string; style?: 'destructive' | 'cancel'; onPress?: () => void }[] = [
      { text: fav ? 'Remove from favourites' : 'Add to favourites', onPress: () => toggleFavourite(userId, item) },
    ];
    if (item.kind === 'custom') {
      buttons.push({ text: 'Delete sticker', style: 'destructive', onPress: () => void stickerService.removeCustom(item) });
    }
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Sticker', undefined, buttons);
  };

  const createFromPhoto = async () => {
    try {
      setBusy(true);
      const s = await stickerService.createFromPhoto();
      if (s) setSection('mine');
    } catch (e) {
      Alert.alert('Could not make a sticker', friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  let items: StickerItem[] = [];
  let empty = '';
  if (section === 'recent') {
    items = recents;
    empty = 'Stickers you send show up here.';
  } else if (section === 'favourites') {
    items = favourites;
    empty = 'Long-press a sticker to add it to favourites.';
  } else if (section === 'mine') {
    items = custom;
    empty = 'Turn any photo into a sticker.';
  } else {
    const pack = STICKER_PACKS.find((p) => p.id === section);
    items = (pack?.stickers ?? []).map((s) => ({ kind: 'bundled', pack: s.pack, id: s.id, emoji: s.emoji }));
  }

  return (
    <View style={styles.flex}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabsContent}>
        {sections.map((s) => (
          <TouchableOpacity key={s.id} onPress={() => setSection(s.id)} style={[styles.tab, section === s.id && styles.tabActive]}>
            {s.icon ? (
              <Ionicons name={s.icon} size={20} color={section === s.id ? Colors.accent : Colors.textSecondary} />
            ) : (
              <Image
                source={BUNDLED_STICKER_ASSETS[`${s.id}/${'pack' in s && s.pack ? s.pack.stickers[0].id : ''}`]}
                style={styles.tabImg}
                contentFit="contain"
              />
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>
      {busy ? <ActivityIndicator color={Colors.accent} style={styles.busy} /> : null}
      <ScrollView contentContainerStyle={styles.grid}>
        {section === 'mine' ? (
          <TouchableOpacity style={[styles.cell, styles.create]} onPress={createFromPhoto} accessibilityLabel="Create sticker from photo">
            <Ionicons name="add" size={28} color={Colors.accent} />
            <Text style={styles.createText}>From photo</Text>
          </TouchableOpacity>
        ) : null}
        {items.map((item) => (
          <Cell key={itemKey(item)} item={item} onSend={send} onLong={onLong} />
        ))}
        {items.length === 0 ? <Text style={styles.empty}>{empty}</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  tabs: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: Colors.border },
  tabsContent: { paddingHorizontal: 8, gap: 4 },
  tab: { padding: 8, borderRadius: 10, marginVertical: 6 },
  tabActive: { backgroundColor: Colors.surfaceHighlight },
  tabImg: { width: 24, height: 24 },
  busy: { position: 'absolute', top: 60, alignSelf: 'center', zIndex: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: 8 },
  cell: { width: '25%', aspectRatio: 1, padding: 6, alignItems: 'center', justifyContent: 'center' },
  img: { width: '100%', height: '100%' },
  create: { borderWidth: 1, borderStyle: 'dashed', borderColor: Colors.border, borderRadius: 14 },
  createText: { color: Colors.textSecondary, fontSize: 11, marginTop: 2 },
  empty: { color: Colors.textTertiary, fontSize: 13, padding: 16, width: '100%', textAlign: 'center' },
});
