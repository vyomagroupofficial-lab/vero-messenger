import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, ZoomIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
import dayjs from 'dayjs';
import { useAuthStore } from '../auth/useAuthStore';
import { useMessagesStore } from '../messages/useMessagesStore';
import { messageRepository } from '../messages/MessageRepository';
import { conversationRepository } from './ConversationRepository';
import { mediaRepository, MediaTooLargeError, PickedMedia } from '../media/MediaRepository';
import { callService } from '../calls/CallService';
import { friendlyError } from '../../core/network/supabase';
import { ConversationMember, MediaAttachment, Message, MessageStatus, conversationTitle } from '../../shared/models/Message';
import { DISAPPEARING_OPTIONS, MAX_TEXT_LENGTH } from '../../shared/models/payload';
import { makeStyles, useTheme } from '../../shared/theme/ThemeProvider';
import { useT } from '../../shared/i18n';
import { useGroupChatSync } from '../groups/useGroupChatSync';
import { groupRepository } from '../groups/GroupRepository';
import { AdminsOnlyNotice } from '../groups/components/GroupComponents';
import * as Extras from '../stickers/components/chatIntegration';
import { clockTime, dayLabel, formatBytes, timerText, typeLabel } from '../../shared/i18n/format';
import { Avatar, Chip, DotWall, Icon, IconButton, IconName, Pressy, Sheet, SheetRow, TypingDots, Waveform, confirmAction, notify, useLayout } from '../../shared/ui';

const REACTIONS = ['❤️', '😂', '👍', '🔥', '😮', '🙏'];
const TYPING_SEND_INTERVAL_MS = 3000;
const TYPING_IDLE_MS = 4000;
const NAME_TONES_DARK = ['#E7BD72', '#86C09F', '#C9A3D9', '#9DBBD6', '#E5A08A'];
const NAME_TONES_LIGHT = ['#8A5F1E', '#2F7350', '#7A4F8C', '#3F5A73', '#A0482E'];

type Row =
  | { kind: 'day'; id: string; label: string }
  | { kind: 'msg'; id: string; message: Message; firstOfRun: boolean; lastOfRun: boolean };

// ── Encrypted media: download + decrypt on demand, cached on device ─────────

function useDecryptedMedia(media: MediaAttachment | undefined, autoLoad: boolean) {
  const [uri, setUri] = useState<string | null>(media?.localUri ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!media) return null;
    setLoading(true);
    setError(null);
    try {
      const file = await mediaRepository.getDecryptedFile(media);
      setUri(file);
      return file;
    } catch (e) {
      setError(friendlyError(e, 'Could not load media'));
      return null;
    } finally {
      setLoading(false);
    }
  }, [media]);

  useEffect(() => {
    if (autoLoad && media && !uri) void load();
  }, [autoLoad, media, uri, load]);

  return { uri, loading, error, load };
}

// ── Bubble ──────────────────────────────────────────────────────────────────

function StatusTicks({ status }: { status: MessageStatus }) {
  const { c } = useTheme();
  switch (status) {
    case 'sending':
      return <Icon name="clock" size={13} color={c.mineMeta} />;
    case 'sent':
      return <Icon name="check" size={14} color={c.mineMeta} />;
    case 'delivered':
      return <Icon name="checks" size={15} color={c.mineMeta} />;
    case 'read':
      return <Icon name="checks" size={15} color="#86C09F" />;
    case 'failed':
      return <Icon name="info" size={14} color={c.danger} />;
    default:
      return null;
  }
}

interface BubbleProps {
  message: Message;
  status: MessageStatus;
  isGroup: boolean;
  firstOfRun: boolean;
  lastOfRun: boolean;
  animate: boolean;
  wide: boolean;
  onLongPress: (m: Message) => void;
  onRetry: (m: Message) => void;
}

const Bubble = React.memo(function Bubble({ message, status, isGroup, firstOfRun, lastOfRun, animate, wide, onLongPress, onRetry }: BubbleProps) {
  const { c, isDark, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const { isOwn, content, messageType, createdAt, senderName, media, reactions } = message;
  const isImage = messageType === 'image';
  const isMedia = isImage || messageType === 'video';
  const { uri, loading, error, load } = useDecryptedMedia(media, isImage);

  if (Extras.isExtensionMessageType(messageType)) {
    return <Extras.ExtensionMessage message={message} status={status} showSenderName={isGroup && firstOfRun} onLongPress={onLongPress} onRetry={onRetry} />;
  }

  if (messageType === 'system') {
    return (
      <View style={s.systemRow}>
        <Text style={s.systemText}>{content}</Text>
      </View>
    );
  }

  const openMedia = async () => {
    const file = uri ?? (await load());
    if (!file) return;
    if (messageType === 'document') {
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file, { mimeType: media?.mimeType, dialogTitle: media?.fileName });
      } else {
        notify(t('thread.savedTitle'), t('thread.savedBody'));
      }
      return;
    }
    router.push({
      pathname: '/media-viewer',
      params: { uri: file, type: messageType, caption: content ?? '', name: isOwn ? t('common.you') : senderName ?? '', date: dayjs(createdAt).format('ddd D MMM, h:mm A') },
    });
  };

  const tones = isDark ? NAME_TONES_DARK : NAME_TONES_LIGHT;
  const name = senderName || t('common.someone');
  const nameTone = tones[Math.abs(name.charCodeAt(0) + name.length) % tones.length];
  const fg = isOwn ? c.onMine : c.text;
  const meta = isOwn ? c.mineMeta : c.faint;

  const reactionCounts = (reactions || []).reduce<Record<string, number>>((acc, r) => {
    acc[r.emoji] = (acc[r.emoji] || 0) + 1;
    return acc;
  }, {});
  const reactionEntries = Object.entries(reactionCounts);
  const mediaW = wide ? 340 : 260;
  const mediaH = wide ? 230 : 172;

  return (
    <Animated.View
      entering={animate ? FadeInDown.springify().damping(17).stiffness(190) : undefined}
      style={[s.row, isOwn ? s.rowOwn : s.rowOther, { marginTop: firstOfRun ? 8 : 2 }]}
    >
      <Pressable
        onLongPress={() => onLongPress(message)}
        onPress={status === 'failed' ? () => onRetry(message) : undefined}
        delayLongPress={280}
        accessibilityHint={t('thread.longPressHint')}
        style={[
          s.bubble,
          isOwn ? s.bubbleOwn : s.bubbleOther,
          isOwn && lastOfRun && { borderBottomRightRadius: 6 },
          !isOwn && lastOfRun && { borderBottomLeftRadius: 6 },
          isMedia && s.bubbleMedia,
          { maxWidth: wide ? 560 : '82%' },
        ]}
      >
        {!isOwn && isGroup && firstOfRun && (
          <Text style={[s.sender, { color: nameTone }, isMedia && { paddingHorizontal: 8, paddingTop: 4 }]}>{name}</Text>
        )}

        {message.replyPreview ? (
          <View style={[s.quote, isOwn && { backgroundColor: 'rgba(0,0,0,0.22)' }]}>
            <Text style={[s.quoteText, { color: isOwn ? 'rgba(244,238,225,0.8)' : c.muted }]} numberOfLines={2}>
              {message.replyPreview}
            </Text>
          </View>
        ) : null}

        {messageType === 'unavailable' && (
          <View style={s.unavailable}>
            <Icon name="lock" size={14} color={meta} />
            <Text style={[type.body, { color: meta, fontStyle: 'italic', flexShrink: 1 }]}>{content || t('preview.unavailable')}</Text>
          </View>
        )}

        {isMedia && (
          <Pressable onPress={openMedia} accessibilityLabel={isImage ? t('thread.openPhoto') : t('thread.playVideo')}>
            {isImage && uri ? (
              <Image source={{ uri }} style={[s.photo, { width: mediaW, height: mediaH }]} resizeMode="cover" />
            ) : (
              <View style={[s.photo, s.mediaHolder, { width: mediaW, height: mediaH }]}>
                {loading ? (
                  <ActivityIndicator color={c.accent} />
                ) : isImage ? (
                  <Icon name={error ? 'info' : 'image'} size={28} color={error ? c.danger : c.faint} />
                ) : (
                  <View style={s.videoPlay}>
                    <Icon name="play" size={22} color="#0C0E0D" style={{ marginLeft: 3 }} />
                  </View>
                )}
                <Text style={[type.caption, { color: error ? c.danger : c.muted }]}>
                  {error ? t('thread.tapRetry') : isImage ? t('thread.photoLoading') : t('thread.videoSize', { size: formatBytes(media?.size || 0) })}
                </Text>
              </View>
            )}
          </Pressable>
        )}

        {messageType === 'voice' && (
          <View style={s.voice} accessibilityLabel={t('thread.voiceNote')}>
            <View style={[s.voiceIcon, { backgroundColor: isOwn ? c.onMine : c.accent }]}>
              <Icon name="mic" size={16} color={isOwn ? c.mine : c.onAccent} />
            </View>
            <Waveform progress={0} rest={isOwn ? 'rgba(244,238,225,0.5)' : c.line3} />
            <Text style={[s.voiceLen, { color: meta }]}>
              {media?.durationMs ? `${Math.floor(media.durationMs / 60000)}:${String(Math.round((media.durationMs % 60000) / 1000)).padStart(2, '0')}` : ''}
            </Text>
          </View>
        )}

        {messageType === 'document' && (
          <Pressable onPress={openMedia} style={s.doc} accessibilityLabel={t('thread.openDocument')}>
            <View style={s.docIcon}>{loading ? <ActivityIndicator color={c.accent} /> : <Icon name="file" size={21} color={c.accentText} />}</View>
            <View style={{ flexShrink: 1 }}>
              <Text style={[s.docName, { color: fg }]} numberOfLines={2}>
                {media?.fileName || content || t('preview.document')}
              </Text>
              <Text style={[s.docMeta, { color: meta }]}>{error ? error : t('thread.docMeta', { size: formatBytes(media?.size || 0) })}</Text>
            </View>
          </Pressable>
        )}

        <View style={[s.textRow, isMedia && { paddingHorizontal: 8 }]}>
          {(messageType === 'text' || (isMedia && !!content)) && <Text style={[s.text, { color: fg }]}>{content}</Text>}
          <View style={s.meta}>
            {message.expiresAt ? <Icon name="timer" size={11} color={meta} /> : null}
            {status === 'failed' && <Text style={[s.metaText, { color: c.danger }]}>{t('thread.notSent')}</Text>}
            <Text style={[s.metaText, { color: meta }]}>{clockTime(createdAt)}</Text>
            {isOwn && <StatusTicks status={status} />}
          </View>
        </View>
      </Pressable>

      {reactionEntries.length > 0 && (
        <Animated.View entering={ZoomIn.springify()} style={[s.reactions, isOwn ? { marginRight: 10 } : { marginLeft: 10 }]}>
          {reactionEntries.map(([emoji, count]) => (
            <Text key={emoji} style={s.reactionText}>
              {emoji}
              {count > 1 ? <Text style={s.reactionCount}> {count}</Text> : null}
            </Text>
          ))}
        </Animated.View>
      )}
    </Animated.View>
  );
});

// ── Thread ──────────────────────────────────────────────────────────────────

export function ChatThread({ conversationId, embedded = false }: { conversationId: string; embedded?: boolean }) {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { c, type, f } = useTheme();
  const s = useStyles();
  const t = useT();
  const user = useAuthStore((st) => st.user);
  const isDemo = useAuthStore((st) => st.isDemo);

  const chat = useMessagesStore((st) => st.chats[conversationId]);
  const { open, close, loadOlder, send, retry, react, deleteMessage, setTimer, clearLocalHistory, sendTyping } = useMessagesStore.getState();

  const [inputText, setInputText] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [uploading, setUploading] = useState(false);
  const [actionMessage, setActionMessage] = useState<Message | null>(null);
  const [retryMessage, setRetryMessage] = useState<Message | null>(null);
  const [showAttach, setShowAttach] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [, forceTick] = useState(0);

  const lastTypingSent = useRef(0);
  const typingIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!conversationId || !user) return;
    open(conversationId).catch((e) => notify(t('thread.openFailed'), friendlyError(e)));
    return () => {
      if (typingIdle.current) clearTimeout(typingIdle.current);
      close(conversationId);
    };
  }, [conversationId, user?.id]);

  const conversation = chat?.conversation ?? null;
  const messages = chat?.messages ?? [];
  const members: ConversationMember[] = conversation?.members ?? [];
  const isGroup = conversation?.conversationType === 'group';
  const otherUser = conversation?.otherUser;
  const title = conversation ? conversationTitle(conversation) : t('thread.loading');
  const groupChat = useGroupChatSync(conversationId, isGroup && !isDemo);

  // Typing users (expire automatically)
  const now = Date.now();
  const typingNames = Object.entries(chat?.typing ?? {})
    .filter(([, exp]) => exp > now)
    .map(([uid]) => members.find((m) => m.id === uid)?.displayName || t('common.someone'));
  useEffect(() => {
    const expiries = Object.values(chat?.typing ?? {}).filter((e) => e > Date.now());
    if (!expiries.length) return;
    const tm = setTimeout(() => forceTick((n) => n + 1), Math.min(...expiries) - Date.now() + 50);
    return () => clearTimeout(tm);
  }, [chat?.typing]);

  const statusOf = useCallback((m: Message) => (user ? messageRepository.statusFor(m, members, user.id) : m.status), [members, user]);

  // Newest first for an inverted list, with day breaks and sender runs.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    messages.forEach((m, i) => {
      const prev = messages[i - 1];
      const next = messages[i + 1];
      if (!prev || !dayjs(prev.createdAt).isSame(m.createdAt, 'day')) {
        out.push({ kind: 'day', id: `day-${m.id}`, label: dayLabel(t, m.createdAt) });
      }
      const near = (a: Message, b: Message) => a.senderUserId === b.senderUserId && Math.abs(dayjs(a.createdAt).diff(b.createdAt, 'minute')) < 5 && a.messageType !== 'system' && b.messageType !== 'system';
      out.push({ kind: 'msg', id: m.id, message: m, firstOfRun: !prev || !near(prev, m), lastOfRun: !next || !near(next, m) });
    });
    return out.reverse();
  }, [messages, t]);

  // ── Actions ──

  const stopTyping = () => {
    if (typingIdle.current) clearTimeout(typingIdle.current);
    typingIdle.current = null;
    if (lastTypingSent.current) {
      lastTypingSent.current = 0;
      sendTyping(conversationId, false);
    }
  };

  const handleChangeText = (text: string) => {
    setInputText(text);
    if (!text) return stopTyping();
    if (Date.now() - lastTypingSent.current > TYPING_SEND_INTERVAL_MS) {
      lastTypingSent.current = Date.now();
      sendTyping(conversationId, true);
    }
    if (typingIdle.current) clearTimeout(typingIdle.current);
    typingIdle.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || !conversationId) return;
    setInputText('');
    const reply = replyTo;
    setReplyTo(null);
    stopTyping();
    const result = await send(conversationId, { t: 'text', body: text }, { replyTo: reply });
    if (result?.status === 'failed') notify(t('thread.notSentTitle'), t('thread.notSentBody'));
  };

  const handleStartCall = async (callType: 'voice' | 'video') => {
    if (!otherUser) return;
    try {
      const callId = await callService.startCall({ conversationId, peerId: otherUser.id, peerName: otherUser.displayName, callType });
      router.push(`/call/${callId}`);
    } catch (e) {
      notify(t('thread.callFailed'), friendlyError(e));
    }
  };

  const handlePickMedia = async (source: 'camera' | 'library' | 'document') => {
    setShowAttach(false);
    if (isDemo) {
      notify(t('thread.demoAttach'), t('thread.demoAttachBody'));
      return;
    }
    let picked: PickedMedia | null = null;
    try {
      picked =
        source === 'camera' ? await mediaRepository.pickFromCamera() : source === 'library' ? await mediaRepository.pickFromLibrary() : await mediaRepository.pickDocument();
    } catch (e) {
      notify(t('thread.permission'), friendlyError(e));
      return;
    }
    if (!picked) return;

    setUploading(true);
    try {
      const media = await mediaRepository.uploadEncrypted(picked, conversationId);
      await send(conversationId, { t: 'media', kind: picked.kind, media, caption: undefined }, { mediaId: media.mediaId, localUri: picked.uri, replyTo });
      setReplyTo(null);
    } catch (e) {
      notify(e instanceof MediaTooLargeError ? t('thread.tooLarge') : t('thread.uploadFailed'), friendlyError(e, t('thread.uploadFailedBody')));
    } finally {
      setUploading(false);
    }
  };

  const handleReact = async (emoji: string) => {
    const target = actionMessage;
    setActionMessage(null);
    if (!target || !user) return;
    const mine = target.reactions?.find((r) => r.userId === user.id);
    try {
      await react(target, mine?.emoji === emoji ? null : emoji);
    } catch (e) {
      notify(t('thread.reactionFailed'), friendlyError(e));
    }
  };

  const handleCopy = async () => {
    if (actionMessage?.content) await Clipboard.setStringAsync(actionMessage.content);
    setActionMessage(null);
  };

  const handleDelete = async (target: Message | null, forEveryone: boolean) => {
    setActionMessage(null);
    setRetryMessage(null);
    if (!target) return;
    try {
      await deleteMessage(target, forEveryone);
    } catch (e) {
      notify(t('thread.deleteFailed'), friendlyError(e));
    }
  };

  const chooseTimer = (seconds: number) => {
    setTimer(conversationId, seconds).catch((e) => notify(t('thread.timerFailed'), friendlyError(e)));
  };

  const leaveGroup = () => {
    setShowMenu(false);
    if (!user) return;
    confirmAction({
      title: t('thread.leaveTitle'),
      message: t('thread.leaveBody'),
      confirmLabel: t('thread.leaveConfirm'),
      destructive: true,
      onConfirm: async () => {
        try {
          await groupRepository.leave(conversationId);
          if (router.canGoBack()) router.back();
        } catch (e) {
          notify(t('thread.leaveFailed'), friendlyError(e));
        }
      },
    });
  };

  const openVerify = () => {
    if (otherUser) router.push({ pathname: '/verify-safety-number', params: { userId: otherUser.id, displayName: otherUser.displayName } });
  };
  const openProfile = () => {
    if (otherUser) router.push(`/profile/${otherUser.id}`);
    else if (isGroup && !isDemo) router.push(`/group/${conversationId}`);
    else if (isGroup) setShowMenu(true);
  };

  const subtitle = typingNames.length
    ? typingNames.length === 1
      ? isGroup
        ? t('thread.typingOne', { name: typingNames[0].split(' ')[0] })
        : t('thread.typing')
      : t('thread.typingMany', { names: typingNames.map((n) => n.split(' ')[0]).join(', ') })
    : isGroup
    ? t('thread.members', { count: members.length })
    : t('thread.encryptedTapVerify');
  const typing = typingNames.length > 0;
  const canDeleteForEveryone = !!actionMessage?.isOwn && actionMessage.status !== 'failed' && actionMessage.status !== 'sending';
  const hasText = inputText.trim().length > 0;
  const timerSeconds = chat?.timerSeconds ?? 0;

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={[s.header, { paddingTop: embedded ? 0 : insets.top }]}>
        <View style={[s.headerInner, embedded && { height: 76, paddingLeft: 24 }]}>
          {!embedded && <IconButton icon="back" label={t('common.back')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))} />}
          <Pressy onPress={openProfile} scaleTo={0.98} style={s.headerWho} accessibilityLabel={t('thread.openProfile', { name: title })}>
            <Avatar name={title} size={embedded ? 44 : 42} square={isGroup} icon={isGroup ? 'users' : undefined} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.headerName} numberOfLines={1}>
                {title}
                <Extras.BotBadge userId={otherUser?.id} />
              </Text>
              <Animated.View key={subtitle} entering={FadeIn.duration(220)} style={s.headerStatusRow}>
                {!typing && !isGroup && <Icon name="lock" size={11} color={c.muted} />}
                <Text style={[s.headerStatus, { color: typing ? c.accentText : c.muted }]} numberOfLines={1}>
                  {subtitle}
                </Text>
              </Animated.View>
            </View>
          </Pressy>
          {isWide && (
            <View style={s.e2ePill}>
              <Icon name="lock" size={13} color={c.success} />
              <Text style={s.e2ePillText}>{t('common.encrypted')}</Text>
            </View>
          )}
          {!isGroup && otherUser && (
            <>
              <IconButton icon="video" label={t('thread.videoCall')} onPress={() => handleStartCall('video')} />
              <IconButton icon="phone" label={t('thread.voiceCall')} onPress={() => handleStartCall('voice')} />
            </>
          )}
          <IconButton icon="more" label={t('thread.options')} onPress={() => setShowMenu(true)} />
        </View>
      </View>

      {timerSeconds > 0 && (
        <Animated.View entering={FadeInDown} exiting={FadeOut} style={s.banner}>
          <Icon name="timer" size={14} color={c.accentText} />
          <Text style={s.bannerText}>{t('thread.timerBanner', { time: timerText(t, timerSeconds) })}</Text>
        </Animated.View>
      )}
      {uploading && (
        <Animated.View entering={FadeInDown} exiting={FadeOut} style={s.banner}>
          <ActivityIndicator size="small" color={c.accent} />
          <Text style={s.bannerText}>{t('thread.uploading')}</Text>
        </Animated.View>
      )}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flex: 1 }}>
          <DotWall />
          {chat?.isLoading && messages.length === 0 ? (
            <View style={s.loading}>
              <ActivityIndicator color={c.accent} />
              <Text style={type.caption}>{t('thread.unlocking')}</Text>
            </View>
          ) : (
            <FlatList
              inverted
              data={rows}
              keyExtractor={(r) => r.id}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[s.list, isWide && s.listWide]}
              onEndReached={() => void loadOlder(conversationId)}
              onEndReachedThreshold={0.3}
              renderItem={({ item, index }) =>
                item.kind === 'day' ? (
                  <View style={s.dayWrap}>
                    <Text style={s.day}>{item.label}</Text>
                  </View>
                ) : (
                  <Bubble
                    message={item.message}
                    status={statusOf(item.message)}
                    isGroup={isGroup}
                    firstOfRun={item.firstOfRun}
                    lastOfRun={item.lastOfRun}
                    animate={index < 8}
                    wide={isWide}
                    onLongPress={setActionMessage}
                    onRetry={setRetryMessage}
                  />
                )
              }
              ListHeaderComponent={typing ? <TypingDots /> : null}
              ListFooterComponent={
                chat?.isLoadingOlder ? (
                  <ActivityIndicator color={c.accent} style={{ marginVertical: 12 }} />
                ) : !chat?.hasMore ? (
                  <Pressy onPress={otherUser ? openVerify : undefined} disabled={!otherUser} scaleTo={0.98} style={s.notice} accessibilityLabel={t('thread.verify')}>
                    <Icon name="lock" size={15} color={c.accentText} style={{ marginTop: 1 }} />
                    <Text style={s.noticeText}>
                      {isDemo ? t('thread.demoNotice') : t('thread.notice')}
                      {!isDemo && otherUser ? (
                        <Text style={{ color: c.accentText, fontFamily: f.semibold }}> {t('thread.noticeVerify')}</Text>
                      ) : null}
                    </Text>
                  </Pressy>
                ) : null
              }
            />
          )}
        </View>

        {replyTo && (
          <Animated.View entering={FadeInDown.springify().damping(18)} style={s.replyBar}>
            <View style={s.replyAccent} />
            <View style={{ flex: 1 }}>
              <Text style={s.replyWho}>{replyTo.isOwn ? t('thread.replyingToYou') : t('thread.replyingTo', { name: replyTo.senderName || title })}</Text>
              <Text style={s.replyText} numberOfLines={1}>
                {typeLabel(t, replyTo.messageType, replyTo.content).text}
              </Text>
            </View>
            <IconButton icon="close" label={t('thread.cancelReply')} size={36} onPress={() => setReplyTo(null)} />
          </Animated.View>
        )}

        <Extras.BotCommandSuggestions botUserId={otherUser?.id} text={inputText} onPick={setInputText} />
        {!groupChat.canSend && (
          <View style={{ paddingBottom: embedded ? 18 : Math.max(insets.bottom, 12) }}>
            <AdminsOnlyNotice text={t('thread.adminsOnly')} />
          </View>
        )}

        {/* Composer */}
        {groupChat.canSend && (
        <View style={[s.composer, { paddingBottom: embedded ? 18 : Math.max(insets.bottom, 12) }, isWide && s.composerWide]}>
          <IconButton icon="plus" label={t('thread.attach')} variant="filled" size={46} disabled={uploading} onPress={() => setShowAttach(true)} />
          <Extras.ChatComposerExtras conversation={conversation} replyTo={replyTo} onSent={() => setReplyTo(null)} disabled={uploading} />
          <View style={s.field}>
            <TextInput
              ref={inputRef}
              style={s.input}
              placeholder={t('thread.placeholder')}
              placeholderTextColor={c.faint}
              selectionColor={c.accent}
              value={inputText}
              onChangeText={handleChangeText}
              multiline
              {...(Platform.OS === 'web' ? { numberOfLines: 1 } : {})}
              maxLength={MAX_TEXT_LENGTH}
              accessibilityLabel={t('thread.placeholder')}
              onKeyPress={(e: any) => {
                if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
                  e.preventDefault?.();
                  void handleSend();
                }
              }}
            />
            {!hasText && <IconButton icon="camera" label={t('thread.camera')} size={38} color={c.muted} onPress={() => handlePickMedia('camera')} />}
          </View>
          <Animated.View key={hasText ? 'on' : 'off'} entering={ZoomIn.springify().damping(13)}>
            <IconButton icon="send" label={t('thread.send')} variant={hasText ? 'brass' : 'filled'} size={46} disabled={!hasText} onPress={handleSend} />
          </Animated.View>
        </View>
        )}
      </KeyboardAvoidingView>

      {/* Attach */}
      <Sheet visible={showAttach} onClose={() => setShowAttach(false)} title={t('thread.share')}>
        <View style={s.attachGrid}>
          {(
            [
              ['camera', t('thread.camera'), 'camera', '#1F4E40'],
              ['library', t('thread.photos'), 'image', '#3F5A73'],
              ['document', t('thread.document'), 'file', '#7A5A2E'],
            ] as ['camera' | 'library' | 'document', string, IconName, string][]
          ).map(([key, label, icon, bg], i) => (
            <Animated.View key={key} entering={ZoomIn.delay(i * 50).springify().damping(14)} style={{ flex: 1 }}>
              <Pressy onPress={() => handlePickMedia(key)} style={s.attachItem} accessibilityLabel={label}>
                <View style={[s.attachIcon, { backgroundColor: bg }]}>
                  <Icon name={icon} size={24} color="#EDE7D9" />
                </View>
                <Text style={[type.label, { textAlign: 'center' }]}>{label}</Text>
              </Pressy>
            </Animated.View>
          ))}
        </View>
        <View style={s.sheetNote}>
          <Icon name="lock" size={13} color={c.success} />
          <Text style={[type.caption, { flexShrink: 1 }]}>{t('thread.filesEncrypted')}</Text>
        </View>
      </Sheet>

      {/* Message actions */}
      <Sheet visible={!!actionMessage} onClose={() => setActionMessage(null)}>
        {actionMessage?.messageType !== 'unavailable' && actionMessage?.status !== 'failed' && (
          <View style={s.reactRow}>
            {REACTIONS.map((e, i) => (
              <Animated.View key={e} entering={ZoomIn.delay(i * 35).springify().damping(12)}>
                <Pressy onPress={() => handleReact(e)} scaleTo={0.8} style={s.reactBtn} accessibilityLabel={t('thread.react', { emoji: e })}>
                  <Text style={{ fontSize: 24 }}>{e}</Text>
                </Pressy>
              </Animated.View>
            ))}
          </View>
        )}
        <SheetRow
          icon="reply"
          label={t('thread.reply')}
          onPress={() => {
            setReplyTo(actionMessage);
            setActionMessage(null);
            setTimeout(() => inputRef.current?.focus(), 150);
          }}
        />
        {!!actionMessage?.content && actionMessage.messageType === 'text' && <SheetRow icon="copy" label={t('thread.copy')} onPress={handleCopy} />}
        <SheetRow icon="trash" label={t('thread.deleteForMe')} tone="ember" onPress={() => handleDelete(actionMessage, false)} />
        {canDeleteForEveryone && <SheetRow icon="trash" label={t('thread.deleteForEveryone')} tone="ember" onPress={() => handleDelete(actionMessage, true)} />}
      </Sheet>

      {/* Retry a failed message */}
      <Sheet visible={!!retryMessage} onClose={() => setRetryMessage(null)} title={t('thread.retryTitle')}>
        <SheetRow
          icon="send"
          label={t('common.retry')}
          tone="brass"
          onPress={() => {
            const m = retryMessage;
            setRetryMessage(null);
            if (m) void retry(m);
          }}
        />
        <SheetRow icon="trash" label={t('common.delete')} tone="ember" onPress={() => handleDelete(retryMessage, false)} />
      </Sheet>

      {/* Chat options */}
      <Sheet visible={showMenu} onClose={() => setShowMenu(false)} title={title}>
        {isGroup && !isDemo && (
          <SheetRow
            icon="info"
            tone="brass"
            label={t('thread.groupSettings')}
            onPress={() => {
              setShowMenu(false);
              router.push(`/group/${conversationId}`);
            }}
          />
        )}
        {isGroup && (
          <View style={{ gap: 2 }}>
            <Text style={type.eyebrow}>{t('thread.groupInfo')}</Text>
            {members.map((m) => (
              <View key={m.id} style={s.memberRow}>
                <Avatar name={m.displayName} size={34} />
                <Text style={[type.body, { flex: 1 }]} numberOfLines={1}>
                  {m.id === user?.id ? t('common.you') : m.displayName}
                </Text>
                {m.role !== 'member' && <Text style={type.caption}>{t(`thread.role_${m.role}`)}</Text>}
              </View>
            ))}
          </View>
        )}
        {otherUser && (
          <>
            <SheetRow
              icon="shieldCheck"
              label={t('thread.verify')}
              onPress={() => {
                setShowMenu(false);
                openVerify();
              }}
            />
            <SheetRow
              icon="user"
              label={t('thread.viewProfile')}
              onPress={() => {
                setShowMenu(false);
                openProfile();
              }}
            />
          </>
        )}
        <View style={{ gap: 10, paddingHorizontal: 6, paddingTop: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Icon name="timer" size={17} color={c.accentText} />
            <Text style={[type.label, { color: c.text }]}>{t('thread.disappearing')}</Text>
          </View>
          <Text style={type.caption}>{t('thread.disappearingHint')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {DISAPPEARING_OPTIONS.map((o) => (
              <Chip key={o.seconds} label={timerText(t, o.seconds)} active={timerSeconds === o.seconds} onPress={() => chooseTimer(o.seconds)} />
            ))}
          </View>
        </View>
        <SheetRow
          icon="trash"
          label={t('thread.clear')}
          tone="ember"
          onPress={() => {
            setShowMenu(false);
            confirmAction({
              title: t('thread.clearTitle'),
              message: t('thread.clearBody'),
              confirmLabel: t('thread.clearConfirm'),
              destructive: true,
              onConfirm: () => void clearLocalHistory(conversationId),
            });
          }}
        />
        {isGroup && !isDemo && <SheetRow icon="logout" label={t('thread.leave')} tone="ember" onPress={leaveGroup} />}
      </Sheet>
    </View>
  );
}

export function NoChatSelected() {
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  return (
    <View style={{ flex: 1 }}>
      <DotWall />
      <Animated.View entering={FadeIn.duration(500)} style={s.noChat}>
        <View style={s.noChatIcon}>
          <Icon name="chat" size={34} color={c.accentText} />
        </View>
        <Text style={[type.h2, { textAlign: 'center' }]}>{t('thread.pickChat')}</Text>
        <Text style={[type.bodyMuted, { textAlign: 'center', maxWidth: 360 }]}>{t('thread.pickChatBody')}</Text>
      </Animated.View>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  container: { flex: 1, backgroundColor: c.bg },
  header: { backgroundColor: c.bg, borderBottomWidth: 1, borderBottomColor: c.line, zIndex: 2 },
  headerInner: { height: 68, flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 8 },
  headerWho: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingRight: 8 },
  headerName: { fontFamily: f.semibold, fontSize: 16, color: c.text },
  headerStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  headerStatus: { fontFamily: f.body, fontSize: 12.5 },
  e2ePill: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: c.successTint, marginRight: 6 },
  e2ePillText: { fontFamily: f.medium, fontSize: 12, color: c.success },
  banner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 16, backgroundColor: c.accentTint, borderBottomWidth: 1, borderBottomColor: c.accentTint2 },
  bannerText: { fontFamily: f.medium, fontSize: 12.5, color: c.notice, flexShrink: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  list: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 },
  listWide: { paddingHorizontal: 32, maxWidth: 940, width: '100%', alignSelf: 'center' },
  dayWrap: { alignItems: 'center', marginVertical: 12 },
  day: { fontFamily: f.medium, fontSize: 12, color: c.muted, backgroundColor: c.raised, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, overflow: 'hidden', borderWidth: 1, borderColor: c.line },
  systemRow: { alignItems: 'center', marginVertical: 8, paddingHorizontal: 24 },
  systemText: { fontFamily: f.medium, fontSize: 12.5, color: c.muted, textAlign: 'center', backgroundColor: c.raised, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, overflow: 'hidden' },
  notice: { alignSelf: 'center', maxWidth: 440, flexDirection: 'row', gap: 9, marginTop: 10, marginBottom: 6, paddingVertical: 11, paddingHorizontal: 14, borderRadius: 16, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2 },
  noticeText: { flex: 1, fontFamily: f.body, fontSize: 12.5, lineHeight: f.script === 'latin' ? 18 : 21, color: c.notice },
  row: { flexDirection: 'column' },
  rowOwn: { alignItems: 'flex-end' },
  rowOther: { alignItems: 'flex-start' },
  bubble: { paddingHorizontal: 13, paddingTop: 9, paddingBottom: 7, borderRadius: 20 },
  bubbleOwn: { backgroundColor: c.mine, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)' },
  bubbleOther: { backgroundColor: c.theirs, borderWidth: 1, borderColor: c.line },
  bubbleMedia: { padding: 4, paddingBottom: 6 },
  sender: { fontFamily: f.semibold, fontSize: 12.5, marginBottom: 3 },
  quote: { marginBottom: 6, marginHorizontal: -3, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12, backgroundColor: c.tint2, borderLeftWidth: 3, borderLeftColor: c.accent },
  quoteText: { fontFamily: f.body, fontSize: 13 },
  unavailable: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  textRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'flex-end', columnGap: 10 },
  text: { fontFamily: f.body, fontSize: 15.5, lineHeight: f.script === 'latin' ? 22 : 25, flexShrink: 1 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, marginLeft: 'auto' },
  metaText: { fontFamily: f.body, fontSize: 11 },
  photo: { borderRadius: 16, overflow: 'hidden' },
  mediaHolder: { alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: c.field },
  videoPlay: { width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(237,231,217,0.92)', alignItems: 'center', justifyContent: 'center' },
  voice: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 220, paddingVertical: 2 },
  voiceIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  voiceLen: { fontFamily: f.mono, fontSize: 12 },
  doc: { flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 220, paddingVertical: 2 },
  docIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: c.accentTint2, alignItems: 'center', justifyContent: 'center' },
  docName: { fontFamily: f.semibold, fontSize: 14 },
  docMeta: { fontFamily: f.body, fontSize: 12, marginTop: 2 },
  reactions: { marginTop: -8, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 26, paddingHorizontal: 8, borderRadius: 13, backgroundColor: c.field, borderWidth: 2, borderColor: c.wall },
  reactionText: { fontSize: 13 },
  reactionCount: { fontFamily: f.medium, fontSize: 12, color: c.text },
  replyBar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 16, paddingRight: 8, paddingVertical: 8, backgroundColor: c.panel, borderTopWidth: 1, borderTopColor: c.line },
  replyAccent: { width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: c.accent },
  replyWho: { fontFamily: f.semibold, fontSize: 12.5, color: c.accentText },
  replyText: { fontFamily: f.body, fontSize: 13.5, color: c.muted, marginTop: 1 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 10, paddingTop: 10, backgroundColor: c.bg, borderTopWidth: 1, borderTopColor: c.line },
  composerWide: { paddingHorizontal: 24, paddingTop: 14 },
  field: { flex: 1, minHeight: 46, maxHeight: 140, flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4, borderRadius: 23, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line },
  input: { flex: 1, minWidth: 0, maxHeight: 130, paddingVertical: Platform.OS === 'ios' ? 13 : 10, fontFamily: f.body, fontSize: 16, color: c.text, outlineStyle: 'none' } as any,
  attachGrid: { flexDirection: 'row', gap: 10, paddingVertical: 6 },
  attachItem: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  attachIcon: { width: 58, height: 58, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  sheetNote: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' },
  reactRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  reactBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.raised, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.line },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  noChat: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  noChatIcon: { width: 84, height: 84, borderRadius: 28, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
}));
