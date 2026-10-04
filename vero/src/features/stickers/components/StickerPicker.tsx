/**
 * Sticker tab: recents, favourites, my stickers (incl. "create from photo")
 * and the bundled packs. Tap = send, long-press = favourite / delete.
 */

import React, { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { Image } from 'expo-image';
import { friendlyError } from '../../../core/network/supabase';
import { useT } from '../../../shared/i18n';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { Icon, IconName, Pressy, confirmAction, notify } from '../../../shared/ui';
import { BUNDLED_STICKER_ASSETS } from '../bundledAssets';
import { STICKER_PACKS } from '../packs';
import { stickerService } from '../StickerService';
import { itemKey, StickerItem, useStickerStore } from '../useStickerStore';

export function stickerSource(item: StickerItem): number | { uri: string } | null {
  if (item.kind === 'bundled') return BUNDLED_STICKER_ASSETS[`${item.pack}/${item.id}`] ?? null;
  return { uri: item.uri };
}

function Cell({ item, index, onSend, onLong }: { item: StickerItem; index: number; onSend: (i: StickerItem) => void; onLong: (i: StickerItem) => void }) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const source = stickerSource(item);
  if (!source) return null;
  return (
    <Animated.View entering={ZoomIn.delay(Math.min(index, 16) * 18).springify().damping(15)} style={s.cell}>
      <Pressy onPress={() => onSend(item)} onLongPress={() => onLong(item)} scaleTo={0.86} hoverStyle={{ backgroundColor: c.tint }} style={s.cellInner} accessibilityLabel={`${t('stickers.sticker')} ${item.emoji ?? ''}`}>
        <Image source={source} style={s.img} contentFit="contain" />
      </Pressy>
    </Animated.View>
  );
}

export function StickerPicker({ userId, onSend }: { userId: string; onSend: (item: StickerItem) => Promise<void> }) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const account = useStickerStore((st) => st.accounts[userId]);
  const toggleFavourite = useStickerStore((st) => st.toggleFavourite);
  const [section, setSection] = useState<string>('recent');
  const [busy, setBusy] = useState(false);

  const recents = account?.recents ?? [];
  const favourites = account?.favourites ?? [];
  const custom = account?.custom ?? [];

  const sections = useMemo(
    () => [
      { id: 'recent', icon: 'clock' as IconName, label: t('stickers.recent') },
      { id: 'favourites', icon: 'heart' as IconName, label: t('stickers.favourites') },
      { id: 'mine', icon: 'image' as IconName, label: t('stickers.mine') },
      ...STICKER_PACKS.map((p) => ({ id: p.id, icon: null as IconName | null, pack: p, label: p.id })),
    ],
    [t]
  );

  const send = async (item: StickerItem) => {
    setBusy(true);
    try {
      await onSend(item);
    } catch (e) {
      notify(t('stickers.notSent'), friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const onLong = (item: StickerItem) => {
    const fav = favourites.some((f) => itemKey(f) === itemKey(item));
    confirmAction({
      title: t('stickers.sticker'),
      message: fav ? t('stickers.removeFavouriteQ') : t('stickers.addFavouriteQ'),
      confirmLabel: fav ? t('stickers.removeFavourite') : t('stickers.addFavourite'),
      onConfirm: () => toggleFavourite(userId, item),
    });
    if (item.kind === 'custom') {
      setTimeout(
        () => confirmAction({ title: t('stickers.sticker'), message: t('stickers.deleteQ'), confirmLabel: t('common.delete'), destructive: true, onConfirm: () => void stickerService.removeCustom(item) }),
        0
      );
    }
  };

  const createFromPhoto = async () => {
    try {
      setBusy(true);
      const created = await stickerService.createFromPhoto();
      if (created) setSection('mine');
    } catch (e) {
      notify(t('stickers.createFailed'), friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  let items: StickerItem[] = [];
  let empty = '';
  if (section === 'recent') {
    items = recents;
    empty = t('stickers.recentEmpty');
  } else if (section === 'favourites') {
    items = favourites;
    empty = t('stickers.favouritesEmpty');
  } else if (section === 'mine') {
    items = custom;
    empty = t('stickers.mineEmpty');
  } else {
    const pack = STICKER_PACKS.find((p) => p.id === section);
    items = (pack?.stickers ?? []).map((st) => ({ kind: 'bundled', pack: st.pack, id: st.id, emoji: st.emoji }));
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabs} contentContainerStyle={s.tabsContent}>
        {sections.map((sec) => {
          const on = section === sec.id;
          return (
            <Pressy key={sec.id} onPress={() => setSection(sec.id)} scaleTo={0.9} style={[s.tab, on && s.tabActive]} accessibilityLabel={sec.label} accessibilityState={{ selected: on }}>
              {sec.icon ? (
                <Icon name={sec.icon} size={19} color={on ? c.accentText : c.muted} />
              ) : (
                <Image source={BUNDLED_STICKER_ASSETS[`${sec.id}/${'pack' in sec && sec.pack ? sec.pack.stickers[0].id : ''}`]} style={s.tabImg} contentFit="contain" />
              )}
            </Pressy>
          );
        })}
      </ScrollView>
      {busy ? <ActivityIndicator color={c.accent} style={s.busy} /> : null}
      <ScrollView contentContainerStyle={s.grid}>
        {section === 'mine' ? (
          <View style={s.cell}>
            <Pressy style={[s.cellInner, s.create]} onPress={createFromPhoto} scaleTo={0.92} hoverStyle={{ borderColor: c.accentLine }} accessibilityLabel={t('stickers.fromPhoto')}>
              <Icon name="plus" size={24} color={c.accentText} />
              <Text style={s.createText}>{t('stickers.fromPhoto')}</Text>
            </Pressy>
          </View>
        ) : null}
        {items.map((item, i) => (
          <Cell key={itemKey(item)} item={item} index={i} onSend={send} onLong={onLong} />
        ))}
        {items.length === 0 ? (
          <Animated.Text entering={FadeIn} style={s.empty}>
            {empty}
          </Animated.Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  tabs: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: c.line },
  tabsContent: { paddingHorizontal: 10, gap: 4, alignItems: 'center' },
  tab: { width: 40, height: 40, borderRadius: 12, marginVertical: 6, alignItems: 'center', justifyContent: 'center' },
  tabActive: { backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2 },
  tabImg: { width: 24, height: 24 },
  busy: { position: 'absolute', top: 64, alignSelf: 'center', zIndex: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: 8 },
  cell: { width: '25%', aspectRatio: 1, padding: 4 },
  cellInner: { flex: 1, borderRadius: 16, padding: 6, alignItems: 'center', justifyContent: 'center' },
  img: { width: '100%', height: '100%' },
  create: { borderWidth: 1.5, borderStyle: 'dashed', borderColor: c.line3, gap: 4 },
  createText: { fontFamily: f.medium, color: c.muted, fontSize: 11 },
  empty: { fontFamily: f.body, color: c.faint, fontSize: 13, padding: 20, width: '100%', textAlign: 'center' },
}));
