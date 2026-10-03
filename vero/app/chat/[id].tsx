import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Animated,
  Pressable,
  Modal,
  Alert,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import dayjs from 'dayjs';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { useMessagesStore } from '../../src/features/messages/useMessagesStore';
import { messageRepository } from '../../src/features/messages/MessageRepository';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { mediaRepository, PickedMedia } from '../../src/features/media/MediaRepository';
import { MediaAttachmentView } from '../../src/features/media/components/MediaAttachmentView';
import { VoiceNotePlayer } from '../../src/features/media/components/VoiceNotePlayer';
import { VoiceRecordButton, VoiceRecordingBar } from '../../src/features/media/components/VoiceRecorderControls';
import { markVoicePlayed, useMediaSender, voiceRecordingToMedia } from '../../src/features/media/sendMedia';
import { useVoiceRecorder } from '../../src/features/media/useVoiceRecorder';
import { callService } from '../../src/features/calls/CallService';
import { friendlyError } from '../../src/core/network/supabase';
import {
  ConversationMember,
  Message,
  MessageStatus,
  conversationTitle,
  messagePreview,
} from '../../src/shared/models/Message';
import { DISAPPEARING_OPTIONS, MAX_TEXT_LENGTH, timerLabel } from '../../src/shared/models/payload';
import { Colors, Typography, Spacing, BorderRadius } from '../../src/shared/theme/theme';
import { useGroupChatSync } from '../../src/features/groups/useGroupChatSync';
import { groupRepository } from '../../src/features/groups/GroupRepository';
import { AdminsOnlyNotice } from '../../src/features/groups/components/GroupComponents';
import { useChatMessaging } from '../../src/features/messages/useChatMessaging';
import { ForwardSheet } from '../../src/features/messages/components/ForwardSheet';
import { EditBanner, EditHistorySheet, SelectionBar } from '../../src/features/messages/components/ChatExtras';
import { FooterMarkers, ForwardedLabel, RevokedBody } from '../../src/features/messages/components/MessageLabels';
import { ChatSearchBar } from '../../src/features/search/components/ChatSearchBar';
import { HighlightedText } from '../../src/features/search/components/HighlightedText';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { chatActionOptions } from '../../src/features/chats/components/ChatRowParts';
import { confirmAction } from '../../src/features/groups/components/ui';
import { usePresence } from '../../src/features/presence/usePresence';
import { presenceSubtitle } from '../../src/features/presence/format';
import { useConversationMute } from '../../src/features/notifications/useMuteStore';
import { MUTE_OPTIONS } from '../../src/features/notifications/mute';
import * as Extras from '../../src/features/stickers/components/chatIntegration';

const REACTION_EMOJIS = ['❤️', '😂', '👍', '🔥', '😮', '😢'];
const TYPING_SEND_INTERVAL_MS = 3000;
const TYPING_IDLE_MS = 4000;

// ──────────────────────────────────────────────────────────────────────────
// Message Bubble
// ──────────────────────────────────────────────────────────────────────────

interface MessageBubbleProps {
  message: Message;
  status: MessageStatus;
  showAvatar: boolean;
  showSenderName: boolean;
  onLongPress: (message: Message) => void;
  onRetry: (message: Message) => void;
  /** Multi-select mode: taps toggle selection. */
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: (message: Message) => void;
  /** Search terms to highlight, and whether this is the focused search result. */
  highlight?: string | null;
  focused?: boolean;
}

const MessageBubble = React.memo(function MessageBubble({
  message,
  status,
  showAvatar,
  showSenderName,
  onLongPress,
  onRetry,
  selecting,
  selected,
  onToggleSelect,
  highlight,
  focused,
}: MessageBubbleProps) {
  const { isOwn, content, createdAt, senderName, media, reactions } = message;
  const revoked = !!message.revokedAt;
  if (!revoked && Extras.isExtensionMessageType(message.messageType)) return <Extras.ExtensionMessage message={message} status={status} showSenderName={showSenderName} onLongPress={onLongPress} onRetry={onRetry} />;
  const messageType = revoked ? 'revoked' : message.messageType;

  if (messageType === 'system') {
    return (
      <View style={extra.systemRow}>
        <Text style={extra.systemText}>{content}</Text>
      </View>
    );
  }

  const renderStatusIcon = () => {
    if (!isOwn) return null;
    const iconProps = { size: 14, style: styles.statusIcon };
    switch (status) {
      case 'sending':
        return <Ionicons name="time-outline" color={Colors.textTertiary} {...iconProps} />;
      case 'sent':
        return <Ionicons name="checkmark-outline" color={Colors.textTertiary} {...iconProps} />;
      case 'delivered':
        return <Ionicons name="checkmark-done-outline" color={Colors.textTertiary} {...iconProps} />;
      case 'read':
        return <Ionicons name="checkmark-done" color={Colors.accentLight} {...iconProps} />;
      case 'failed':
        return <Ionicons name="alert-circle" color={Colors.error} {...iconProps} />;
      default:
        return null;
    }
  };

  const reactionCounts = (reactions || []).reduce<Record<string, number>>((acc, r) => {
    acc[r.emoji] = (acc[r.emoji] || 0) + 1;
    return acc;
  }, {});

  return (
    <View
      style={[
        styles.bubbleContainer,
        isOwn ? styles.bubbleContainerOwn : styles.bubbleContainerOther,
        selected && extra.selectedRow,
      ]}
    >
      {!isOwn && showAvatar && (
        <View style={styles.messageAvatar}>
          <Text style={styles.messageAvatarText}>{(senderName || '?').slice(0, 1).toUpperCase()}</Text>
        </View>
      )}
      {!isOwn && !showAvatar && <View style={styles.avatarPlaceholder} />}

      <Pressable
        onLongPress={() => (selecting ? onToggleSelect?.(message) : onLongPress(message))}
        onPress={
          selecting ? () => onToggleSelect?.(message) : status === 'failed' ? () => onRetry(message) : undefined
        }
        delayLongPress={300}
        style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther, focused && extra.focusedBubble]}
      >
        {showSenderName && !isOwn && <Text style={extra.senderName}>{senderName}</Text>}

        {!revoked && <ForwardedLabel hops={message.forwardCount} />}

        {revoked && <RevokedBody isOwn={isOwn} />}

        {message.replyPreview ? (
          <View style={styles.replyPreview}>
            <View style={styles.replyBar} />
            <Text style={styles.replyText} numberOfLines={1}>
              {message.replyPreview}
            </Text>
          </View>
        ) : null}

        {messageType === 'text' && (
          <HighlightedText
            style={[styles.messageText, isOwn ? styles.messageTextOwn : styles.messageTextOther]}
            text={content ?? ''}
            query={highlight}
          />
        )}

        {messageType === 'unavailable' && (
          <View style={extra.unavailableRow}>
            <Ionicons name="lock-closed" size={13} color={Colors.textTertiary} />
            <Text style={extra.unavailableText}>{content}</Text>
          </View>
        )}

        {media && (messageType === 'image' || messageType === 'video' || messageType === 'document') && (
          <MediaAttachmentView type={messageType} media={media} caption={content} isOwn={isOwn} />
        )}

        {media && messageType === 'voice' && (
          <VoiceNotePlayer media={media} isOwn={isOwn} onPlayed={() => void markVoicePlayed(message)} />
        )}

        <View style={styles.bubbleFooter}>
          {message.expiresAt && (
            <Ionicons name="timer-outline" size={11} color={Colors.textTertiary} style={styles.timerIcon} />
          )}
          {status === 'failed' && <Text style={extra.failedText}>Not sent · tap to retry</Text>}
          <FooterMarkers message={message} />
          <Text style={[styles.messageTime, isOwn ? styles.timeOwn : styles.timeOther]}>
            {dayjs(createdAt).format('HH:mm')}
          </Text>
          {renderStatusIcon()}
        </View>

        {Object.keys(reactionCounts).length > 0 && (
          <View style={styles.reactionsRow}>
            {Object.entries(reactionCounts).map(([emoji, count]) => (
              <View key={emoji} style={styles.reactionChip}>
                <Text style={styles.reactionEmoji}>
                  {emoji}
                  {count > 1 ? ` ${count}` : ''}
                </Text>
              </View>
            ))}
          </View>
        )}
      </Pressable>
    </View>
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Typing Indicator
// ──────────────────────────────────────────────────────────────────────────

function TypingIndicator() {
  const dots = useRef([0.3, 0.3, 0.3].map((v) => new Animated.Value(v))).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.parallel(
        dots.map((val, i) =>
          Animated.sequence([
            Animated.delay(i * 150),
            Animated.timing(val, { toValue: 1, duration: 300, useNativeDriver: true }),
            Animated.timing(val, { toValue: 0.3, duration: 300, useNativeDriver: true }),
          ])
        )
      )
    );
    anim.start();
    return () => anim.stop();
  }, [dots]);

  return (
    <View style={styles.typingContainer}>
      <View style={styles.typingBubble}>
        {dots.map((dot, i) => (
          <Animated.View key={i} style={[styles.typingDot, { opacity: dot }]} />
        ))}
      </View>
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Chat Screen
// ──────────────────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const { id, messageId: jumpMessageId, q: jumpQuery } = useLocalSearchParams<{
    id: string;
    messageId?: string;
    q?: string;
  }>();
  const conversationId = id ?? '';
  const user = useAuthStore((s) => s.user);
  const isDemo = useAuthStore((s) => s.isDemo);

  const chat = useMessagesStore((s) => s.chats[conversationId]);
  const { open, close, loadOlder, send, retry, react, deleteMessage, setTimer, clearLocalHistory, sendTyping } =
    useMessagesStore.getState();

  const [inputText, setInputText] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [actionMessage, setActionMessage] = useState<Message | null>(null);
  const [showAttachModal, setShowAttachModal] = useState(false);
  const [showMenuModal, setShowMenuModal] = useState(false);
  const [, forceTick] = useState(0);
  const messaging = useChatMessaging(conversationId, user?.id);
  const listRef = useRef<FlatList<Message>>(null);
  const chatListEntry = useChatsStore((s) => s.conversations.find((c) => c.id === conversationId) ?? null);

  const lastTypingSent = useRef(0);
  const typingIdle = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Encrypted attachments and voice notes (logic lives in src/features/media).
  const mediaSender = useMediaSender(conversationId);
  const uploading = mediaSender.uploading;
  const replyRef = useRef<Message | null>(null);
  replyRef.current = replyTo;
  const sendPicked = async (picked: PickedMedia) => {
    if (await mediaSender.send(picked, { replyTo: replyRef.current })) setReplyTo(null);
  };
  const voice = useVoiceRecorder({
    onRecorded: (rec) => void sendPicked(voiceRecordingToMedia(rec)),
    onError: (msg) => Alert.alert('Voice message', msg),
  });

  useEffect(() => {
    if (!conversationId || !user) return;
    open(conversationId).catch((e) => Alert.alert('Could not open chat', friendlyError(e)));
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
  const title = conversation ? conversationTitle(conversation) : 'Loading…';
  const groupChat = useGroupChatSync(conversationId, isGroup && !isDemo);
  const presence = usePresence(!isGroup && !isDemo ? otherUser?.id : null);
  const mute = useConversationMute(conversationId);

  // Typing users (expire automatically)
  const now = Date.now();
  const typingNames = Object.entries(chat?.typing ?? {})
    .filter(([, exp]) => exp > now)
    .map(([uid]) => members.find((m) => m.id === uid)?.displayName || 'Someone');
  useEffect(() => {
    const expiries = Object.values(chat?.typing ?? {}).filter((e) => e > Date.now());
    if (!expiries.length) return;
    const t = setTimeout(() => forceTick((n) => n + 1), Math.min(...expiries) - Date.now() + 50);
    return () => clearTimeout(t);
  }, [chat?.typing]);

  // Newest first for the inverted list.
  const listData = useMemo(() => [...messages].reverse(), [messages]);

  // Opened from search / starred: jump to that message once the chat has loaded.
  const jumped = useRef(false);
  useEffect(() => {
    if (!jumpMessageId || jumped.current || !chat || chat.isLoading) return;
    jumped.current = true;
    void useMessagesStore.getState().jumpTo(conversationId, jumpMessageId);
  }, [jumpMessageId, chat?.isLoading, conversationId]);

  // Scroll to the focused message (search result / jump target).
  const focusId = messaging.focusMessageId;
  useEffect(() => {
    if (!focusId) return;
    const index = listData.findIndex((m) => m.id === focusId);
    if (index >= 0) listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
  }, [focusId, listData.length]);
  const highlight = messaging.searchOpen ? messaging.search.query : jumpQuery ?? null;

  const statusOf = useCallback(
    (m: Message) => (user ? messageRepository.statusFor(m, members, user.id) : m.status),
    [members, user]
  );

  // ── Actions ───────────────────────────────────────────────────────────────

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
    if (messaging.editing) {
      const text = inputText;
      setInputText('');
      stopTyping();
      if (!(await messaging.submitEdit(text))) setInputText(text);
      return;
    }
    const text = inputText.trim();
    if (!text || !conversationId) return;
    setInputText('');
    const reply = replyTo;
    setReplyTo(null);
    stopTyping();
    const result = await send(conversationId, { t: 'text', body: text }, { replyTo: reply });
    if (result?.status === 'failed') {
      Alert.alert('Message not sent', 'Check your connection, then tap the message to retry.');
    }
  };

  const handleRetry = (message: Message) => {
    if (Platform.OS === 'web') {
      // react-native-web's Alert ignores buttons.
      void confirmAction('Message not sent', 'Try sending it again?', 'Retry').then((ok) => {
        if (ok) void retry(message);
      });
      return;
    }
    Alert.alert('Message not sent', 'Try sending it again?', [
      { text: 'Delete', style: 'destructive', onPress: () => void deleteMessage(message, false) },
      { text: 'Cancel', style: 'cancel' },
      { text: 'Retry', onPress: () => void retry(message) },
    ]);
  };

  const handleStartCall = async (callType: 'voice' | 'video') => {
    if (!otherUser) return;
    try {
      const callId = await callService.startCall({
        conversationId,
        peerId: otherUser.id,
        peerName: otherUser.displayName,
        callType,
      });
      router.push(`/call/${callId}`);
    } catch (e) {
      Alert.alert('Call failed', friendlyError(e));
    }
  };

  const handlePickMedia = async (source: 'camera' | 'library' | 'document') => {
    setShowAttachModal(false);
    if (isDemo) {
      Alert.alert('Demo mode', 'Attachments need a real account so they can be encrypted and uploaded.');
      return;
    }
    let picked: PickedMedia | null = null;
    try {
      picked =
        source === 'camera'
          ? await mediaRepository.pickFromCamera()
          : source === 'library'
            ? await mediaRepository.pickFromLibrary()
            : await mediaRepository.pickDocument();
    } catch (e) {
      Alert.alert('Permission needed', friendlyError(e));
      return;
    }
    if (!picked) return;
    await sendPicked(picked);
  };

  const handleReact = async (emoji: string) => {
    const target = actionMessage;
    setActionMessage(null);
    if (!target || !user) return;
    const mine = target.reactions?.find((r) => r.userId === user.id);
    try {
      await react(target, mine?.emoji === emoji ? null : emoji);
    } catch (e) {
      Alert.alert('Reaction not sent', friendlyError(e));
    }
  };

  const handleEdit = () => {
    const target = actionMessage;
    setActionMessage(null);
    if (!target) return;
    const prefill = messaging.startEdit(target);
    if (prefill !== null) {
      setReplyTo(null);
      setInputText(prefill);
    }
  };

  const handleCopyText = async () => {
    if (actionMessage?.content) await Clipboard.setStringAsync(actionMessage.content);
    setActionMessage(null);
  };

  const handleDelete = async (forEveryone: boolean) => {
    const target = actionMessage;
    setActionMessage(null);
    if (!target) return;
    try {
      await deleteMessage(target, forEveryone);
    } catch (e) {
      Alert.alert('Delete failed', friendlyError(e));
    }
  };

  const openVerify = () => {
    if (!otherUser) return;
    router.push({ pathname: '/verify-safety-number', params: { userId: otherUser.id, displayName: otherUser.displayName } });
  };

  const chooseTimer = () => {
    setShowMenuModal(false);
    Alert.alert(
      'Disappearing messages',
      'New messages in this chat will be deleted for everyone after the selected time.',
      [
        ...DISAPPEARING_OPTIONS.map((o) => ({
          text: o.label,
          onPress: () => {
            setTimer(conversationId, o.seconds).catch((e) => Alert.alert('Could not update timer', friendlyError(e)));
          },
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ]
    );
  };

  const chooseMute = () => {
    setShowMenuModal(false);
    const fail = (e: unknown) => Alert.alert('Could not change notifications', friendlyError(e));
    Alert.alert(
      mute.isMuted ? mute.label ?? 'Muted' : 'Mute notifications',
      'Muted chats never send push notifications. Messages still arrive.',
      [
        ...(mute.isMuted
          ? [{ text: 'Unmute', onPress: () => void mute.unmute().catch(fail) }]
          : MUTE_OPTIONS.map((o) => ({ text: o.label, onPress: () => void mute.mute(o.value).catch(fail) }))),
        { text: 'Cancel', style: 'cancel' as const },
      ]
    );
  };

  const leaveGroup = () => {
    setShowMenuModal(false);
    if (!user) return;
    Alert.alert('Leave group', 'You will stop receiving new messages from this group.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          try {
            await groupRepository.leave(conversationId);
            router.back();
          } catch (e) {
            Alert.alert('Could not leave group', friendlyError(e));
          }
        },
      },
    ]);
  };

  const subtitle = typingNames.length
    ? `${typingNames.join(', ')} typing…`
    : isGroup
      ? `${members.length} members · end-to-end encrypted`
      : presenceSubtitle(presence) ?? 'End-to-end encrypted · tap to verify';

  const canDeleteForEveryone = messaging.canDeleteEveryone(actionMessage);
  const actionRevoked = !!actionMessage?.revokedAt;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {messaging.selecting ? (
        <SelectionBar
          count={messaging.selectedMessages.length}
          allStarred={messaging.selectedMessages.length > 0 && messaging.selectedMessages.every((m) => m.starred)}
          canForward={messaging.selectedMessages.length > 0}
          onCancel={messaging.clearSelection}
          onStar={() => void messaging.toggleStar(messaging.selectedMessages)}
          onForward={() => messaging.openForward(messaging.selectedMessages)}
          onCopy={() => void messaging.copySelection()}
          onDelete={() => void messaging.deleteSelectionForMe()}
        />
      ) : messaging.searchOpen ? (
        <ChatSearchBar
          query={messaging.search.query}
          onChangeQuery={messaging.search.setQuery}
          index={messaging.search.index}
          total={messaging.search.results.length}
          searching={messaging.search.searching}
          onOlder={messaging.search.older}
          onNewer={messaging.search.newer}
          onClose={messaging.closeSearch}
        />
      ) : (
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.headerInfo}
          onPress={() => (otherUser ? router.push(`/profile/${otherUser.id}`) : isGroup ? router.push(`/group/${conversationId}`) : null)}
          activeOpacity={0.7}
        >
          <View style={styles.headerAvatar}>
            {isGroup ? (
              <Ionicons name="people" size={18} color="#FFF" />
            ) : (
              <Text style={styles.headerAvatarText}>{title.slice(0, 1).toUpperCase()}</Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerName} numberOfLines={1}>
              {title}
              <Extras.BotBadge userId={otherUser?.id} />
            </Text>
            <TouchableOpacity style={styles.headerStatus} onPress={otherUser ? openVerify : undefined}>
              <Ionicons name="lock-closed" size={10} color={Colors.accent} />
              <Text style={styles.headerStatusText} numberOfLines={1}>
                {subtitle}
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>

        <View style={styles.headerActions}>
          {!isGroup && otherUser && (
            <>
              <TouchableOpacity style={styles.headerBtn} onPress={() => handleStartCall('voice')}>
                <Ionicons name="call-outline" size={22} color={Colors.textPrimary} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.headerBtn} onPress={() => handleStartCall('video')}>
                <Ionicons name="videocam-outline" size={22} color={Colors.textPrimary} />
              </TouchableOpacity>
            </>
          )}
          <TouchableOpacity style={styles.headerBtn} onPress={() => setShowMenuModal(true)}>
            <Ionicons name="ellipsis-vertical" size={22} color={Colors.textPrimary} />
          </TouchableOpacity>
        </View>
      </View>
      )}

      {(chat?.timerSeconds ?? 0) > 0 && (
        <View style={styles.disappearingBanner}>
          <Ionicons name="timer-outline" size={13} color={Colors.warning} />
          <Text style={styles.disappearingBannerText}>Disappearing messages: {timerLabel(chat!.timerSeconds)}</Text>
        </View>
      )}

      {uploading && (
        <View style={styles.uploadProgressBanner}>
          <ActivityIndicator size="small" color={Colors.accent} />
          <Text style={styles.uploadProgressText}>{mediaSender.status ?? 'Encrypting and uploading…'}</Text>
        </View>
      )}

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {chat?.isLoading && messages.length === 0 ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color={Colors.accent} size="large" />
            <Text style={styles.loadingText}>Decrypting messages…</Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            inverted
            data={listData}
            extraData={messaging.selectedIds}
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
              setTimeout(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 }), 120);
            }}
            keyExtractor={(item) => item.id}
            renderItem={({ item, index }) => {
              const older = listData[index + 1];
              const showAvatar = !item.isOwn && (!older || older.senderUserId !== item.senderUserId);
              return (
                <MessageBubble
                  message={item}
                  status={statusOf(item)}
                  showAvatar={showAvatar}
                  showSenderName={isGroup && showAvatar}
                  onLongPress={setActionMessage}
                  onRetry={handleRetry}
                  selecting={messaging.selecting}
                  selected={messaging.selectedIds.includes(item.id)}
                  onToggleSelect={messaging.toggleSelect}
                  highlight={highlight}
                  focused={item.id === focusId}
                />
              );
            }}
            onEndReached={() => void loadOlder(conversationId)}
            onEndReachedThreshold={0.3}
            ListHeaderComponent={typingNames.length ? <TypingIndicator /> : null}
            ListFooterComponent={
              chat?.isLoadingOlder ? (
                <ActivityIndicator color={Colors.accent} style={{ marginVertical: 12 }} />
              ) : !chat?.hasMore ? (
                <TouchableOpacity
                  style={styles.securityAnnouncementBadge}
                  activeOpacity={0.8}
                  onPress={otherUser ? openVerify : undefined}
                >
                  <View style={styles.securityShieldCircle}>
                    <Ionicons name="shield-checkmark" size={15} color={Colors.emerald} />
                  </View>
                  <Text style={styles.securityAnnouncementText}>
                    {isDemo
                      ? 'Demo mode: these messages are sample data stored only on this device.'
                      : 'Messages are end-to-end encrypted. Only the devices of people in this chat can read them.' +
                        (otherUser ? ' Tap to verify the safety number.' : '')}
                  </Text>
                </TouchableOpacity>
              ) : null
            }
            contentContainerStyle={styles.messageList}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          />
        )}

        {messaging.editing && (
          <EditBanner
            message={messaging.editing}
            onCancel={() => {
              messaging.cancelEdit();
              setInputText('');
            }}
          />
        )}

        {replyTo && !messaging.editing && (
          <View style={styles.replyPreviewBar}>
            <View style={styles.replyPreviewContent}>
              <Ionicons name="return-up-forward" size={16} color={Colors.accent} />
              <Text style={styles.replyPreviewText} numberOfLines={1}>
                {messagePreview(replyTo.messageType, replyTo.content)}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setReplyTo(null)}>
              <Ionicons name="close" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
        )}

        <Extras.BotCommandSuggestions botUserId={otherUser?.id} text={inputText} onPick={setInputText} />
        {!groupChat.canSend && <AdminsOnlyNotice />}
        {groupChat.canSend && (
        <View style={styles.inputBar}>
          {voice.isActive ? (
            <VoiceRecordingBar voice={voice} />
          ) : (
            <>
              <TouchableOpacity style={styles.attachBtn} onPress={() => setShowAttachModal(true)} disabled={uploading}>
                <Ionicons name="add-circle-outline" size={26} color={Colors.accent} />
              </TouchableOpacity>
              <Extras.ChatComposerExtras conversation={conversation} replyTo={replyTo} onSent={() => setReplyTo(null)} disabled={uploading} />

              <View style={styles.inputWrapper}>
                <TextInput
                  style={styles.textInput}
                  placeholder="Message"
                  placeholderTextColor={Colors.textTertiary}
                  value={inputText}
                  onChangeText={handleChangeText}
                  multiline
                  maxLength={MAX_TEXT_LENGTH}
                />
              </View>
            </>
          )}

          {messaging.editing ? (
            <TouchableOpacity
              style={[
                styles.sendBtn,
                !inputText.trim() && messaging.editing.messageType === 'text' && styles.sendBtnDisabled,
              ]}
              onPress={handleSend}
              disabled={!inputText.trim() && messaging.editing.messageType === 'text'}
              accessibilityLabel="Save edit"
            >
              <Ionicons name="checkmark" size={18} color={Colors.white} />
            </TouchableOpacity>
          ) : inputText.trim() ? (
            <TouchableOpacity style={styles.sendBtn} onPress={handleSend} accessibilityLabel="Send message">
              <Ionicons name="send" size={18} color={Colors.white} />
            </TouchableOpacity>
          ) : voice.isLocked || isDemo ? null : (
            <VoiceRecordButton voice={voice} disabled={uploading} />
          )}
        </View>
        )}
      </KeyboardAvoidingView>

      {/* Attachment sheet */}
      <Modal visible={showAttachModal} transparent animationType="slide" onRequestClose={() => setShowAttachModal(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowAttachModal(false)}>
          <View style={styles.attachSheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Encrypted attachment</Text>
            <View style={styles.attachGrid}>
              {(
                [
                  ['camera', 'camera', 'Camera', '#EF4444'],
                  ['library', 'images', 'Photos & videos', '#8B5CF6'],
                  ['document', 'document-text', 'Document', '#3B82F6'],
                ] as const
              ).map(([source, icon, label, color]) => (
                <TouchableOpacity key={source} style={styles.attachItem} onPress={() => handlePickMedia(source)}>
                  <View style={[styles.attachIconCircle, { backgroundColor: color }]}>
                    <Ionicons name={icon} size={24} color={Colors.white} />
                  </View>
                  <Text style={styles.attachLabel}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* Message actions */}
      <Modal visible={actionMessage !== null} transparent animationType="fade" onRequestClose={() => setActionMessage(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setActionMessage(null)}>
          <View style={styles.actionSheet}>
            {actionMessage?.messageType !== 'unavailable' && actionMessage?.status !== 'failed' && !actionRevoked && (
              <View style={styles.reactionsBar}>
                {REACTION_EMOJIS.map((emoji) => (
                  <TouchableOpacity key={emoji} style={styles.reactionBtn} onPress={() => handleReact(emoji)}>
                    <Text style={styles.reactionText}>{emoji}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {!actionRevoked && (
            <TouchableOpacity
              style={styles.actionRow}
              onPress={() => {
                setReplyTo(actionMessage);
                setActionMessage(null);
              }}
            >
              <Ionicons name="return-up-forward" size={20} color={Colors.accent} />
              <Text style={styles.actionText}>Reply</Text>
            </TouchableOpacity>
            )}

            {messaging.canEdit(actionMessage) && (
              <TouchableOpacity style={styles.actionRow} onPress={handleEdit}>
                <Ionicons name="create-outline" size={20} color={Colors.accent} />
                <Text style={styles.actionText}>Edit</Text>
              </TouchableOpacity>
            )}

            {!!actionMessage && !actionRevoked && actionMessage.messageType !== 'system' && actionMessage.messageType !== 'unavailable' && (
              <TouchableOpacity
                style={styles.actionRow}
                onPress={() => {
                  const m = actionMessage;
                  setActionMessage(null);
                  messaging.openForward([m]);
                }}
              >
                <Ionicons name="arrow-redo-outline" size={20} color={Colors.textPrimary} />
                <Text style={styles.actionText}>Forward</Text>
              </TouchableOpacity>
            )}

            {!!actionMessage && !actionRevoked && actionMessage.messageType !== 'system' && (
              <TouchableOpacity
                style={styles.actionRow}
                onPress={() => {
                  const m = actionMessage;
                  setActionMessage(null);
                  void messaging.toggleStar([m]);
                }}
              >
                <Ionicons name={actionMessage.starred ? 'star' : 'star-outline'} size={20} color={Colors.warning} />
                <Text style={styles.actionText}>{actionMessage.starred ? 'Unstar' : 'Star'}</Text>
              </TouchableOpacity>
            )}

            {!!actionMessage?.editedAt && !actionRevoked && (
              <TouchableOpacity
                style={styles.actionRow}
                onPress={() => {
                  const m = actionMessage;
                  setActionMessage(null);
                  void messaging.showHistory(m);
                }}
              >
                <Ionicons name="time-outline" size={20} color={Colors.textPrimary} />
                <Text style={styles.actionText}>Edit history</Text>
              </TouchableOpacity>
            )}

            {!!actionMessage && actionMessage.messageType !== 'system' && (
              <TouchableOpacity
                style={styles.actionRow}
                onPress={() => {
                  const m = actionMessage;
                  setActionMessage(null);
                  messaging.startSelect(m);
                }}
              >
                <Ionicons name="checkmark-circle-outline" size={20} color={Colors.textPrimary} />
                <Text style={styles.actionText}>Select</Text>
              </TouchableOpacity>
            )}

            {!!actionMessage?.content && actionMessage.messageType === 'text' && (
              <TouchableOpacity style={styles.actionRow} onPress={handleCopyText}>
                <Ionicons name="copy-outline" size={20} color={Colors.textPrimary} />
                <Text style={styles.actionText}>Copy text</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity style={styles.actionRow} onPress={() => handleDelete(false)}>
              <Ionicons name="trash-outline" size={20} color={Colors.warning} />
              <Text style={[styles.actionText, { color: Colors.warning }]}>Delete for me</Text>
            </TouchableOpacity>

            {canDeleteForEveryone && (
              <TouchableOpacity style={styles.actionRow} onPress={() => handleDelete(true)}>
                <Ionicons name="trash" size={20} color={Colors.error} />
                <Text style={[styles.actionText, { color: Colors.error }]}>Delete for everyone</Text>
              </TouchableOpacity>
            )}
          </View>
        </Pressable>
      </Modal>

      {/* Chat menu */}
      <Modal visible={showMenuModal} transparent animationType="fade" onRequestClose={() => setShowMenuModal(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowMenuModal(false)}>
          <View style={styles.menuSheet}>
            <Text style={styles.menuSheetTitle}>{isGroup ? `${title} · ${members.length} members` : 'Chat options'}</Text>

            {isGroup &&
              members.map((m) => (
                <View key={m.id} style={styles.menuItem}>
                  <Ionicons name="person-circle-outline" size={20} color={Colors.textSecondary} />
                  <Text style={styles.menuItemText}>
                    {m.id === user?.id ? 'You' : m.displayName}
                    {m.role !== 'member' ? ` · ${m.role}` : ''}
                  </Text>
                </View>
              ))}

            {isGroup && !isDemo && (
              <TouchableOpacity style={styles.menuItem} onPress={() => { setShowMenuModal(false); router.push(`/group/${conversationId}`); }}>
                <Ionicons name="information-circle-outline" size={20} color={Colors.accent} />
                <Text style={styles.menuItemText}>Group info, admins and invite links</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setShowMenuModal(false);
                messaging.openSearch();
              }}
            >
              <Ionicons name="search-outline" size={20} color={Colors.accent} />
              <Text style={styles.menuItemText}>Search in chat</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setShowMenuModal(false);
                router.push({ pathname: '/starred', params: { conversationId } });
              }}
            >
              <Ionicons name="star-outline" size={20} color={Colors.warning} />
              <Text style={styles.menuItemText}>Starred messages</Text>
            </TouchableOpacity>

            {chatListEntry &&
              chatActionOptions(chatListEntry)
                .filter((o) => o.label !== 'Mark as read')
                .map((o) => (
                  <TouchableOpacity
                    key={o.label}
                    style={styles.menuItem}
                    onPress={() => {
                      setShowMenuModal(false);
                      o.onPress();
                    }}
                  >
                    <Ionicons name={o.icon ?? 'ellipse-outline'} size={20} color={Colors.accent} />
                    <Text style={styles.menuItemText}>{o.label}</Text>
                  </TouchableOpacity>
                ))}

            {otherUser && (
              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => {
                  setShowMenuModal(false);
                  openVerify();
                }}
              >
                <Ionicons name="shield-checkmark-outline" size={20} color={Colors.accent} />
                <Text style={styles.menuItemText}>Verify safety number</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity style={styles.menuItem} onPress={chooseMute}>
              <Ionicons name={mute.isMuted ? 'notifications-off-outline' : 'notifications-outline'} size={20} color={Colors.accent} />
              <Text style={styles.menuItemText}>{mute.isMuted ? `Unmute (${mute.label})` : 'Mute notifications'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.menuItem} onPress={chooseTimer}>
              <Ionicons name="timer-outline" size={20} color={Colors.warning} />
              <Text style={styles.menuItemText}>Disappearing messages ({timerLabel(chat?.timerSeconds ?? 0)})</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setShowMenuModal(false);
                Alert.alert('Clear chat', 'Remove all messages in this chat from this device? Other devices are not affected.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Clear', style: 'destructive', onPress: () => void clearLocalHistory(conversationId) },
                ]);
              }}
            >
              <Ionicons name="trash-outline" size={20} color={Colors.error} />
              <Text style={[styles.menuItemText, { color: Colors.error }]}>Clear chat on this device</Text>
            </TouchableOpacity>

            {isGroup && !isDemo && (
              <TouchableOpacity style={styles.menuItem} onPress={leaveGroup}>
                <Ionicons name="exit-outline" size={20} color={Colors.error} />
                <Text style={[styles.menuItemText, { color: Colors.error }]}>Leave group</Text>
              </TouchableOpacity>
            )}
          </View>
        </Pressable>
      </Modal>
      <ForwardSheet
        visible={messaging.forwarding !== null}
        messages={messaging.forwarding ?? []}
        onClose={messaging.closeForward}
        onForward={messaging.doForward}
      />
      <EditHistorySheet entries={messaging.history} onClose={messaging.closeHistory} />
    </SafeAreaView>
  );
}

const extra = StyleSheet.create({
  selectedRow: { backgroundColor: 'rgba(6, 182, 212, 0.14)' },
  focusedBubble: { borderWidth: 2, borderColor: Colors.warning },
  systemRow: { alignItems: 'center', marginVertical: 8 },
  systemText: {
    fontSize: 12,
    color: Colors.textSecondary,
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 10,
    overflow: 'hidden',
  },
  senderName: { fontSize: 12, fontWeight: '700', color: Colors.accentLight, marginBottom: 2 },
  unavailableRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  unavailableText: { fontSize: 13, fontStyle: 'italic', color: Colors.textTertiary, flexShrink: 1 },
  failedText: { fontSize: 11, color: Colors.error, marginRight: 6 },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
    backgroundColor: '#070D18',
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.xs,
  },
  headerInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  headerAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#0284C7',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  headerAvatarText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.white,
  },
  onlineDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: Colors.online,
    borderWidth: 2,
    borderColor: '#070D18',
  },
  headerName: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.textPrimary,
  },
  headerStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  headerStatusText: {
    fontSize: Typography.xs,
    color: Colors.emerald,
    fontWeight: Typography.medium,
  },
  securityAnnouncementBadge: {
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.25)',
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    marginHorizontal: Spacing.sm,
    marginTop: Spacing.xs,
    marginBottom: Spacing.base,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  securityShieldCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  securityAnnouncementText: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
    lineHeight: 17,
    flex: 1,
    letterSpacing: 0.2,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  headerBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  disappearingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    backgroundColor: `${Colors.warning}20`,
    paddingVertical: 4,
  },
  disappearingBannerText: {
    color: Colors.warning,
    fontSize: Typography.xs,
  },
  uploadProgressBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surface,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  uploadProgressText: {
    color: Colors.accent,
    fontSize: Typography.xs,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.base,
  },
  loadingText: {
    fontSize: Typography.sm,
    color: Colors.textSecondary,
  },
  messageList: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.md,
    paddingBottom: Spacing.base,
  },
  bubbleContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 4,
  },
  bubbleContainerOwn: {
    justifyContent: 'flex-end',
  },
  bubbleContainerOther: {
    justifyContent: 'flex-start',
  },
  messageAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  messageAvatarText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.textSecondary,
  },
  avatarPlaceholder: {
    width: 34,
  },
  bubble: {
    maxWidth: '78%',
    borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  bubbleOwn: {
    backgroundColor: '#0284C7',
    borderBottomRightRadius: 4,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.25)',
  },
  bubbleOther: {
    backgroundColor: '#0E1726',
    borderBottomLeftRadius: 4,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  messageText: {
    fontSize: Typography.base,
    lineHeight: 20,
  },
  messageTextOwn: {
    color: Colors.white,
  },
  messageTextOther: {
    color: Colors.textPrimary,
  },
  mediaBubble: {
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
    marginBottom: 4,
  },
  mediaImage: {
    width: 220,
    height: 180,
    borderRadius: BorderRadius.md,
  },
  mediaPlaceholder: {
    width: 220,
    height: 130,
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: BorderRadius.md,
    position: 'relative',
    gap: 6,
  },
  mediaLabel: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
  },
  playOverlay: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  mediaCaption: {
    fontSize: Typography.sm,
    color: Colors.textPrimary,
    marginTop: 4,
  },
  voiceMessage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: 4,
  },
  voicePlayBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.glassHighlight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  voiceWaveform: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 24,
  },
  waveBar: {
    width: 3,
    borderRadius: 1.5,
  },
  waveBarOwn: {
    backgroundColor: Colors.white,
  },
  waveBarOther: {
    backgroundColor: Colors.accent,
  },
  voiceDuration: {
    fontSize: Typography.xs,
  },
  textOwn: { color: Colors.white },
  textOther: { color: Colors.textSecondary },
  documentContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.xs,
  },
  docIconWrapper: {
    width: 38,
    height: 38,
    borderRadius: BorderRadius.md,
    backgroundColor: `${Colors.accent}20`,
    justifyContent: 'center',
    alignItems: 'center',
  },
  docInfo: {
    flex: 1,
  },
  docName: {
    fontSize: Typography.sm,
    fontWeight: Typography.medium,
  },
  docMeta: {
    fontSize: Typography.xs,
    color: Colors.textTertiary,
  },
  bubbleFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 3,
    marginTop: 3,
  },
  timerIcon: {
    marginRight: 2,
  },
  messageTime: {
    fontSize: 10,
  },
  timeOwn: {
    color: 'rgba(255, 255, 255, 0.65)',
  },
  timeOther: {
    color: Colors.textTertiary,
  },
  statusIcon: {
    marginLeft: 1,
  },
  reactionsRow: {
    flexDirection: 'row',
    gap: 4,
    marginTop: 4,
  },
  reactionChip: {
    backgroundColor: Colors.surface,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  reactionEmoji: {
    fontSize: 12,
  },
  replyPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginBottom: 6,
    padding: 4,
    backgroundColor: 'rgba(0,0,0,0.15)',
    borderRadius: BorderRadius.sm,
  },
  replyBar: {
    width: 3,
    height: 20,
    backgroundColor: Colors.accent,
    borderRadius: 1.5,
  },
  replyText: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
    flex: 1,
  },
  replyPreviewBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.xs,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  replyPreviewContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    flex: 1,
  },
  replyPreviewText: {
    color: Colors.textSecondary,
    fontSize: Typography.sm,
    flex: 1,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    backgroundColor: '#070D18',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
    gap: Spacing.sm,
  },
  attachBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  inputWrapper: {
    flex: 1,
    backgroundColor: '#0C1424',
    borderRadius: 22,
    paddingHorizontal: Spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    minHeight: 44,
    justifyContent: 'center',
  },
  textInput: {
    color: Colors.textPrimary,
    fontSize: Typography.base,
    maxHeight: 100,
    paddingVertical: 6,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 6,
  },
  sendBtnDisabled: {
    opacity: 0.6,
  },
  voiceBtn: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  typingContainer: {
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.xs,
  },
  typingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: BorderRadius.lg,
    width: 60,
    gap: 4,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.accent,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'flex-end',
  },
  attachSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.base,
    paddingBottom: Spacing['2xl'],
    gap: Spacing.md,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginBottom: Spacing.xs,
  },
  sheetTitle: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  attachGrid: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: Spacing.md,
  },
  attachItem: {
    alignItems: 'center',
    gap: Spacing.xs,
  },
  attachIconCircle: {
    width: 54,
    height: 54,
    borderRadius: 27,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 3,
  },
  attachLabel: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
    fontWeight: Typography.medium,
  },
  actionSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.base,
    paddingBottom: Spacing['2xl'],
    gap: Spacing.sm,
  },
  reactionsBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.full,
    marginBottom: Spacing.sm,
  },
  reactionBtn: {
    padding: 6,
  },
  reactionText: {
    fontSize: 24,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.sm,
  },
  actionText: {
    fontSize: Typography.base,
    color: Colors.textPrimary,
  },
  menuSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.base,
    paddingBottom: Spacing['2xl'],
    gap: Spacing.md,
  },
  menuSheetTitle: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  menuItemText: {
    fontSize: Typography.base,
    color: Colors.textPrimary,
  },
});
