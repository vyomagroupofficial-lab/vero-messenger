/**
 * Full-screen story viewer: progress bars, tap left/right, hold to pause,
 * swipe down to close, swipe left for the next person, auto-advance.
 * Navigation/timing lives in the pure viewerMachine; this file renders it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BorderRadius, Colors, Spacing, Typography } from '../../../shared/theme/theme';
import { currentSession } from '../../../core/session';
import { useAuthStore } from '../../auth/useAuthStore';
import { useStoriesLive, useStoryTray } from '../hooks';
import { storyAgeLabel, timeLeftLabel } from '../expiry';
import { STORY_QUICK_REACTIONS } from '../payload';
import { reactToStory, replyToStory } from '../storyReply';
import type { Story } from '../StoryRepository';
import { firstUnseenIndex } from '../tray';
import { useStoriesStore } from '../useStoriesStore';
import {
  TEXT_STORY_MS,
  ViewerAction,
  ViewerState,
  currentStoryId,
  initViewer,
  isPaused,
  progressAt,
  viewerReducer,
} from '../viewerMachine';
import { StoryMediaView } from './StoryMediaView';
import { StoryProgressBars } from './StoryProgressBars';
import { StoryRing } from './StoryRing';
import { TextStoryCanvas } from './TextStoryCanvas';
import { ViewersSheet } from './ViewersSheet';
import { confirmToggleMute } from './StoriesTray';

const TICK_MS = 50;
const HOLD_MS = 200;

export function StoryViewer({ startUserId }: { startUserId: string }) {
  const myId = useAuthStore((s) => s.user?.id);
  const loaded = useStoriesStore((s) => s.loaded);
  const stories = useStoriesStore((s) => s.stories);
  const names = useStoriesStore((s) => s.names);
  const viewCounts = useStoriesStore((s) => s.viewCounts);
  const privacy = useStoriesStore((s) => s.privacy);
  const { mine, groups } = useStoryTray();
  useStoriesLive();

  const [state, setState] = useState<ViewerState | null>(null);
  const dispatch = useCallback((a: ViewerAction) => setState((s) => (s ? viewerReducer(s, a) : s)), []);

  // Build the sequence once, after stories are loaded (tray order; muted
  // authors only play among themselves).
  useEffect(() => {
    if (!loaded) void useStoriesStore.getState().load();
  }, [loaded]);
  useEffect(() => {
    if (state || !loaded || !myId) return;
    const seen = useStoriesStore.getState().seen;
    if (startUserId === myId) {
      setState(initViewer([mine.map((s) => s.id)]));
      return;
    }
    const target = groups.find((g) => g.userId === startUserId);
    if (!target) {
      setState(initViewer([]));
      return;
    }
    const pool = groups.filter((g) => g.muted === target.muted);
    const ids = target.stories.map((s) => s.id);
    setState(
      initViewer(
        pool.map((g) => g.stories.map((s) => s.id)),
        pool.indexOf(target),
        firstUnseenIndex(ids, (id) => !!seen[id])
      )
    );
  }, [loaded, myId, startUserId, state, mine, groups]);

  const byId = useMemo(() => new Map(stories.map((s) => [s.id, s])), [stories]);
  const storyId = state ? currentStoryId(state) : null;
  const story: Story | undefined = storyId ? byId.get(storyId) : undefined;

  // Stories that disappeared (deleted by the author, expired) leave the sequence.
  useEffect(() => {
    if (!state) return;
    for (const g of state.groups) for (const id of g) if (!byId.has(id)) dispatch({ type: 'REMOVE', storyId: id });
  }, [byId, state, dispatch]);

  // Close.
  const closedOnce = useRef(false);
  useEffect(() => {
    if (!state?.closed || closedOnce.current) return;
    closedOnce.current = true;
    if (router.canGoBack()) router.back();
    else router.replace('/stories');
  }, [state?.closed]);

  // Clock.
  useEffect(() => {
    if (!state || state.closed) return;
    let last = Date.now();
    const t = setInterval(() => {
      const now = Date.now();
      dispatch({ type: 'TICK', dt: now - last });
      last = now;
    }, TICK_MS);
    return () => clearInterval(t);
  }, [state?.closed, !!state, dispatch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pause while the app is in the background.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) =>
      dispatch({ type: s === 'active' ? 'RESUME' : 'PAUSE', reason: 'background' })
    );
    return () => sub.remove();
  }, [dispatch]);

  const onReady = useCallback(
    (id: string, durationMs: number) => {
      dispatch({ type: 'READY', storyId: id, durationMs });
      const s = useStoriesStore.getState().stories.find((x) => x.id === id);
      if (s && !s.isOwn) useStoriesStore.getState().markSeen(s);
    },
    [dispatch]
  );

  // Text stories and undecryptable ones have no media to wait for.
  useEffect(() => {
    if (!story) return;
    if (!story.payload) onReady(story.id, 3000);
    else if (story.payload.kind === 'text') onReady(story.id, TEXT_STORY_MS);
  }, [story, onReady]);

  // ── Gestures ──────────────────────────────────────────────────────────────
  const { width } = useWindowDimensions();
  const widthRef = useRef(width);
  widthRef.current = width;
  const translateY = useRef(new Animated.Value(0)).current;
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 8 || Math.abs(g.dx) > 8,
        onPanResponderGrant: () => {
          held.current = false;
          holdTimer.current = setTimeout(() => {
            held.current = true;
            dispatch({ type: 'PAUSE', reason: 'hold' });
          }, HOLD_MS);
        },
        onPanResponderMove: (_, g) => {
          if (g.dy > 0) translateY.setValue(g.dy);
        },
        onPanResponderRelease: (_, g) => {
          if (holdTimer.current) clearTimeout(holdTimer.current);
          if (g.dy > 120 || (g.vy > 1.2 && g.dy > 40)) {
            dispatch({ type: 'CLOSE' });
            return;
          }
          Animated.spring(translateY, { toValue: 0, useNativeDriver: Platform.OS !== 'web' }).start();
          if (held.current) {
            dispatch({ type: 'RESUME', reason: 'hold' });
            return;
          }
          if (g.dx < -80 && Math.abs(g.dy) < 60) {
            dispatch({ type: 'NEXT_GROUP' });
            return;
          }
          if (Math.abs(g.dx) < 12 && Math.abs(g.dy) < 12) {
            dispatch({ type: g.x0 < widthRef.current / 3 ? 'PREV' : 'NEXT' });
          }
        },
        onPanResponderTerminate: () => {
          if (holdTimer.current) clearTimeout(holdTimer.current);
          Animated.spring(translateY, { toValue: 0, useNativeDriver: Platform.OS !== 'web' }).start();
          dispatch({ type: 'RESUME', reason: 'hold' });
        },
      }),
    [dispatch, translateY]
  );

  // ── Reply / reactions / own-story actions ─────────────────────────────────
  const [reply, setReply] = useState('');
  const [replyFocused, setReplyFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [viewersOpen, setViewersOpen] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(t);
  }, [toast]);

  const send = async (kind: 'reply' | 'reaction', value: string) => {
    const session = currentSession();
    if (!session || !story || sending) return;
    setSending(true);
    try {
      if (kind === 'reply') {
        await replyToStory(session, story, value);
        setReply('');
        Keyboard.dismiss();
        setToast('Reply sent');
      } else {
        await reactToStory(session, story, value);
        setToast(`Sent ${value}`);
      }
    } catch (e: any) {
      Alert.alert('Couldn’t send', e?.message ?? 'Try again.');
    } finally {
      setSending(false);
    }
  };

  const confirmDelete = () => {
    if (!story) return;
    dispatch({ type: 'PAUSE', reason: 'sheet' });
    Alert.alert('Delete this story?', 'It will disappear for everyone who can see it.', [
      { text: 'Cancel', style: 'cancel', onPress: () => dispatch({ type: 'RESUME', reason: 'sheet' }) },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await useStoriesStore.getState().deleteStory(story.id);
          } catch (e: any) {
            Alert.alert('Couldn’t delete', e?.message ?? 'Try again.');
          } finally {
            dispatch({ type: 'RESUME', reason: 'sheet' });
          }
        },
      },
    ]);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (!state || (!story && !state.closed)) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color={Colors.white} />
      </View>
    );
  }
  if (!story) return <View style={styles.root} />;

  const group = state.groups[state.group];
  const authorName = story.isOwn ? 'My story' : names[story.authorId] ?? 'Unknown';
  const paused = isPaused(state);
  const payload = story.payload;
  const muted = privacy.mutedUserIds.includes(story.authorId);
  const caption = payload && payload.kind !== 'text' ? payload.caption : undefined;

  return (
    <View style={styles.root}>
      <Animated.View
        style={[
          styles.stage,
          {
            transform: [{ translateY }],
            opacity: translateY.interpolate({ inputRange: [0, 400], outputRange: [1, 0.4], extrapolate: 'clamp' }),
          },
        ]}
        {...pan.panHandlers}
      >
        {!payload ? (
          <View style={[styles.center, styles.lockedCard]}>
            <Ionicons name="lock-closed" size={30} color={Colors.textSecondary} />
            <Text style={styles.lockedText}>{story.error ?? "This story couldn't be decrypted."}</Text>
          </View>
        ) : payload.kind === 'text' ? (
          <TextStoryCanvas text={payload.text} bg={payload.bg} font={payload.font} />
        ) : (
          <StoryMediaView
            key={story.id}
            storyId={story.id}
            kind={payload.kind}
            media={payload.media}
            paused={paused}
            onReady={(ms) => onReady(story.id, ms)}
          />
        )}
        {caption ? (
          <View style={styles.captionWrap} pointerEvents="none">
            <Text style={styles.caption}>{caption}</Text>
          </View>
        ) : null}
      </Animated.View>

      <SafeAreaView edges={['top']} style={styles.topOverlay} pointerEvents="box-none">
        <StoryProgressBars count={group.length} progress={(i) => progressAt(state, i)} />
        <View style={styles.header} pointerEvents="box-none">
          <StoryRing userId={story.authorId} name={authorName} state="none" size={36} />
          <View style={{ flex: 1 }}>
            <Text style={styles.author} numberOfLines={1}>
              {authorName}
            </Text>
            <Text style={styles.meta}>
              {storyAgeLabel(story.createdAt)}
              {story.isOwn ? ` · ${timeLeftLabel(story.expiresAt)}` : ''}
              {paused ? ' · paused' : ''}
            </Text>
          </View>
          {!story.isOwn && (
            <TouchableOpacity
              hitSlop={10}
              onPress={() => confirmToggleMute({ userId: story.authorId, displayName: authorName, muted })}
              accessibilityLabel={muted ? 'Unmute stories' : 'Mute stories'}
            >
              <Ionicons name={muted ? 'volume-mute' : 'ellipsis-horizontal'} size={22} color={Colors.white} />
            </TouchableOpacity>
          )}
          <TouchableOpacity hitSlop={10} onPress={() => dispatch({ type: 'CLOSE' })} accessibilityLabel="Close">
            <Ionicons name="close" size={26} color={Colors.white} />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {toast && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.bottomOverlay}
        pointerEvents="box-none"
      >
        <SafeAreaView edges={['bottom']} pointerEvents="box-none">
          {story.isOwn ? (
            <View style={styles.ownBar}>
              <TouchableOpacity
                style={styles.ownButton}
                onPress={() => {
                  dispatch({ type: 'PAUSE', reason: 'sheet' });
                  setViewersOpen(true);
                }}
              >
                <Ionicons name="eye-outline" size={20} color={Colors.white} />
                <Text style={styles.ownButtonText}>{viewCounts[story.id] ?? 0}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.ownButton} onPress={confirmDelete} accessibilityLabel="Delete story">
                <Ionicons name="trash-outline" size={20} color={Colors.white} />
              </TouchableOpacity>
            </View>
          ) : (
            <View>
              {replyFocused && (
                <View style={styles.reactions}>
                  {STORY_QUICK_REACTIONS.map((emoji) => (
                    <TouchableOpacity key={emoji} onPress={() => send('reaction', emoji)} disabled={sending}>
                      <Text style={styles.reaction}>{emoji}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              <View style={styles.replyBar}>
                <TextInput
                  style={styles.replyInput}
                  value={reply}
                  onChangeText={setReply}
                  placeholder={`Reply to ${authorName}…`}
                  placeholderTextColor="rgba(255,255,255,0.6)"
                  maxLength={2000}
                  onFocus={() => {
                    setReplyFocused(true);
                    dispatch({ type: 'PAUSE', reason: 'reply' });
                  }}
                  onBlur={() => {
                    setReplyFocused(false);
                    dispatch({ type: 'RESUME', reason: 'reply' });
                  }}
                  onSubmitEditing={() => reply.trim() && send('reply', reply)}
                  returnKeyType="send"
                />
                {reply.trim() ? (
                  <TouchableOpacity onPress={() => send('reply', reply)} disabled={sending} hitSlop={8}>
                    <Ionicons name="send" size={22} color={Colors.accentLight} />
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity onPress={() => send('reaction', '❤️')} disabled={sending} hitSlop={8}>
                    <Ionicons name="heart-outline" size={24} color={Colors.white} />
                  </TouchableOpacity>
                )}
              </View>
              <Text style={styles.e2eeNote}>Replies are sent as an end-to-end encrypted message</Text>
            </View>
          )}
        </SafeAreaView>
      </KeyboardAvoidingView>

      <ViewersSheet
        storyId={story.isOwn ? story.id : null}
        visible={viewersOpen}
        onClose={() => {
          setViewersOpen(false);
          dispatch({ type: 'RESUME', reason: 'sheet' });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.black },
  center: { alignItems: 'center', justifyContent: 'center' },
  stage: { flex: 1 },
  lockedCard: { flex: 1, gap: Spacing.md, padding: Spacing['2xl'], backgroundColor: Colors.surface },
  lockedText: { color: Colors.textSecondary, fontSize: Typography.base, textAlign: 'center' },
  captionWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 130,
    paddingHorizontal: Spacing.lg,
    alignItems: 'center',
  },
  caption: {
    color: Colors.white,
    fontSize: Typography.md,
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
  },
  topOverlay: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: Spacing.sm, paddingTop: Spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.sm },
  author: { color: Colors.white, fontSize: Typography.base, fontWeight: Typography.semibold },
  meta: { color: 'rgba(255,255,255,0.75)', fontSize: Typography.xs, marginTop: 1 },
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    top: '45%',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full,
  },
  toastText: { color: Colors.white, fontSize: Typography.base, fontWeight: Typography.medium },
  bottomOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  ownBar: { flexDirection: 'row', justifyContent: 'space-between', padding: Spacing.base },
  ownButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full,
  },
  ownButtonText: { color: Colors.white, fontSize: Typography.base, fontWeight: Typography.semibold },
  reactions: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
  reaction: { fontSize: 30 },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.xs,
    paddingHorizontal: Spacing.base,
    paddingVertical: Platform.OS === 'ios' ? Spacing.md : Spacing.xs,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.45)',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  replyInput: { flex: 1, color: Colors.white, fontSize: Typography.base },
  e2eeNote: { color: 'rgba(255,255,255,0.55)', fontSize: Typography.xs, textAlign: 'center', marginBottom: Spacing.sm },
});
