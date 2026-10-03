import React, { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Fonts, Type } from '../src/shared/theme/theme';
import { Avatar, Grain, Icon, IconButton, IconName, PhotoArt, Pill, Pressy, SCENES, notify, sceneFor, useLayout } from '../src/shared/ui';

const CAPTIONS = ['The light up there right now', 'Ten minutes later', 'Golden hour, finally', 'Moonrise over the bay', 'Morning trail', 'Fog rolling in'];

export default function MediaViewerScreen() {
  const insets = useSafeAreaInsets();
  const { isWide, width, height } = useLayout();
  const { uri, type, name, caption, date, seed, scene } = useLocalSearchParams<{
    uri?: string;
    type?: string;
    name?: string;
    caption?: string;
    date?: string;
    seed?: string;
    scene?: string;
  }>();

  const start = scene ? Number(scene) : seed ? sceneFor(seed) : 0;
  const [ix, setIx] = useState(start % SCENES.length);
  const [chrome, setChrome] = useState(true);
  const hasReal = !!uri;
  const count = hasReal ? 1 : SCENES.length;
  const currentCaption = hasReal ? caption : ix === start % SCENES.length && caption ? caption : CAPTIONS[ix];

  const go = (d: number) => setIx((i) => (i + d + count) % count);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'));

  const frame = useMemo(() => {
    const maxW = isWide ? Math.min(width - 260, 960) : width;
    const maxH = isWide ? height - 360 : height * 0.5;
    const w = Math.min(maxW, maxH * (320 / 210));
    return { w, h: w * (210 / 320) };
  }, [width, height, isWide]);

  const actions: [IconName, string, () => void][] = [
    ['reply', 'Reply', close],
    ['forward', 'Forward', () => notify('Forward', 'Pick a chat to send this to. It stays end-to-end encrypted.')],
    ['download', 'Save', () => notify('Saved to this device', 'The photo was decrypted and saved locally.')],
    ['share', 'Share', () => notify('Share', 'Shared outside Vero, it’s no longer end-to-end encrypted.')],
  ];

  return (
    <View style={styles.container}>
      <Grain opacity={0.06} />

      <Pressable style={styles.stage} onPress={() => setChrome((c) => !c)} accessibilityLabel={chrome ? 'Hide controls' : 'Show controls'}>
        <Animated.View key={`${ix}`} entering={ZoomIn.springify().damping(18)} style={[styles.frame, { width: frame.w, height: frame.h }, isWide && styles.frameWide]}>
          {hasReal ? (
            <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
          ) : (
            <PhotoArt scene={ix} width="100%" height="100%" />
          )}
          {type === 'video' && (
            <View style={styles.play}>
              <Icon name="play" size={28} color={Colors.ink} style={{ marginLeft: 4 }} />
            </View>
          )}
        </Animated.View>
      </Pressable>

      {chrome && (
        <>
          <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(160)} style={[styles.top, { paddingTop: insets.top + 12 }]}>
            {!isWide && <IconButton icon="back" label="Close" onPress={close} />}
            <Avatar name={name || 'Photo'} size={40} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={Type.name} numberOfLines={1}>
                {name || 'Photo'}
              </Text>
              <Text style={Type.caption}>
                {date || 'Today'}
                {count > 1 ? ` · ${ix + 1} of ${count}` : ''}
              </Text>
            </View>
            {isWide && <Pill icon="lock" label="Encrypted" />}
            {isWide && actions.map(([icon, label, fn]) => <IconButton key={label} icon={icon} label={label} onPress={fn} />)}
            {isWide ? <IconButton icon="close" label="Close" variant="glass" onPress={close} /> : <IconButton icon="more" label="More" onPress={() => notify('Photo options')} />}
          </Animated.View>

          {isWide && count > 1 && (
            <>
              <Animated.View entering={FadeIn} style={[styles.navBtn, { left: 32 }]}>
                <IconButton icon="back" label="Previous photo" size={56} variant="glass" onPress={() => go(-1)} />
              </Animated.View>
              <Animated.View entering={FadeIn} style={[styles.navBtn, { right: 32 }]}>
                <IconButton icon="forwardChevron" label="Next photo" size={56} variant="glass" onPress={() => go(1)} />
              </Animated.View>
            </>
          )}

          <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(160)} style={[styles.bottom, { paddingBottom: insets.bottom + 22 }]}>
            {currentCaption ? <Text style={[Type.body, { textAlign: 'center', color: '#D9D2C1' }]}>{currentCaption}</Text> : null}
            {count > 1 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
                {SCENES.map((_, i) => (
                  <Pressy
                    key={i}
                    onPress={() => setIx(i)}
                    scaleTo={0.9}
                    accessibilityLabel={`Photo ${i + 1}`}
                    accessibilityState={{ selected: i === ix }}
                    style={[styles.thumb, i === ix && styles.thumbOn, isWide && { width: 64, height: 64 }]}
                  >
                    <PhotoArt scene={i} width="100%" height="100%" city={false} />
                  </Pressy>
                ))}
              </ScrollView>
            )}
            {!isWide && (
              <View style={styles.actions}>
                {actions.map(([icon, label, fn]) => (
                  <Pressy key={label} onPress={fn} style={styles.action} scaleTo={0.9} accessibilityLabel={label}>
                    <View style={styles.actionIcon}>
                      <Icon name={icon} size={22} color={Colors.cream} />
                    </View>
                    <Text style={styles.actionText}>{label}</Text>
                  </Pressy>
                ))}
              </View>
            )}
          </Animated.View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.black },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  frame: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  frameWide: {
    borderRadius: 22,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 40 },
    shadowOpacity: 0.6,
    shadowRadius: 100,
  },
  play: { width: 66, height: 66, borderRadius: 33, backgroundColor: 'rgba(237,231,217,0.92)', alignItems: 'center', justifyContent: 'center' },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: 'rgba(7,8,8,0.6)',
  },
  navBtn: { position: 'absolute', top: '50%', marginTop: -28 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', gap: 16, paddingTop: 16, paddingHorizontal: 16, backgroundColor: 'rgba(7,8,8,0.6)' },
  strip: { gap: 8, padding: 8, borderRadius: 20, backgroundColor: 'rgba(237,231,217,0.05)' },
  thumb: { width: 50, height: 50, borderRadius: 12, overflow: 'hidden', opacity: 0.5 },
  thumbOn: { opacity: 1, borderWidth: 2, borderColor: Colors.brass, transform: [{ translateY: -3 }] },
  actions: { flexDirection: 'row', justifyContent: 'space-around', width: '100%' },
  action: { alignItems: 'center', gap: 6, minWidth: 64 },
  actionIcon: { width: 48, height: 48, borderRadius: 16, backgroundColor: 'rgba(237,231,217,0.08)', alignItems: 'center', justifyContent: 'center' },
  actionText: { fontFamily: Fonts.medium, fontSize: 11.5, color: '#D9D2C1' },
});
