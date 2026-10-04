import React, { useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeInUp, FadeOut, ZoomIn } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView } from 'expo-video';
import { makeStyles, useTheme } from '../src/shared/theme/ThemeProvider';
import { useT } from '../src/shared/i18n';
import { Grain, Icon, IconButton, notify, useLayout } from '../src/shared/ui';

// The viewer stays dark in both themes: photos read best on a near-black stage.

function VideoContent({ uri }: { uri: string }) {
  const s = useStyles();
  const player = useVideoPlayer(uri, (p) => {
    p.play();
  });
  return <VideoView player={player} style={s.media} nativeControls contentFit="contain" />;
}

export default function MediaViewerScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const { uri, type: kind, name, caption } = useLocalSearchParams<{ uri: string; type?: string; name?: string; caption?: string }>();
  const [showControls, setShowControls] = useState(true);
  const isVideo = kind === 'video';

  const handleShare = async () => {
    if (!uri) return;
    if (!(await Sharing.isAvailableAsync())) return notify(t('media.shareUnavailable'), t('media.shareUnavailableBody'));
    // Shares the decrypted local copy; whatever app you pick will see the plaintext.
    await Sharing.shareAsync(uri);
  };

  const back = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'));

  return (
    <View style={s.stage}>
      <Grain tone="light" opacity={0.05} />
      <Pressable style={s.canvas} onPress={() => setShowControls((v) => !v)} accessibilityLabel={t('media.toggleControls')}>
        {uri && isVideo ? (
          <VideoContent uri={uri} />
        ) : uri ? (
          <Animated.View entering={ZoomIn.duration(260)} style={{ flex: 1, alignSelf: 'stretch' }}>
            <Image source={{ uri }} style={s.media} resizeMode="contain" accessibilityLabel={caption || name || t('media.photo')} />
          </Animated.View>
        ) : (
          <Animated.View entering={FadeIn} style={s.placeholder}>
            <View style={s.placeholderIcon}>
              <Icon name={isVideo ? 'video' : 'image'} size={40} color="#E7BD72" />
            </View>
            <Text style={[type.h3, { color: c.onStage }]}>{t('media.nothing')}</Text>
            <Text style={[type.caption, { color: c.onStageMuted }]}>{t('media.nothingBody')}</Text>
          </Animated.View>
        )}
      </Pressable>

      {showControls && (
        <>
          <Animated.View entering={FadeInDown.duration(220)} exiting={FadeOut.duration(160)} style={[s.top, { paddingTop: insets.top + 10 }]} pointerEvents="box-none">
            <IconButton icon="back" label={t('common.back')} variant="glass" color={c.onStage} onPress={back} />
            <View style={{ flex: 1, minWidth: 0, alignItems: isWide ? 'flex-start' : 'center', gap: 2 }}>
              <Text style={s.title} numberOfLines={1}>
                {name || (isVideo ? t('media.video') : t('media.photo'))}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Icon name="lock" size={11} color="#86C09F" />
                <Text style={s.sub}>{t('media.decrypted')}</Text>
              </View>
            </View>
            {uri ? <IconButton icon="share" label={t('media.share')} variant="glass" color={c.onStage} onPress={handleShare} /> : <View style={{ width: 44 }} />}
          </Animated.View>

          <Animated.View entering={FadeInUp.duration(220)} exiting={FadeOut.duration(160)} style={[s.bottom, { paddingBottom: insets.bottom + 18 }]} pointerEvents="box-none">
            {caption ? (
              <View style={s.caption}>
                <Text style={s.captionText}>{caption}</Text>
              </View>
            ) : null}
            <View style={s.badge}>
              <Icon name="shieldCheck" size={13} color="#86C09F" />
              <Text style={s.badgeText}>{t('media.cipherNote')}</Text>
            </View>
          </Animated.View>
        </>
      )}
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  stage: { flex: 1, backgroundColor: c.stage },
  canvas: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  media: { flex: 1, width: '100%', height: '100%' },
  placeholder: { alignItems: 'center', gap: 10, padding: 24 },
  placeholderIcon: { width: 96, height: 96, borderRadius: 32, backgroundColor: 'rgba(237,231,217,0.08)', borderWidth: 1, borderColor: 'rgba(237,231,217,0.12)', alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingBottom: 14, backgroundColor: 'rgba(8,9,8,0.55)' },
  title: { fontFamily: f.semibold, fontSize: 16, color: c.onStage },
  sub: { fontFamily: f.medium, fontSize: 11.5, color: c.onStageMuted },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0, alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 18, backgroundColor: 'rgba(8,9,8,0.55)' },
  caption: { maxWidth: 720, alignSelf: 'stretch', alignItems: 'center' },
  captionText: { fontFamily: f.body, fontSize: 15, lineHeight: t.body.lineHeight, color: c.onStage, textAlign: 'center' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 30, borderRadius: 15, backgroundColor: 'rgba(237,231,217,0.08)', borderWidth: 1, borderColor: 'rgba(237,231,217,0.1)' },
  badgeText: { fontFamily: f.medium, fontSize: 11.5, color: c.onStageMuted },
}));
