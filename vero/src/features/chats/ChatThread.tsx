import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Clipboard,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, ZoomIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import dayjs from 'dayjs';
import { useAuthStore } from '../auth/useAuthStore';
import { useMessagesStore } from '../messages/useMessagesStore';
import { messageRepository } from '../messages/MessageRepository';
import { conversationRepository } from './ConversationRepository';
import { mediaRepository } from '../media/MediaRepository';
import { callService } from '../calls/CallService';
import { Message, User } from '../../shared/models/Message';
import { Colors, Fonts, Type } from '../../shared/theme/theme';
import {
  Avatar,
  Chip,
  DotWall,
  Icon,
  IconButton,
  IconName,
  PhotoArt,
  Pressy,
  Sheet,
  SheetRow,
  TypingDots,
  Waveform,
  confirmAction,
  notify,
  sceneFor,
  useLayout,
} from '../../shared/ui';
import {
  DEMO_CONTACTS,
  DEMO_CONVERSATIONS,
  DEMO_MEMBERS,
  DEMO_MESSAGES,
  DEMO_ONLINE,
  DEMO_REPLIES,
  isDemoConversation,
} from '../demo/demoData';

const REACTIONS = ['❤️', '😂', '👍', '🔥', '😮', '🙏'];
const TIMERS = ['Off', '24 hours', '7 days', '90 days'];
const NAME_TONES = ['#E7BD72', '#86C09F', '#C9A3D9', '#9DBBD6', '#E5A08A'];

type Row =
  | { kind: 'day'; id: string; label: string }
  | { kind: 'msg'; id: string; message: Message; firstOfRun: boolean; lastOfRun: boolean };

function dayLabel(iso: string) {
  const d = dayjs(iso);
  if (d.isSame(dayjs(), 'day')) return 'Today';
  if (d.isSame(dayjs().subtract(1, 'day'), 'day')) return 'Yesterday';
  if (d.isAfter(dayjs().subtract(6, 'day'))) return d.format('dddd');
  return d.format('ddd, D MMM');
}

// ── Bubble ──────────────────────────────────────────────────────────────────

function StatusTicks({ status }: { status: Message['status'] }) {
  switch (status) {
    case 'sending':
      return <Icon name="clock" size={13} color="rgba(237,231,217,0.55)" />;
    case 'sent':
      return <Icon name="check" size={14} color="rgba(237,231,217,0.6)" />;
    case 'delivered':
      return <Icon name="checks" size={15} color="rgba(237,231,217,0.6)" />;
    case 'read':
      return <Icon name="checks" size={15} color={Colors.sage} />;
    default:
      return null;
  }
}

function VoiceBody({ own }: { own: boolean }) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setPlaying(false), 4500);
    return () => clearTimeout(t);
  }, [playing]);
  return (
    <View style={styles.voice}>
      <Pressy
        onPress={() => setPlaying((p) => !p)}
        accessibilityLabel={playing ? 'Pause voice message' : 'Play voice message'}
        scaleTo={0.88}
        style={[styles.voicePlay, !own && { backgroundColor: Colors.brass }]}
      >
        <Icon name={playing ? 'pause' : 'play'} size={16} color={own ? Colors.pine : Colors.brassInk} style={!playing && { marginLeft: 2 }} />
      </Pressy>
      <Waveform playing={playing} progress={0.35} />
      <Text style={styles.voiceLen}>0:18</Text>
    </View>
  );
}

interface BubbleProps {
  message: Message;
  isGroup: boolean;
  firstOfRun: boolean;
  lastOfRun: boolean;
  animate: boolean;
  wide: boolean;
  onLongPress: (m: Message) => void;
  onMediaPress: (m: Message) => void;
}

const Bubble = React.memo(function Bubble({ message, isGroup, firstOfRun, lastOfRun, animate, wide, onLongPress, onMediaPress }: BubbleProps) {
  const { isOwn, content, messageType, status, createdAt, senderProfile, media, reactions } = message;
  const isPhoto = messageType === 'image' || messageType === 'video';
  const senderName = senderProfile?.displayName || 'Someone';
  const nameTone = NAME_TONES[Math.abs(senderName.charCodeAt(0) + senderName.length) % NAME_TONES.length];
  const reactionSummary = (reactions || []).map((r) => r.emoji);

  const bubble = (
    <Pressable
      onLongPress={() => onLongPress(message)}
      delayLongPress={280}
      accessibilityHint="Long press for reactions and options"
      style={[
        styles.bubble,
        isOwn ? styles.bubbleOwn : styles.bubbleOther,
        isOwn && lastOfRun && { borderBottomRightRadius: 6 },
        !isOwn && lastOfRun && { borderBottomLeftRadius: 6 },
        isPhoto && styles.bubbleMedia,
        { maxWidth: wide ? 560 : '82%' },
      ]}
    >
      {!isOwn && isGroup && firstOfRun && (
        <Text style={[styles.sender, { color: nameTone }, isPhoto && { paddingHorizontal: 8, paddingTop: 4 }]}>{senderName}</Text>
      )}

      {message.replyToMessage && (
        <View style={styles.quote}>
          <Text style={styles.quoteWho}>{message.replyToMessage.isOwn ? 'You' : message.replyToMessage.senderProfile?.displayName || 'Reply'}</Text>
          <Text style={styles.quoteText} numberOfLines={2}>
            {message.replyToMessage.content || 'Message'}
          </Text>
        </View>
      )}

      {messageType === 'image' && (
        <Pressable onPress={() => onMediaPress(message)} accessibilityLabel="Open photo">
          {media?.localUri ? (
            <Image source={{ uri: media.localUri }} style={[styles.photo, wide && { width: 340, height: 230 }]} />
          ) : (
            <PhotoArt scene={sceneFor(message.id)} width={wide ? 340 : 260} height={wide ? 223 : 171} style={{ borderRadius: 16 }} />
          )}
        </Pressable>
      )}

      {messageType === 'video' && (
        <Pressable onPress={() => onMediaPress(message)} accessibilityLabel="Play video">
          <View style={[styles.photo, wide && { width: 340, height: 230 }, styles.videoTile]}>
            <PhotoArt scene={sceneFor(message.id) + 1} width="100%" height="100%" city={false} style={StyleSheet.absoluteFill} />
            <View style={styles.videoPlay}>
              <Icon name="play" size={22} color={Colors.ink} style={{ marginLeft: 3 }} />
            </View>
          </View>
        </Pressable>
      )}

      {(messageType === 'voice' || messageType === 'audio') && <VoiceBody own={isOwn} />}

      {messageType === 'document' && (
        <Pressable onPress={() => onMediaPress(message)} style={styles.doc} accessibilityLabel="Open document">
          <View style={styles.docIcon}>
            <Icon name="file" size={21} color={Colors.brass} />
          </View>
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.docName} numberOfLines={1}>
              {content || 'Document'}
            </Text>
            <Text style={styles.docMeta}>Document · tap to open</Text>
          </View>
        </Pressable>
      )}

      <View style={[styles.textRow, isPhoto && { paddingHorizontal: 8 }]}>
        {(messageType === 'text' || (isPhoto && !!content)) && <Text style={styles.text}>{content || ' '}</Text>}
        <View style={styles.meta}>
          {message.expiresAt ? <Icon name="timer" size={11} color="rgba(237,231,217,0.55)" /> : null}
          {message.isEdited ? <Text style={styles.metaText}>edited</Text> : null}
          <Text style={styles.metaText}>{dayjs(createdAt).format('h:mm A')}</Text>
          {isOwn && <StatusTicks status={status} />}
        </View>
      </View>
    </Pressable>
  );

  return (
    <Animated.View
      entering={animate ? FadeInDown.springify().damping(17).stiffness(190) : undefined}
      style={[styles.row, isOwn ? styles.rowOwn : styles.rowOther, { marginTop: firstOfRun ? 8 : 2 }]}
    >
      {bubble}
      {reactionSummary.length > 0 && (
        <Animated.View entering={ZoomIn.springify()} style={[styles.reactions, isOwn ? { marginRight: 10 } : { marginLeft: 10 }]}>
          <Text style={styles.reactionText}>{reactionSummary.join(' ')}</Text>
          {reactionSummary.length > 1 && <Text style={styles.reactionCount}>{reactionSummary.length}</Text>}
        </Animated.View>
      )}
    </Animated.View>
  );
});

// ── Thread ──────────────────────────────────────────────────────────────────

interface ChatThreadProps {
  conversationId: string;
  embedded?: boolean;
  title?: string;
  isGroup?: boolean;
}

export function ChatThread({ conversationId, embedded = false, title, isGroup: isGroupProp }: ChatThreadProps) {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { user, deviceId } = useAuthStore();
  const {
    conversations,
    loadMessages,
    sendMessage,
    subscribeToConversation,
    unsubscribeFromConversation,
    appendMessage,
    seedMessages,
    setTyping,
  } = useMessagesStore();

  const demo = isDemoConversation(conversationId);
  const demoConv = demo ? DEMO_CONVERSATIONS.find((c) => c.id === conversationId) : undefined;

  const [inputText, setInputText] = useState('');
  const [members, setMembers] = useState<User[]>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isUploadingMedia, setIsUploadingMedia] = useState(false);
  const [actionMessage, setActionMessage] = useState<Message | null>(null);
  const [showAttach, setShowAttach] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [disappearingTimer, setDisappearingTimer] = useState('Off');

  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const demoTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const replyIx = useRef(0);
  const inputRef = useRef<TextInput>(null);

  const convState = conversations[conversationId];
  const messages = convState?.messages || [];
  const isLoading = convState?.isLoading !== false;
  const isOtherTyping = convState?.isTyping || false;

  const others = members.filter((m) => m.id !== user?.id);
  const recipientUser = others[0] || null;
  const isGroup = isGroupProp ?? (demoConv ? demoConv.conversationType === 'group' : others.length > 1);
  const displayName = title || demoConv?.groupName || demoConv?.otherUser?.displayName || recipientUser?.displayName || 'Conversation';
  const online = !isGroup && !!recipientUser && DEMO_ONLINE.has(recipientUser.id);

  useEffect(() => {
    if (!conversationId || !user?.id || !deviceId) return;

    if (demo) {
      // Demo threads are local sample content — no network round-trip.
      if (!useMessagesStore.getState().conversations[conversationId]?.messages?.length) {
        seedMessages(conversationId, DEMO_MESSAGES[conversationId] || []);
      }
      const contact = DEMO_CONTACTS.find((p) => conversationId === `demo-chat-${p.username}`);
      const self: User = { id: user.id, displayName: user.displayName || 'You', username: user.username || 'you' };
      setMembers(DEMO_MEMBERS[conversationId] || (contact ? [self, contact] : [self]));
      if (demoConv?.isTyping) {
        const typer = (DEMO_MEMBERS[conversationId] || []).find((m) => m.id !== user.id);
        if (typer) setTyping(conversationId, [typer.displayName]);
      }
    } else {
      loadMessages(conversationId, user.id, deviceId);
      subscribeToConversation(conversationId, user.id, deviceId);
      conversationRepository.getConversationMembers(conversationId).then(setMembers).catch(() => setMembers([]));
    }

    return () => {
      unsubscribeFromConversation(conversationId);
      demoTimers.current.forEach(clearTimeout);
      demoTimers.current = [];
    };
  }, [conversationId, user?.id, deviceId]);

  // Newest first for an inverted list, with day breaks and sender runs.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    messages.forEach((m, i) => {
      const prev = messages[i - 1];
      const next = messages[i + 1];
      if (!prev || !dayjs(prev.createdAt).isSame(m.createdAt, 'day')) {
        out.push({ kind: 'day', id: `day-${m.id}`, label: dayLabel(m.createdAt) });
      }
      const sameAsPrev = !!prev && prev.senderUserId === m.senderUserId && dayjs(m.createdAt).diff(prev.createdAt, 'minute') < 5;
      const sameAsNext = !!next && next.senderUserId === m.senderUserId && dayjs(next.createdAt).diff(m.createdAt, 'minute') < 5;
      out.push({ kind: 'msg', id: m.id, message: m, firstOfRun: !sameAsPrev, lastOfRun: !sameAsNext });
    });
    return out.reverse();
  }, [messages]);

  // ── Actions ──

  const demoSend = (text: string, type: Message['messageType'] = 'text') => {
    if (!user) return;
    const now = new Date().toISOString();
    appendMessage(conversationId, {
      id: `local-${Date.now()}`,
      conversationId,
      senderDeviceId: deviceId || 'local',
      senderUserId: user.id,
      senderProfile: { id: user.id, displayName: user.displayName || 'You', username: user.username || 'you' },
      content: text,
      messageType: type,
      status: 'read',
      isOwn: true,
      createdAt: now,
      replyToMessageId: replyTo?.id,
      replyToMessage: replyTo || undefined,
    });
    const responder = others[Math.floor(Math.random() * Math.max(others.length, 1))];
    if (!responder) return;
    demoTimers.current.push(setTimeout(() => setTyping(conversationId, [responder.displayName]), 900));
    demoTimers.current.push(
      setTimeout(() => {
        setTyping(conversationId, []);
        appendMessage(conversationId, {
          id: `local-r-${Date.now()}`,
          conversationId,
          senderDeviceId: `${responder.id}_dev`,
          senderUserId: responder.id,
          senderProfile: responder,
          content: DEMO_REPLIES[replyIx.current++ % DEMO_REPLIES.length],
          messageType: 'text',
          status: 'read',
          isOwn: false,
          createdAt: new Date().toISOString(),
        });
      }, 2700)
    );
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || isSending) return;
    setInputText('');
    setReplyTo(null);

    if (demo) {
      demoSend(text);
      return;
    }
    if (!recipientUser) return;
    setIsSending(true);
    try {
      await sendMessage({ conversationId, plaintext: text, recipientUserId: recipientUser.id, replyToMessageId: replyTo?.id });
    } finally {
      setIsSending(false);
    }
  };

  const handleTyping = (text: string) => {
    setInputText(text);
    if (demo || !user) return;
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      messageRepository.broadcastTyping(conversationId, user.id, true);
    }
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => {
      isTypingRef.current = false;
      messageRepository.broadcastTyping(conversationId, user.id, false);
    }, 2000);
  };

  const handleStartCall = async (callType: 'voice' | 'video') => {
    if (!recipientUser || !user) return;
    const callId = await callService.startCall({
      peerId: recipientUser.id,
      peerName: isGroup ? displayName : recipientUser.displayName,
      callType,
      currentUserId: user.id,
      currentUserName: user.displayName || 'You',
    });
    router.push(`/call/${callId}` as any);
  };

  const handlePickMedia = async (type: 'camera' | 'gallery' | 'video' | 'doc') => {
    setShowAttach(false);
    let picked = null;
    if (type === 'camera') picked = await mediaRepository.pickFromCamera();
    else if (type === 'gallery') picked = await mediaRepository.pickImage();
    else if (type === 'video') picked = await mediaRepository.pickVideo();
    else picked = await mediaRepository.pickDocument();
    if (!picked) return;

    const msgType = type === 'video' ? 'video' : type === 'doc' ? 'document' : 'image';
    if (demo) {
      demoSend(msgType === 'document' ? 'Document' : '', msgType);
      return;
    }
    if (!recipientUser) return;

    setIsUploadingMedia(true);
    try {
      const uploadRes = await mediaRepository.uploadMedia(picked.uri, picked.mimeType, conversationId);
      await sendMessage({
        conversationId,
        plaintext: msgType === 'document' ? 'Encrypted Document' : 'Encrypted Media',
        messageType: msgType,
        recipientUserId: recipientUser.id,
        mediaAttachment: {
          mediaId: uploadRes.mediaId || 'media-id',
          mimeTypeHint: picked.mimeType,
          encryptedObjectId: uploadRes.mediaId || '',
          encryptedSize: picked.size,
          localUri: picked.uri,
          mediaKey: uploadRes.mediaKey,
          mediaIv: uploadRes.mediaIv,
          sha256: uploadRes.sha256,
        },
      });
    } finally {
      setIsUploadingMedia(false);
    }
  };

  const handleVoice = async () => {
    if (demo) {
      demoSend('Voice message', 'voice');
      return;
    }
    if (!recipientUser) return;
    setIsSending(true);
    try {
      await sendMessage({ conversationId, plaintext: 'Encrypted Voice Note', messageType: 'voice', recipientUserId: recipientUser.id });
    } finally {
      setIsSending(false);
    }
  };

  const handleReact = async (emoji: string) => {
    if (!actionMessage || !user) return;
    if (demo) {
      seedMessages(
        conversationId,
        messages.map((m) =>
          m.id === actionMessage.id
            ? { ...m, reactions: [...(m.reactions || []).filter((r) => r.userId !== user.id), { emoji, userId: user.id, createdAt: new Date().toISOString() }] }
            : m
        )
      );
    } else {
      await messageRepository.addReaction(conversationId, actionMessage.id, emoji, user.id).catch(() => {});
    }
    setActionMessage(null);
  };

  const handleCopy = () => {
    if (actionMessage?.content) {
      Clipboard.setString(actionMessage.content);
      notify('Copied', 'Message copied to clipboard.');
    }
    setActionMessage(null);
  };

  const handleDelete = async (forEveryone: boolean) => {
    if (!actionMessage) return;
    if (!demo) await messageRepository.deleteMessage(actionMessage.id, forEveryone).catch(() => {});
    setActionMessage(null);
    if (demo) {
      seedMessages(conversationId, messages.filter((m) => m.id !== actionMessage.id));
    } else if (user && deviceId) {
      loadMessages(conversationId, user.id, deviceId);
    }
  };

  const openMedia = (message: Message) => {
    router.push({
      pathname: '/media-viewer',
      params: {
        uri: message.media?.localUri || '',
        type: message.messageType,
        name: message.isOwn ? 'You' : message.senderProfile?.displayName || displayName,
        caption: message.content || '',
        date: dayjs(message.createdAt).format('ddd D MMM, h:mm A'),
        seed: message.id,
      },
    } as any);
  };

  const openVerify = () => {
    if (recipientUser) {
      router.push(`/verify-safety-number?userId=${recipientUser.id}&displayName=${encodeURIComponent(recipientUser.displayName)}` as any);
    }
  };

  const openProfile = () => {
    if (recipientUser) router.push(`/profile/${recipientUser.id}?name=${encodeURIComponent(recipientUser.displayName)}` as any);
  };

  const statusText = isOtherTyping
    ? isGroup && convState?.typingUsers?.[0]
      ? `${convState.typingUsers[0].split(' ')[0]} is typing…`
      : 'typing…'
    : isGroup
    ? others.map((o) => o.displayName.split(' ')[0]).concat('you').join(', ')
    : online
    ? 'online'
    : 'End-to-end encrypted';
  const statusColor = isOtherTyping ? Colors.brass : online ? Colors.sage : Colors.muted;
  const hasText = inputText.trim().length > 0;

  // ── Render ──

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: embedded ? 0 : insets.top }, embedded && styles.headerEmbedded]}>
        <View style={[styles.headerInner, embedded && { height: 76, paddingLeft: 24 }]}>
          {!embedded && <IconButton icon="back" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))} />}
          <Pressy onPress={openProfile} scaleTo={0.98} style={styles.headerWho} accessibilityLabel={`${displayName}, open profile`}>
            <Avatar name={displayName} size={embedded ? 44 : 42} square={isGroup} online={online} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.headerName} numberOfLines={1}>
                {displayName}
              </Text>
              <Animated.View key={statusText} entering={FadeIn.duration(220)} style={styles.headerStatusRow}>
                {!isOtherTyping && !online && !isGroup && <Icon name="lock" size={11} color={Colors.muted} />}
                <Text style={[styles.headerStatus, { color: statusColor }]} numberOfLines={1}>
                  {statusText}
                </Text>
              </Animated.View>
            </View>
          </Pressy>
          {isWide && (
            <View style={styles.e2ePill}>
              <Icon name="lock" size={13} color={Colors.sage} />
              <Text style={styles.e2ePillText}>Encrypted</Text>
            </View>
          )}
          <IconButton icon="video" label="Video call" onPress={() => handleStartCall('video')} />
          <IconButton icon="phone" label="Voice call" onPress={() => handleStartCall('voice')} />
          <IconButton icon="more" label="Chat options" onPress={() => setShowMenu(true)} />
        </View>
      </View>

      {disappearingTimer !== 'Off' && (
        <Animated.View entering={FadeInDown} exiting={FadeOut} style={styles.banner}>
          <Icon name="timer" size={14} color={Colors.brassLight} />
          <Text style={styles.bannerText}>New messages disappear after {disappearingTimer}</Text>
        </Animated.View>
      )}
      {isUploadingMedia && (
        <Animated.View entering={FadeInDown} exiting={FadeOut} style={styles.banner}>
          <ActivityIndicator size="small" color={Colors.brass} />
          <Text style={styles.bannerText}>Encrypting and sending…</Text>
        </Animated.View>
      )}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flex: 1 }}>
          <DotWall />
          {isLoading && messages.length === 0 ? (
            <View style={styles.loading}>
              <ActivityIndicator color={Colors.brass} />
              <Text style={Type.caption}>Unlocking messages…</Text>
            </View>
          ) : (
            <FlatList
              inverted
              data={rows}
              keyExtractor={(r) => r.id}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[styles.list, isWide && styles.listWide]}
              renderItem={({ item, index }) =>
                item.kind === 'day' ? (
                  <View style={styles.dayWrap}>
                    <Text style={styles.day}>{item.label}</Text>
                  </View>
                ) : (
                  <Bubble
                    message={item.message}
                    isGroup={isGroup}
                    firstOfRun={item.firstOfRun}
                    lastOfRun={item.lastOfRun}
                    animate={index < 8}
                    wide={isWide}
                    onLongPress={setActionMessage}
                    onMediaPress={openMedia}
                  />
                )
              }
              ListHeaderComponent={isOtherTyping ? <TypingDots /> : null}
              ListFooterComponent={
                <Pressy onPress={openVerify} scaleTo={0.98} style={styles.notice} accessibilityLabel="Verify safety number">
                  <Icon name="lock" size={15} color={Colors.brass} style={{ marginTop: 1 }} />
                  <Text style={styles.noticeText}>
                    Messages and calls are end-to-end encrypted. No one outside this chat — not even Vero — can read or listen to them.{' '}
                    <Text style={{ color: Colors.brassLight, fontFamily: Fonts.semibold }}>Verify</Text>
                  </Text>
                </Pressy>
              }
            />
          )}
        </View>

        {replyTo && (
          <Animated.View entering={FadeInDown.springify().damping(18)} style={styles.replyBar}>
            <View style={styles.replyAccent} />
            <View style={{ flex: 1 }}>
              <Text style={styles.quoteWho}>Replying to {replyTo.isOwn ? 'yourself' : replyTo.senderProfile?.displayName || displayName}</Text>
              <Text style={styles.replyText} numberOfLines={1}>
                {replyTo.content || 'Message'}
              </Text>
            </View>
            <IconButton icon="close" label="Cancel reply" size={36} onPress={() => setReplyTo(null)} />
          </Animated.View>
        )}

        {/* Composer */}
        <View style={[styles.composer, { paddingBottom: embedded ? 18 : Math.max(insets.bottom, 12) }, isWide && styles.composerWide]}>
          <IconButton icon="plus" label="Attach" variant="filled" size={46} onPress={() => setShowAttach(true)} />
          <View style={styles.field}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              placeholder="Write a message"
              placeholderTextColor={Colors.faint}
              selectionColor={Colors.brass}
              value={inputText}
              onChangeText={handleTyping}
              multiline
              {...(Platform.OS === 'web' ? { numberOfLines: 1 } : {})}
              maxLength={5000}
              accessibilityLabel="Message"
              onKeyPress={(e: any) => {
                if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
                  e.preventDefault?.();
                  handleSend();
                }
              }}
            />
            {!hasText && <IconButton icon="camera" label="Camera" size={38} color={Colors.muted} onPress={() => handlePickMedia('camera')} />}
          </View>
          {hasText ? (
            <Animated.View key="send" entering={ZoomIn.springify().damping(13)}>
              <IconButton icon="send" label="Send" variant="brass" size={46} onPress={handleSend} />
            </Animated.View>
          ) : (
            <Animated.View key="mic" entering={ZoomIn.springify().damping(13)}>
              <IconButton icon="mic" label="Send a voice message" variant="filled" size={46} onPress={handleVoice} />
            </Animated.View>
          )}
        </View>
      </KeyboardAvoidingView>

      {/* Attach */}
      <Sheet visible={showAttach} onClose={() => setShowAttach(false)} title="Share">
        <View style={styles.attachGrid}>
          {(
            [
              ['camera', 'Camera', 'camera', Colors.pine],
              ['gallery', 'Photos', 'image', '#3F5A73'],
              ['video', 'Video', 'video', '#6B4A5E'],
              ['doc', 'Document', 'file', '#7A5A2E'],
            ] as [any, string, IconName, string][]
          ).map(([key, label, icon, bg], i) => (
            <Animated.View key={key} entering={ZoomIn.delay(i * 50).springify().damping(14)} style={{ flex: 1 }}>
              <Pressy onPress={() => handlePickMedia(key)} style={styles.attachItem} accessibilityLabel={label}>
                <View style={[styles.attachIcon, { backgroundColor: bg }]}>
                  <Icon name={icon} size={24} color={Colors.cream} />
                </View>
                <Text style={Type.label}>{label}</Text>
              </Pressy>
            </Animated.View>
          ))}
        </View>
        <View style={styles.sheetNote}>
          <Icon name="lock" size={13} color={Colors.sage} />
          <Text style={Type.caption}>Files are encrypted on this device before they’re sent.</Text>
        </View>
      </Sheet>

      {/* Message actions */}
      <Sheet visible={!!actionMessage} onClose={() => setActionMessage(null)}>
        <View style={styles.reactRow}>
          {REACTIONS.map((e, i) => (
            <Animated.View key={e} entering={ZoomIn.delay(i * 35).springify().damping(12)}>
              <Pressy onPress={() => handleReact(e)} scaleTo={0.8} style={styles.reactBtn} accessibilityLabel={`React ${e}`}>
                <Text style={{ fontSize: 24 }}>{e}</Text>
              </Pressy>
            </Animated.View>
          ))}
        </View>
        <SheetRow
          icon="reply"
          label="Reply"
          onPress={() => {
            setReplyTo(actionMessage);
            setActionMessage(null);
            setTimeout(() => inputRef.current?.focus(), 150);
          }}
        />
        {!!actionMessage?.content && <SheetRow icon="copy" label="Copy text" onPress={handleCopy} />}
        <SheetRow icon="trash" label="Delete for me" tone="ember" onPress={() => handleDelete(false)} />
        {actionMessage?.isOwn && <SheetRow icon="trash" label="Delete for everyone" tone="ember" onPress={() => handleDelete(true)} />}
      </Sheet>

      {/* Chat options */}
      <Sheet visible={showMenu} onClose={() => setShowMenu(false)} title={displayName}>
        <SheetRow
          icon="shieldCheck"
          label="Verify safety number"
          onPress={() => {
            setShowMenu(false);
            openVerify();
          }}
        />
        <SheetRow
          icon="user"
          label={isGroup ? 'Group info' : 'View profile'}
          onPress={() => {
            setShowMenu(false);
            openProfile();
          }}
        />
        <View style={{ gap: 10, paddingHorizontal: 6, paddingTop: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Icon name="timer" size={17} color={Colors.brass} />
            <Text style={[Type.label, { color: Colors.cream }]}>Disappearing messages</Text>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {TIMERS.map((t) => (
              <Chip key={t} label={t} active={disappearingTimer === t} onPress={() => setDisappearingTimer(t)} />
            ))}
          </View>
        </View>
        <SheetRow
          icon="trash"
          label="Clear chat"
          tone="ember"
          onPress={() => {
            setShowMenu(false);
            confirmAction({
              title: 'Clear this chat?',
              message: 'Messages will be removed from this device. Other people in the chat keep their copy.',
              confirmLabel: 'Clear',
              destructive: true,
              onConfirm: () => {},
            });
          }}
        />
      </Sheet>
    </View>
  );
}

export function NoChatSelected() {
  return (
    <View style={{ flex: 1 }}>
      <DotWall />
      <Animated.View entering={FadeIn.duration(500)} style={styles.noChat}>
        <View style={styles.noChatIcon}>
          <Icon name="chat" size={34} color={Colors.brass} />
        </View>
        <Text style={[Type.h2, { textAlign: 'center' }]}>Pick up where you left off</Text>
        <Text style={[Type.bodyMuted, { textAlign: 'center', maxWidth: 360 }]}>
          Choose a conversation on the left. Everything here is end-to-end encrypted.
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.ink },
  header: { backgroundColor: Colors.ink, borderBottomWidth: 1, borderBottomColor: Colors.line, zIndex: 2 },
  headerEmbedded: { backgroundColor: 'rgba(12,14,13,0.94)' },
  headerInner: { height: 68, flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 8 },
  headerWho: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingRight: 8 },
  headerName: { fontFamily: Fonts.semibold, fontSize: 16, color: Colors.cream },
  headerStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  headerStatus: { fontFamily: Fonts.body, fontSize: 12.5 },
  e2ePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: 14,
    backgroundColor: Colors.sageTint,
    marginRight: 6,
  },
  e2ePillText: { fontFamily: Fonts.medium, fontSize: 12, color: Colors.sage },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
    backgroundColor: Colors.brassTint,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(214,166,87,0.18)',
  },
  bannerText: { fontFamily: Fonts.medium, fontSize: 12.5, color: '#D9C9A4' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  list: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 },
  listWide: { paddingHorizontal: 32, maxWidth: 940, width: '100%', alignSelf: 'center' },
  dayWrap: { alignItems: 'center', marginVertical: 12 },
  day: {
    fontFamily: Fonts.medium,
    fontSize: 12,
    color: Colors.muted,
    backgroundColor: Colors.raised,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.line,
  },
  notice: {
    alignSelf: 'center',
    maxWidth: 440,
    flexDirection: 'row',
    gap: 9,
    marginTop: 10,
    marginBottom: 6,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: Colors.brassTint,
    borderWidth: 1,
    borderColor: 'rgba(214,166,87,0.18)',
  },
  noticeText: { flex: 1, fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 18, color: '#D9C9A4' },
  row: { flexDirection: 'column' },
  rowOwn: { alignItems: 'flex-end' },
  rowOther: { alignItems: 'flex-start' },
  bubble: { paddingHorizontal: 13, paddingTop: 9, paddingBottom: 7, borderRadius: 20 },
  bubbleOwn: {
    backgroundColor: Colors.pine,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  bubbleOther: { backgroundColor: Colors.raised, borderWidth: 1, borderColor: Colors.line },
  bubbleMedia: { padding: 4, paddingBottom: 6 },
  sender: { fontFamily: Fonts.semibold, fontSize: 12.5, marginBottom: 3 },
  quote: {
    marginBottom: 6,
    marginHorizontal: -3,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.22)',
    borderLeftWidth: 3,
    borderLeftColor: Colors.brass,
  },
  quoteWho: { fontFamily: Fonts.semibold, fontSize: 12.5, color: Colors.brass },
  quoteText: { fontFamily: Fonts.body, fontSize: 13, color: 'rgba(237,231,217,0.75)', marginTop: 1 },
  textRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'flex-end', columnGap: 10 },
  text: { fontFamily: Fonts.body, fontSize: 15.5, lineHeight: 22, color: Colors.cream, flexShrink: 1 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, marginLeft: 'auto' },
  metaText: { fontFamily: Fonts.body, fontSize: 11, color: 'rgba(237,231,217,0.6)' },
  photo: { width: 260, height: 171, borderRadius: 16, overflow: 'hidden' },
  videoTile: { alignItems: 'center', justifyContent: 'center' },
  videoPlay: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: 'rgba(237,231,217,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  voice: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 230, paddingVertical: 2 },
  voicePlay: { width: 38, height: 38, borderRadius: 19, backgroundColor: Colors.cream, alignItems: 'center', justifyContent: 'center' },
  voiceLen: { fontFamily: Fonts.mono, fontSize: 12, color: 'rgba(237,231,217,0.7)' },
  doc: { flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 230, paddingVertical: 2 },
  docIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: Colors.brassTint2, alignItems: 'center', justifyContent: 'center' },
  docName: { fontFamily: Fonts.semibold, fontSize: 14, color: Colors.cream },
  docMeta: { fontFamily: Fonts.body, fontSize: 12, color: 'rgba(237,231,217,0.65)', marginTop: 2 },
  reactions: {
    marginTop: -8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 26,
    paddingHorizontal: 8,
    borderRadius: 13,
    backgroundColor: Colors.field,
    borderWidth: 2,
    borderColor: Colors.wallpaper,
  },
  reactionText: { fontSize: 13 },
  reactionCount: { fontFamily: Fonts.medium, fontSize: 12, color: Colors.cream },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 16,
    paddingRight: 8,
    paddingVertical: 8,
    backgroundColor: Colors.panel,
    borderTopWidth: 1,
    borderTopColor: Colors.line,
  },
  replyAccent: { width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: Colors.brass },
  replyText: { fontFamily: Fonts.body, fontSize: 13.5, color: Colors.muted, marginTop: 1 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 10,
    backgroundColor: Colors.ink,
    borderTopWidth: 1,
    borderTopColor: Colors.line,
  },
  composerWide: { paddingHorizontal: 24, paddingTop: 14 },
  field: {
    flex: 1,
    minHeight: 46,
    maxHeight: 140,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 4,
    borderRadius: 23,
    backgroundColor: Colors.raised,
    borderWidth: 1,
    borderColor: Colors.line,
  },
  input: {
    flex: 1,
    minWidth: 0,
    maxHeight: 130,
    paddingVertical: Platform.OS === 'ios' ? 13 : 10,
    fontFamily: Fonts.body,
    fontSize: 16,
    color: Colors.cream,
    outlineStyle: 'none',
  } as any,
  attachGrid: { flexDirection: 'row', gap: 10, paddingVertical: 6 },
  attachItem: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  attachIcon: { width: 58, height: 58, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  sheetNote: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' },
  reactRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  reactBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.line,
  },
  noChat: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  noChatIcon: {
    width: 84,
    height: 84,
    borderRadius: 28,
    backgroundColor: Colors.brassTint,
    borderWidth: 1,
    borderColor: 'rgba(214,166,87,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
});

