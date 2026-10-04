/**
 * Downloads + decrypts a story's media, then shows it. Reports the display
 * duration through onReady (fixed for photos, clip length for videos).
 */

import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import i18n from '../../../shared/i18n';
import { Fonts } from '../../../shared/theme/theme';
import { Icon } from '../../../shared/ui';
import { MAX_STORY_VIDEO_MS, StoryMediaRef } from '../payload';
import { downloadStoryMedia } from '../storyMedia';
import { PHOTO_STORY_MS } from '../viewerMachine';

const ERROR_STORY_MS = 3_000;

interface Props {
  storyId: string;
  kind: 'image' | 'video';
  media: StoryMediaRef;
  paused: boolean;
  onReady: (durationMs: number) => void;
}

export function StoryMediaView({ storyId, kind, media, paused, onReady }: Props) {
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setUri(null);
    setError(null);
    downloadStoryMedia(storyId, media)
      .then((u) => alive && setUri(u))
      .catch((e) => {
        if (!alive) return;
        setError(e?.message || i18n.t('stories.loadFailed'));
        onReady(ERROR_STORY_MS);
      });
    return () => {
      alive = false;
    };
    // media is immutable per story id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId]);

  if (error) {
    return (
      <View style={styles.center}>
        <Icon name="lock" size={28} color="#D9D2C1" />
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }
  if (!uri) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#E7BD72" />
        <Text style={styles.hint}>{i18n.t('stories.decrypting')}</Text>
      </View>
    );
  }
  if (kind === 'video') return <StoryVideo uri={uri} paused={paused} onReady={onReady} />;
  return (
    <Image
      source={{ uri }}
      style={StyleSheet.absoluteFill}
      resizeMode="contain"
      onLoad={() => onReady(PHOTO_STORY_MS)}
      onError={() => {
        setError(i18n.t('stories.photoFailed'));
        onReady(ERROR_STORY_MS);
      }}
    />
  );
}

function StoryVideo({ uri, paused, onReady }: { uri: string; paused: boolean; onReady: (ms: number) => void }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });
  const reported = useRef(false);

  const report = () => {
    if (reported.current) return;
    reported.current = true;
    const ms = player.duration > 0 ? player.duration * 1000 : MAX_STORY_VIDEO_MS;
    onReady(Math.min(Math.max(ms, 1000), MAX_STORY_VIDEO_MS));
  };

  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'readyToPlay') report();
    if (status === 'error' && !reported.current) {
      reported.current = true;
      onReady(ERROR_STORY_MS);
    }
  });

  useEffect(() => {
    if (player.status === 'readyToPlay') report();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);

  useEffect(() => {
    if (paused) player.pause();
    else player.play();
  }, [paused, player]);

  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />;
}

const styles = StyleSheet.create({
  center: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  hint: { fontFamily: Fonts.medium, color: '#D9D2C1', fontSize: 13 },
  error: { fontFamily: Fonts.body, color: '#D9D2C1', fontSize: 15, textAlign: 'center' },
});
