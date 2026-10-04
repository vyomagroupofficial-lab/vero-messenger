/**
 * Story composer: text story (background + font) or photo/video (≤30 s) with
 * caption. Media is encrypted on device before upload; the audience comes
 * from the story privacy setting.
 */

import React, { useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVideoPlayer, VideoView } from 'expo-video';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { Button, EmptyState, Grain, Icon, IconButton, Pressy, Segmented, useLayout } from '../../../shared/ui';
import { useAuthStore } from '../../auth/useAuthStore';
import { useStoryContacts } from '../hooks';
import { MAX_STORY_CAPTION, MAX_STORY_TEXT, STORY_FONTS, StoryFont } from '../payload';
import { PickedStoryMedia, pickStoryMedia } from '../storyMedia';
import { notify } from '../confirm';
import { useStoriesStore } from '../useStoriesStore';
import { audienceText, STORY_PALETTE } from '../storyText';
import { textStoryFontSize, useStoryFont } from './TextStoryCanvas';

type Mode = 'text' | 'media';
type Stage = 'uploading' | 'encrypting' | 'sending';

export function StoryComposer() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const userId = useAuthStore((st) => st.user?.id) ?? '';
  const isDemo = useAuthStore((st) => st.isDemo);
  const privacy = useStoriesStore((st) => st.privacy);
  const contacts = useStoryContacts();

  const [mode, setMode] = useState<Mode>('text');
  const [text, setText] = useState('');
  const [bgIndex, setBgIndex] = useState(0);
  const [font, setFont] = useState<StoryFont>('sans');
  const [media, setMedia] = useState<PickedStoryMedia | null>(null);
  const [caption, setCaption] = useState('');
  const [stage, setStage] = useState<Stage | null>(null);
  const fontStyle = useStoryFont(font);

  const bg = STORY_PALETTE[bgIndex % STORY_PALETTE.length];
  const canPost = !stage && (mode === 'text' ? text.trim().length > 0 : !!media);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/stories'));

  const pick = async (source: 'library' | 'camera') => {
    try {
      const picked = await pickStoryMedia(source);
      if (picked) setMedia(picked);
    } catch (e: any) {
      notify(t('stories.cantUse'), e?.message ?? t('stories.tryAnother'));
    }
  };

  const post = async () => {
    if (!canPost) return;
    try {
      const recipients = await useStoriesStore.getState().post(mode === 'text' ? { kind: 'text', text, bg, font } : { kind: 'media', media: media!, caption }, setStage);
      if (recipients === 0) notify(t('stories.posted'), t('stories.noAudience'));
      close();
    } catch (e: any) {
      setStage(null);
      notify(t('stories.postFailed'), e?.message ?? t('stories.tryAgain'));
    }
  };

  if (isDemo) {
    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
        <View style={s.topBar}>
          <IconButton icon="close" label={t('common.close')} onPress={close} />
        </View>
        <EmptyState icon="cloud" title={t('stories.title')} body={t('stories.demo')} action={<Button label={t('common.back')} variant="secondary" size="md" onPress={close} />} />
      </View>
    );
  }

  const fontLabel = t(`stories.font_${font}`);

  return (
    <View style={[s.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={s.topBar}>
        <IconButton icon="close" label={t('common.close')} onPress={close} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Segmented
            label={t('stories.new')}
            value={mode}
            onChange={(m) => !stage && setMode(m)}
            options={[
              { value: 'text', label: t('stories.text') },
              { value: 'media', label: t('stories.photoVideo') },
            ]}
          />
        </View>
        <View style={{ width: 44 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[s.stageWrap, isWide && s.stageWrapWide]}>
          {mode === 'text' ? (
            <Animated.View key="text" entering={ZoomIn.springify().damping(18)} style={[s.canvas, { backgroundColor: bg }, isWide && s.canvasWide]}>
              <Grain tone="light" opacity={0.09} />
              <TextInput
                style={[s.textInput, fontStyle, { fontSize: textStoryFontSize(text), lineHeight: textStoryFontSize(text) * 1.25 }]}
                value={text}
                onChangeText={setText}
                placeholder={t('stories.typeStatus')}
                placeholderTextColor="rgba(255,255,255,0.6)"
                multiline
                maxLength={MAX_STORY_TEXT}
                autoFocus
                textAlign="center"
              />
              <View style={s.textTools}>
                <View style={s.swatches}>
                  {STORY_PALETTE.map((hex, i) => (
                    <Pressy key={hex} onPress={() => setBgIndex(i)} scaleTo={0.85} style={[s.swatch, { backgroundColor: hex }, i === bgIndex % STORY_PALETTE.length && s.swatchOn]} accessibilityLabel={t('stories.background', { n: i + 1 })} />
                  ))}
                </View>
                <Pressy onPress={() => setFont(STORY_FONTS[(STORY_FONTS.indexOf(font) + 1) % STORY_FONTS.length])} scaleTo={0.94} style={s.tool} accessibilityLabel={t('stories.changeFont')}>
                  <Text style={[s.toolText, fontStyle]}>Aa · {fontLabel}</Text>
                </Pressy>
              </View>
              <Text style={s.counter}>{`${text.length}/${MAX_STORY_TEXT}`}</Text>
            </Animated.View>
          ) : (
            <Animated.View key="media" entering={FadeIn} style={[s.mediaArea, isWide && s.canvasWide]}>
              {media ? (
                <View style={s.preview}>
                  {media.kind === 'image' ? <Image source={{ uri: media.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" /> : <VideoPreview uri={media.uri} />}
                  <View style={s.removeMedia}>
                    <IconButton icon="close" label={t('channels.removePhoto')} variant="glass" color="#EDE7D9" disabled={!!stage} onPress={() => setMedia(null)} />
                  </View>
                </View>
              ) : (
                <View style={[s.preview, s.center]}>
                  <View style={s.pickIcon}>
                    <Icon name="image" size={30} color="#E7BD72" />
                  </View>
                  <Text style={[type.body, { color: c.onStageMuted, textAlign: 'center', maxWidth: 300 }]}>{t('stories.mediaHint')}</Text>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <Button label={t('stories.library')} icon="image" size="md" onPress={() => pick('library')} />
                    {Platform.OS !== 'web' && <Button label={t('thread.camera')} icon="camera" size="md" variant="secondary" onPress={() => pick('camera')} />}
                  </View>
                </View>
              )}
              <TextInput
                style={s.captionInput}
                value={caption}
                onChangeText={setCaption}
                placeholder={t('stories.caption')}
                placeholderTextColor={c.placeholder}
                maxLength={MAX_STORY_CAPTION}
                editable={!stage}
              />
            </Animated.View>
          )}
        </View>

        <View style={[s.footer, isWide && { width: '100%', maxWidth: 520, alignSelf: 'center' }]}>
          <Pressy style={s.audience} onPress={() => router.push('/stories/privacy')} disabled={!!stage} hoverStyle={{ borderColor: c.accentLine }} accessibilityLabel={t('stories.privacy')}>
            <Icon name="lock" size={14} color={c.success} />
            <Text style={s.audienceText} numberOfLines={1}>
              {audienceText(
                t,
                contacts.map((ct) => ct.id),
                privacy,
                userId
              )}
            </Text>
            <Icon name="forwardChevron" size={15} color={c.faint} />
          </Pressy>
          <Pressy style={[s.postButton, !canPost && { opacity: 0.4 }]} onPress={post} disabled={!canPost} scaleTo={0.9} accessibilityLabel={t('stories.share')}>
            {stage ? <ActivityIndicator color={c.onAccent} /> : <Icon name="send" size={20} color={c.onAccent} />}
          </Pressy>
        </View>
        {stage && (
          <Animated.Text entering={FadeIn} style={[type.caption, { textAlign: 'center', paddingBottom: 8 }]}>
            {t(`stories.stage_${stage}`)}
          </Animated.Text>
        )}
      </KeyboardAvoidingView>
    </View>
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

const useStyles = makeStyles((c, t, f) => ({
  root: { flex: 1, backgroundColor: c.bg },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8 },
  stageWrap: { flex: 1, padding: 10 },
  stageWrapWide: { alignItems: 'center', paddingVertical: 16 },
  canvas: { flex: 1, borderRadius: 28, justifyContent: 'center', padding: 24, overflow: 'hidden' },
  canvasWide: { width: '100%', maxWidth: 440, aspectRatio: 9 / 16, flex: undefined, maxHeight: '100%' },
  textInput: { color: '#FFFFFF', textAlign: 'center', minHeight: 120, outlineStyle: 'none' } as any,
  textTools: { position: 'absolute', top: 14, left: 14, right: 14, gap: 10 },
  swatches: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)' },
  swatchOn: { borderColor: '#FFFFFF', transform: [{ scale: 1.12 }] },
  tool: { alignSelf: 'flex-start', backgroundColor: 'rgba(0,0,0,0.28)', borderRadius: 16, paddingHorizontal: 12, height: 32, justifyContent: 'center' },
  toolText: { color: '#FFFFFF', fontSize: 13 },
  counter: { position: 'absolute', bottom: 14, right: 16, fontFamily: f.mono, fontSize: 11, color: 'rgba(255,255,255,0.7)' },
  mediaArea: { flex: 1, gap: 10 },
  preview: { flex: 1, borderRadius: 28, backgroundColor: c.stage, overflow: 'hidden' },
  pickIcon: { width: 72, height: 72, borderRadius: 24, backgroundColor: 'rgba(237,231,217,0.08)', borderWidth: 1, borderColor: 'rgba(237,231,217,0.12)', alignItems: 'center', justifyContent: 'center' },
  removeMedia: { position: 'absolute', top: 10, right: 10 },
  captionInput: { fontFamily: f.body, fontSize: 15, color: c.text, backgroundColor: c.field, borderWidth: 1, borderColor: c.line2, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 13, outlineStyle: 'none' } as any,
  footer: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  audience: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 48, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line, borderRadius: 24, paddingHorizontal: 16 },
  audienceText: { flex: 1, fontFamily: f.medium, fontSize: 13.5, color: c.text },
  postButton: { width: 52, height: 52, borderRadius: 26, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
}));
