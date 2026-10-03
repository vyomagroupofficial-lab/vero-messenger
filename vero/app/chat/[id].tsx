import React, { useEffect, useRef, useState, useCallback } from 'react';
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
  Image,
  Alert,
  Clipboard,
  Dimensions,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { useMessagesStore } from '../../src/features/messages/useMessagesStore';
import { messageRepository } from '../../src/features/messages/MessageRepository';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { mediaRepository } from '../../src/features/media/MediaRepository';
import { callService } from '../../src/features/calls/CallService';
import { Message, Conversation, User } from '../../src/shared/models/Message';
import { Colors, Typography, Spacing, BorderRadius } from '../../src/shared/theme/theme';
import dayjs from 'dayjs';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const REACTION_EMOJIS = ['❤️', '😂', '👍', '🔥', '😮', '😢'];

// ──────────────────────────────────────────────────────────────────────────
// Message Bubble Component
// ──────────────────────────────────────────────────────────────────────────

interface MessageBubbleProps {
  message: Message;
  showAvatar: boolean;
  onLongPress: (message: Message) => void;
  onMediaPress: (message: Message) => void;
}

function MessageBubble({ message, showAvatar, onLongPress, onMediaPress }: MessageBubbleProps) {
  const { isOwn, content, messageType, status, createdAt, senderProfile, media, reactions } = message;

  const renderStatusIcon = () => {
    if (!isOwn) return null;
    const iconProps = { size: 14, style: styles.statusIcon };
    switch (status) {
      case 'sending': return <Ionicons name="time-outline" color={Colors.textTertiary} {...iconProps} />;
      case 'sent': return <Ionicons name="checkmark-outline" color={Colors.textTertiary} {...iconProps} />;
      case 'delivered': return <Ionicons name="checkmark-done-outline" color={Colors.textTertiary} {...iconProps} />;
      case 'read': return <Ionicons name="checkmark-done" color={Colors.accentLight} {...iconProps} />;
      default: return null;
    }
  };

  const time = dayjs(createdAt).format('HH:mm');

  return (
    <View style={[styles.bubbleContainer, isOwn ? styles.bubbleContainerOwn : styles.bubbleContainerOther]}>
      {!isOwn && showAvatar && (
        <View style={styles.messageAvatar}>
          <Text style={styles.messageAvatarText}>
            {(senderProfile?.displayName || 'U').slice(0, 1).toUpperCase()}
          </Text>
        </View>
      )}
      {!isOwn && !showAvatar && <View style={styles.avatarPlaceholder} />}

      <Pressable
        onLongPress={() => onLongPress(message)}
        style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}
      >
        {/* Reply preview */}
        {message.replyToMessage && (
          <View style={styles.replyPreview}>
            <View style={styles.replyBar} />
            <Text style={styles.replyText} numberOfLines={1}>
              {message.replyToMessage.content || '[message]'}
            </Text>
          </View>
        )}

        {/* Text message */}
        {messageType === 'text' && (
          <Text style={[styles.messageText, isOwn ? styles.messageTextOwn : styles.messageTextOther]}>
            {content || '🔒'}
          </Text>
        )}

        {/* Image message */}
        {messageType === 'image' && (
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={() => onMediaPress(message)}
            style={styles.mediaBubble}
          >
            {media?.localUri ? (
              <Image source={{ uri: media.localUri }} style={styles.mediaImage} />
            ) : (
              <View style={styles.mediaPlaceholder}>
                <Ionicons name="image" size={32} color={Colors.textSecondary} />
                <Text style={styles.mediaLabel}>Encrypted Photo</Text>
              </View>
            )}
            {content ? <Text style={styles.mediaCaption}>{content}</Text> : null}
          </TouchableOpacity>
        )}

        {/* Video message */}
        {messageType === 'video' && (
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={() => onMediaPress(message)}
            style={styles.mediaBubble}
          >
            <View style={styles.mediaPlaceholder}>
              <Ionicons name="videocam" size={36} color={Colors.accent} />
              <Text style={styles.mediaLabel}>Encrypted Video</Text>
              <View style={styles.playOverlay}>
                <Ionicons name="play" size={24} color={Colors.white} />
              </View>
            </View>
          </TouchableOpacity>
        )}

        {/* Voice message */}
        {(messageType === 'audio' || messageType === 'voice') && (
          <View style={styles.voiceMessage}>
            <TouchableOpacity style={styles.voicePlayBtn}>
              <Ionicons name="play" size={16} color={isOwn ? Colors.white : Colors.accent} />
            </TouchableOpacity>
            <View style={styles.voiceWaveform}>
              {[6, 14, 18, 10, 16, 22, 12, 18, 14, 8, 16, 10, 14, 6].map((h, i) => (
                <View
                  key={i}
                  style={[
                    styles.waveBar,
                    { height: h },
                    isOwn ? styles.waveBarOwn : styles.waveBarOther,
                  ]}
                />
              ))}
            </View>
            <Text style={[styles.voiceDuration, isOwn ? styles.textOwn : styles.textOther]}>
              0:14
            </Text>
          </View>
        )}

        {/* Document message */}
        {messageType === 'document' && (
          <TouchableOpacity
            style={styles.documentContainer}
            onPress={() => onMediaPress(message)}
          >
            <View style={styles.docIconWrapper}>
              <Ionicons name="document-text" size={24} color={Colors.accent} />
            </View>
            <View style={styles.docInfo}>
              <Text style={[styles.docName, isOwn ? styles.messageTextOwn : styles.messageTextOther]}>
                {content || 'Encrypted_Document.pdf'}
              </Text>
              <Text style={styles.docMeta}>Encrypted Blob · tap to view</Text>
            </View>
          </TouchableOpacity>
        )}

        {/* Footer: timestamp + status + disappearing indicator */}
        <View style={styles.bubbleFooter}>
          {message.expiresAt && (
            <Ionicons name="timer-outline" size={11} color={Colors.textTertiary} style={styles.timerIcon} />
          )}
          <Text style={[styles.messageTime, isOwn ? styles.timeOwn : styles.timeOther]}>{time}</Text>
          {renderStatusIcon()}
        </View>

        {/* Reactions row */}
        {reactions && reactions.length > 0 && (
          <View style={styles.reactionsRow}>
            {reactions.map((r, i) => (
              <View key={i} style={styles.reactionChip}>
                <Text style={styles.reactionEmoji}>{r.emoji}</Text>
              </View>
            ))}
          </View>
        )}
      </Pressable>
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Typing Indicator
// ──────────────────────────────────────────────────────────────────────────

function TypingIndicator() {
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const createAnim = (val: Animated.Value, delay: number) =>
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(val, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.timing(val, { toValue: 0.3, duration: 300, useNativeDriver: true }),
      ]);

    Animated.loop(
      Animated.parallel([
        createAnim(dot1, 0),
        createAnim(dot2, 150),
        createAnim(dot3, 300),
      ])
    ).start();
  }, []);

  return (
    <View style={styles.typingContainer}>
      <View style={styles.typingBubble}>
        {[dot1, dot2, dot3].map((dot, i) => (
          <Animated.View key={i} style={[styles.typingDot, { opacity: dot }]} />
        ))}
      </View>
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Chat Screen Main
// ──────────────────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const { id: conversationId } = useLocalSearchParams<{ id: string }>();
  const { user, deviceId } = useAuthStore();
  const {
    conversations,
    loadMessages,
    sendMessage,
    subscribeToConversation,
    unsubscribeFromConversation,
  } = useMessagesStore();

  const [inputText, setInputText] = useState('');
  const [recipientUser, setRecipientUser] = useState<User | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isUploadingMedia, setIsUploadingMedia] = useState(false);

  // Modals
  const [actionMessage, setActionMessage] = useState<Message | null>(null);
  const [showAttachModal, setShowAttachModal] = useState(false);
  const [showMenuModal, setShowMenuModal] = useState(false);
  const [disappearingTimer, setDisappearingTimer] = useState<string>('Off');

  const flatListRef = useRef<FlatList>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const convState = conversations[conversationId || ''];
  const messages = convState?.messages || [];
  const isLoading = convState?.isLoading !== false;
  const isOtherTyping = convState?.isTyping || false;

  useEffect(() => {
    if (!conversationId || !user?.id || !deviceId) return;

    loadMessages(conversationId, user.id, deviceId);
    subscribeToConversation(conversationId, user.id, deviceId);

    conversationRepository.getConversationMembers(conversationId).then((members) => {
      const other = members.find((m) => m.id !== user.id);
      if (other) setRecipientUser(other);
    });

    return () => {
      unsubscribeFromConversation(conversationId);
    };
  }, [conversationId, user?.id, deviceId]);

  const handleSend = async () => {
    if (!inputText.trim() || !conversationId || !recipientUser || isSending) return;

    const text = inputText.trim();
    setInputText('');
    setReplyTo(null);
    setIsSending(true);

    try {
      await sendMessage({
        conversationId,
        plaintext: text,
        recipientUserId: recipientUser.id,
        replyToMessageId: replyTo?.id,
      });
    } finally {
      setIsSending(false);
    }

    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  };

  const handleTyping = (text: string) => {
    setInputText(text);

    if (!isTyping) {
      setIsTyping(true);
      messageRepository.broadcastTyping(conversationId!, user!.id, true);
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      setIsTyping(false);
      messageRepository.broadcastTyping(conversationId!, user!.id, false);
    }, 2000);
  };

  // Calls
  const handleStartCall = async (callType: 'voice' | 'video') => {
    if (!recipientUser || !user) return;
    const callId = await callService.startCall({
      peerId: recipientUser.id,
      peerName: recipientUser.displayName,
      callType,
      currentUserId: user.id,
      currentUserName: user.displayName || 'You',
    });
    router.push(`/call/${callId}` as any);
  };

  // Media Attachment Handling
  const handlePickMedia = async (type: 'camera' | 'gallery' | 'video' | 'doc') => {
    setShowAttachModal(false);
    if (!conversationId || !recipientUser) return;

    let picked = null;
    if (type === 'camera') picked = await mediaRepository.pickFromCamera();
    else if (type === 'gallery') picked = await mediaRepository.pickImage();
    else if (type === 'video') picked = await mediaRepository.pickVideo();
    else if (type === 'doc') picked = await mediaRepository.pickDocument();

    if (!picked) return;

    setIsUploadingMedia(true);
    try {
      const uploadRes = await mediaRepository.uploadMedia(
        picked.uri,
        picked.mimeType,
        conversationId
      );

      const msgType = type === 'video' ? 'video' : type === 'doc' ? 'document' : 'image';

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

  // Voice message simulation
  const handleSendVoiceMessage = async () => {
    if (!conversationId || !recipientUser) return;
    setIsSending(true);
    try {
      await sendMessage({
        conversationId,
        plaintext: 'Encrypted Voice Note',
        messageType: 'voice',
        recipientUserId: recipientUser.id,
      });
    } finally {
      setIsSending(false);
    }
  };

  // Message Actions
  const handleMessageLongPress = (message: Message) => {
    setActionMessage(message);
  };

  const handleReact = async (emoji: string) => {
    if (!actionMessage || !conversationId || !user) return;
    await messageRepository.addReaction(conversationId, actionMessage.id, emoji, user.id);
    setActionMessage(null);
  };

  const handleCopyText = () => {
    if (actionMessage?.content) {
      Clipboard.setString(actionMessage.content);
      Alert.alert('Copied', 'Message copied to clipboard.');
    }
    setActionMessage(null);
  };

  const handleDelete = async (forEveryone: boolean) => {
    if (!actionMessage) return;
    await messageRepository.deleteMessage(actionMessage.id, forEveryone);
    setActionMessage(null);
    if (user && deviceId) {
      loadMessages(conversationId!, user.id, deviceId);
    }
  };

  const handleOpenMedia = (message: Message) => {
    const uri = message.media?.localUri || '';
    router.push({
      pathname: '/media-viewer',
      params: {
        uri,
        type: message.messageType,
        name: message.messageType === 'video' ? 'Video' : 'Photo',
        caption: message.content,
      },
    } as any);
  };

  const displayName = recipientUser?.displayName || 'Loading...';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Top Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.headerInfo}
          onPress={() => {
            if (recipientUser) router.push(`/profile/${recipientUser.id}` as any);
          }}
          activeOpacity={0.7}
        >
          <View style={styles.headerAvatar}>
            <Text style={styles.headerAvatarText}>
              {displayName.slice(0, 1).toUpperCase()}
            </Text>
            <View style={styles.onlineDot} />
          </View>
          <View>
            <Text style={styles.headerName} numberOfLines={1}>{displayName}</Text>
            <TouchableOpacity
              style={styles.headerStatus}
              onPress={() => {
                if (recipientUser) {
                  router.push(`/verify-safety-number?userId=${recipientUser.id}&displayName=${displayName}` as any);
                }
              }}
            >
              <Ionicons name="lock-closed" size={10} color={Colors.accent} />
              <Text style={styles.headerStatusText}>
                {isOtherTyping ? 'typing...' : 'E2EE · Tap to verify'}
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>

        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.headerBtn} onPress={() => handleStartCall('voice')}>
            <Ionicons name="call-outline" size={22} color={Colors.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerBtn} onPress={() => handleStartCall('video')}>
            <Ionicons name="videocam-outline" size={22} color={Colors.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerBtn} onPress={() => setShowMenuModal(true)}>
            <Ionicons name="ellipsis-vertical" size={22} color={Colors.textPrimary} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Disappearing Timer Banner if active */}
      {disappearingTimer !== 'Off' && (
        <View style={styles.disappearingBanner}>
          <Ionicons name="timer-outline" size={13} color={Colors.warning} />
          <Text style={styles.disappearingBannerText}>
            Disappearing messages: {disappearingTimer}
          </Text>
        </View>
      )}

      {/* Uploading Media Indicator */}
      {isUploadingMedia && (
        <View style={styles.uploadProgressBanner}>
          <ActivityIndicator size="small" color={Colors.accent} />
          <Text style={styles.uploadProgressText}>
            Encrypting with AES-GCM & uploading to Google Drive...
          </Text>
        </View>
      )}

      {/* Messages List */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color={Colors.accent} size="large" />
            <Text style={styles.loadingText}>Decrypting messages...</Text>
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={({ item, index }) => {
              const prevMsg = index > 0 ? messages[index - 1] : null;
              const showAvatar = !item.isOwn && (!prevMsg || prevMsg.senderUserId !== item.senderUserId);
              return (
                <MessageBubble
                  message={item}
                  showAvatar={showAvatar}
                  onLongPress={handleMessageLongPress}
                  onMediaPress={handleOpenMedia}
                />
              );
            }}
            ListHeaderComponent={
              <TouchableOpacity
                style={styles.securityAnnouncementBadge}
                activeOpacity={0.8}
                onPress={() => {
                  if (recipientUser) {
                    router.push(`/verify-safety-number?userId=${recipientUser.id}&displayName=${displayName}` as any);
                  }
                }}
              >
                <View style={styles.securityShieldCircle}>
                  <Ionicons name="shield-checkmark" size={15} color={Colors.emerald} />
                </View>
                <Text style={styles.securityAnnouncementText}>
                  Messages and calls are end-to-end encrypted with X25519 & XSalsa20. No one outside of this chat, not even Vero, can read them. Tap to verify safety number.
                </Text>
              </TouchableOpacity>
            }
            contentContainerStyle={styles.messageList}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
            ListFooterComponent={isOtherTyping ? <TypingIndicator /> : null}
          />
        )}

        {/* Quoted Reply Preview */}
        {replyTo && (
          <View style={styles.replyPreviewBar}>
            <View style={styles.replyPreviewContent}>
              <Ionicons name="return-up-forward" size={16} color={Colors.accent} />
              <Text style={styles.replyPreviewText} numberOfLines={1}>
                {replyTo.content || '[message]'}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setReplyTo(null)}>
              <Ionicons name="close" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
        )}

        {/* Input Bar */}
        <View style={styles.inputBar}>
          <TouchableOpacity
            style={styles.attachBtn}
            onPress={() => setShowAttachModal(true)}
          >
            <Ionicons name="add-circle-outline" size={26} color={Colors.accent} />
          </TouchableOpacity>

          <View style={styles.inputWrapper}>
            <TextInput
              style={styles.textInput}
              placeholder="Message..."
              placeholderTextColor={Colors.textTertiary}
              value={inputText}
              onChangeText={handleTyping}
              multiline
              maxLength={5000}
            />
          </View>

          {inputText.trim() ? (
            <TouchableOpacity
              style={[styles.sendBtn, isSending && styles.sendBtnDisabled]}
              onPress={handleSend}
              disabled={isSending}
            >
              {isSending ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <Ionicons name="send" size={18} color={Colors.white} />
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.voiceBtn} onPress={handleSendVoiceMessage}>
              <Ionicons name="mic-outline" size={24} color={Colors.accent} />
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>

      {/* Attachment Options Modal */}
      <Modal
        visible={showAttachModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAttachModal(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setShowAttachModal(false)}>
          <View style={styles.attachSheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Encrypted Attachment</Text>

            <View style={styles.attachGrid}>
              <TouchableOpacity
                style={styles.attachItem}
                onPress={() => handlePickMedia('camera')}
              >
                <View style={[styles.attachIconCircle, { backgroundColor: '#EF4444' }]}>
                  <Ionicons name="camera" size={24} color={Colors.white} />
                </View>
                <Text style={styles.attachLabel}>Camera</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.attachItem}
                onPress={() => handlePickMedia('gallery')}
              >
                <View style={[styles.attachIconCircle, { backgroundColor: '#8B5CF6' }]}>
                  <Ionicons name="image" size={24} color={Colors.white} />
                </View>
                <Text style={styles.attachLabel}>Gallery</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.attachItem}
                onPress={() => handlePickMedia('video')}
              >
                <View style={[styles.attachIconCircle, { backgroundColor: '#10B981' }]}>
                  <Ionicons name="videocam" size={24} color={Colors.white} />
                </View>
                <Text style={styles.attachLabel}>Video</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.attachItem}
                onPress={() => handlePickMedia('doc')}
              >
                <View style={[styles.attachIconCircle, { backgroundColor: '#3B82F6' }]}>
                  <Ionicons name="document-text" size={24} color={Colors.white} />
                </View>
                <Text style={styles.attachLabel}>Document</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* Message Long Press Action Sheet Modal */}
      <Modal
        visible={actionMessage !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setActionMessage(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setActionMessage(null)}>
          <View style={styles.actionSheet}>
            {/* Quick Reactions */}
            <View style={styles.reactionsBar}>
              {REACTION_EMOJIS.map((emoji) => (
                <TouchableOpacity
                  key={emoji}
                  style={styles.reactionBtn}
                  onPress={() => handleReact(emoji)}
                >
                  <Text style={styles.reactionText}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Actions list */}
            <TouchableOpacity
              style={styles.actionRow}
              onPress={() => {
                if (actionMessage) setReplyTo(actionMessage);
                setActionMessage(null);
              }}
            >
              <Ionicons name="return-up-forward" size={20} color={Colors.accent} />
              <Text style={styles.actionText}>Reply</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionRow} onPress={handleCopyText}>
              <Ionicons name="copy-outline" size={20} color={Colors.textPrimary} />
              <Text style={styles.actionText}>Copy Text</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.actionRow} onPress={() => handleDelete(false)}>
              <Ionicons name="trash-outline" size={20} color={Colors.warning} />
              <Text style={[styles.actionText, { color: Colors.warning }]}>Delete for Me</Text>
            </TouchableOpacity>

            {actionMessage?.isOwn && (
              <TouchableOpacity style={styles.actionRow} onPress={() => handleDelete(true)}>
                <Ionicons name="trash" size={20} color={Colors.error} />
                <Text style={[styles.actionText, { color: Colors.error }]}>Delete for Everyone</Text>
              </TouchableOpacity>
            )}
          </View>
        </Pressable>
      </Modal>

      {/* Chat Options Menu Modal */}
      <Modal
        visible={showMenuModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowMenuModal(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setShowMenuModal(false)}>
          <View style={styles.menuSheet}>
            <Text style={styles.menuSheetTitle}>Chat Options</Text>

            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setShowMenuModal(false);
                if (recipientUser) {
                  router.push(`/verify-safety-number?userId=${recipientUser.id}&displayName=${displayName}` as any);
                }
              }}
            >
              <Ionicons name="shield-checkmark-outline" size={20} color={Colors.accent} />
              <Text style={styles.menuItemText}>Verify Safety Number</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                Alert.alert(
                  'Disappearing Messages',
                  'Select a timer for new messages in this chat to disappear after being read:',
                  [
                    { text: 'Off', onPress: () => setDisappearingTimer('Off') },
                    { text: '24 Hours', onPress: () => setDisappearingTimer('24 Hours') },
                    { text: '7 Days', onPress: () => setDisappearingTimer('7 Days') },
                    { text: '90 Days', onPress: () => setDisappearingTimer('90 Days') },
                  ]
                );
                setShowMenuModal(false);
              }}
            >
              <Ionicons name="timer-outline" size={20} color={Colors.warning} />
              <Text style={styles.menuItemText}>
                Disappearing Messages ({disappearingTimer})
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setShowMenuModal(false);
                Alert.alert('Clear Chat', 'Are you sure you want to clear all decrypted messages from this device?', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Clear', style: 'destructive', onPress: () => {} },
                ]);
              }}
            >
              <Ionicons name="trash-outline" size={20} color={Colors.error} />
              <Text style={[styles.menuItemText, { color: Colors.error }]}>Clear Chat</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

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
    maxWidth: SCREEN_WIDTH * 0.76,
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
