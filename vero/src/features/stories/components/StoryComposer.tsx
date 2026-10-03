/**
 * Story composer: text story (background + font) or photo/video (≤30 s) with
 * caption. Media is encrypted on device before upload; the audience comes
 * from the story privacy setting.
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import { BorderRadius, Colors, Spacing, Typography } from '../../../shared/theme/theme';
import { useAuthStore } from '../../auth/useAuthStore';
import { audienceSummary } from '../audience';
import { STORY_FONT_LABELS, storyFontStyle, useStoryContacts } from '../hooks';
import { MAX_STORY_CAPTION, MAX_STORY_TEXT, STORY_BACKGROUNDS, STORY_FONTS, StoryFont } from '../payload';
import { PickedStoryMedia, pickStoryMedia } from '../storyMedia';
import { useStoriesStore } from '../useStoriesStore';
import { textStoryFontSize } from './TextStoryCanvas';

type Mode = 'text' | 'media';
type Stage = 'uploading' | 'encrypting' | 'sending';

const STAGE_LABEL: Record<Stage, string> = {
  uploading: 'Encrypting & uploading media…',
  encrypting: 'Encrypting for your audience…',
  sending: 'Sharing…',
};

export function StoryComposer() {
  const userId = useAuthStore((s) => s.user?.id) ?? '';
  const isDemo = useAuthStore((s) => s.isDemo);
  const privacy = useStoriesStore((s) => s.privacy);
  const contacts = useStoryContacts();

  const [mode, setMode] = useState<Mode>('text');
  const [text, setText] = useState('');
  const [bgIndex, setBgIndex] = useState(0);
  const [font, setFont] = useState<StoryFont>('sans');
  const [media, setMedia] = useState<PickedStoryMedia | null>(null);
  const [caption, setCaption] = useState('');
  const [stage, setStage] = useState<Stage | null>(null);

  const bg = STORY_BACKGROUNDS[bgIndex % STORY_BACKGROUNDS.length];
  const canPost = !stage && (mode === 'text' ? text.trim().length > 0 : !!media);

  const pick = async (source: 'library' | 'camera') => {
    try {
      const picked = await pickStoryMedia(source);
      if (picked) setMedia(picked);
    } catch (e: any) {
      Alert.alert('Can’t use this', e?.message ?? 'Try another photo or video.');
    }
  };

  const post = async () => {
    if (!canPost) return;
    try {
      const recipients = await useStoriesStore
        .getState()
        .post(
          mode === 'text' ? { kind: 'text', text, bg, font } : { kind: 'media', media: media!, caption },
          setStage
        );
      if (recipients === 0) {
        Alert.alert('Posted', 'Your story is up, but nobody is in its audience yet. Change who can see it in story privacy.');
      }
      router.back();
    } catch (e: any) {
      setStage(null);
      Alert.alert('Couldn’t post story', e?.message ?? 'Try again.');
    }
  };

  if (isDemo) {
    return (
      <SafeAreaView style={[styles.root, styles.center]}>
        <Ionicons name="cloud-offline-outline" size={36} color={Colors.textSecondary} />
        <Text style={styles.notice}>Stories need a connected account — the offline demo has no server to share them through.</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.secondaryButton}>
          <Text style={styles.secondaryText}>Go back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} accessibilityLabel="Close">
          <Ionicons name="close" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.modeSwitch}>
          {(['text', 'media'] as Mode[]).map((m) => (
            <TouchableOpacity
              key={m}
              style={[styles.modeChip, mode === m && styles.modeChipActive]}
              onPress={() => setMode(m)}
              disabled={!!stage}
            >
              <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>{m === 'text' ? 'Text' : 'Photo / Video'}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={{ width: 26 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {mode === 'text' ? (
          <View style={[styles.canvas, { backgroundColor: bg }]}>
            <TextInput
              style={[styles.textInput, storyFontStyle(font), { fontSize: textStoryFontSize(text) }]}
              value={text}
              onChangeText={setText}
              placeholder="Type a status"
              placeholderTextColor="rgba(255,255,255,0.6)"
              multiline
              maxLength={MAX_STORY_TEXT}
              autoFocus
              textAlign="center"
            />
            <View style={styles.textTools}>
              <TouchableOpacity style={styles.tool} onPress={() => setBgIndex((i) => i + 1)} accessibilityLabel="Change background">
                <Ionicons name="color-palette-outline" size={20} color={Colors.white} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.tool}
                onPress={() => setFont(STORY_FONTS[(STORY_FONTS.indexOf(font) + 1) % STORY_FONTS.length])}
                accessibilityLabel="Change font"
              >
                <Text style={[styles.toolText, storyFontStyle(font)]}>Aa · {STORY_FONT_LABELS[font]}</Text>
              </TouchableOpacity>
              <Text style={styles.counter}>
                {text.length}/{MAX_STORY_TEXT}
              </Text>
            </View>
          </View>
        ) : (
          <View style={styles.mediaArea}>
            {media ? (
              <View style={styles.preview}>
                {media.kind === 'image' ? (
                  <Image source={{ uri: media.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
                ) : (
                  <VideoPreview uri={media.uri} />
                )}
                <TouchableOpacity style={styles.removeMedia} onPress={() => setMedia(null)} disabled={!!stage}>
                  <Ionicons name="close-circle" size={28} color={Colors.white} />
                </TouchableOpacity>
              </View>
            ) : (
              <View style={[styles.preview, styles.center, { gap: Spacing.md }]}>
                <Ionicons name="images-outline" size={40} color={Colors.textTertiary} />
                <Text style={styles.notice}>Photos, or videos up to 30 seconds. Encrypted on this device before upload.</Text>
                <View style={{ flexDirection: 'row', gap: Spacing.md }}>
                  <TouchableOpacity style={styles.secondaryButton} onPress={() => pick('library')}>
                    <Ionicons name="images" size={18} color={Colors.textPrimary} />
                    <Text style={styles.secondaryText}>Library</Text>
                  </TouchableOpacity>
                  {Platform.OS !== 'web' && (
                    <TouchableOpacity style={styles.secondaryButton} onPress={() => pick('camera')}>
                      <Ionicons name="camera" size={18} color={Colors.textPrimary} />
                      <Text style={styles.secondaryText}>Camera</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}
            <TextInput
              style={styles.captionInput}
              value={caption}
              onChangeText={setCaption}
              placeholder="Add a caption…"
              placeholderTextColor={Colors.textTertiary}
              maxLength={MAX_STORY_CAPTION}
              editable={!stage}
            />
          </View>
        )}

        <View style={styles.footer}>
          <TouchableOpacity style={styles.audience} onPress={() => router.push('/stories/privacy')} disabled={!!stage}>
            <Ionicons name="lock-closed" size={14} color={Colors.emerald} />
            <Text style={styles.audienceText} numberOfLines={1}>
              {audienceSummary(
                contacts.map((c) => c.id),
                privacy,
                userId
              )}
            </Text>
            <Ionicons name="chevron-forward" size={14} color={Colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.postButton, !canPost && styles.postDisabled]} onPress={post} disabled={!canPost}>
            {stage ? <ActivityIndicator color={Colors.white} /> : <Ionicons name="send" size={20} color={Colors.white} />}
          </TouchableOpacity>
        </View>
        {stage && <Text style={styles.stage}>{STAGE_LABEL[stage]}</Text>}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function VideoPreview({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  center: { alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  notice: { color: Colors.textSecondary, fontSize: Typography.sm, textAlign: 'center', marginVertical: Spacing.md },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
  },
  modeSwitch: { flexDirection: 'row', backgroundColor: Colors.surfaceElevated, borderRadius: BorderRadius.full, padding: 3 },
  modeChip: { paddingHorizontal: Spacing.base, paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.full },
  modeChipActive: { backgroundColor: Colors.accentSubtle, borderWidth: 1, borderColor: Colors.borderAccent },
  modeText: { color: Colors.textSecondary, fontSize: Typography.sm, fontWeight: Typography.medium },
  modeTextActive: { color: Colors.accentLight },
  canvas: { flex: 1, margin: Spacing.sm, borderRadius: BorderRadius.xl, justifyContent: 'center', padding: Spacing.xl },
  textInput: { color: Colors.white, textAlign: 'center', minHeight: 120 },
  textTools: { position: 'absolute', top: Spacing.md, left: Spacing.md, right: Spacing.md, flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  tool: {
    backgroundColor: 'rgba(0,0,0,0.25)',
    borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2,
  },
  toolText: { color: Colors.white, fontSize: Typography.sm },
  counter: { marginLeft: 'auto', color: 'rgba(255,255,255,0.7)', fontSize: Typography.xs },
  mediaArea: { flex: 1, padding: Spacing.sm, gap: Spacing.sm },
  preview: { flex: 1, borderRadius: BorderRadius.xl, backgroundColor: Colors.surface, overflow: 'hidden' },
  removeMedia: { position: 'absolute', top: Spacing.sm, right: Spacing.sm },
  captionInput: {
    color: Colors.textPrimary,
    fontSize: Typography.base,
    backgroundColor: Colors.inputBackground,
    borderWidth: 1,
    borderColor: Colors.inputBorder,
    borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
  },
  secondaryText: { color: Colors.textPrimary, fontSize: Typography.sm, fontWeight: Typography.medium },
  footer: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.base, paddingVertical: Spacing.sm },
  audience: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  audienceText: { flex: 1, color: Colors.textPrimary, fontSize: Typography.sm },
  postButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  postDisabled: { opacity: 0.4 },
  stage: { color: Colors.textSecondary, fontSize: Typography.xs, textAlign: 'center', paddingBottom: Spacing.sm },
});
