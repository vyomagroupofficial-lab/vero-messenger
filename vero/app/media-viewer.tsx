import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  Dimensions,
  Alert,
  StatusBar,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Typography, Spacing, BorderRadius } from '../src/shared/theme/theme';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView } from 'expo-video';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

function VideoContent({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.play();
  });
  return <VideoView player={player} style={styles.image} nativeControls contentFit="contain" />;
}

export default function MediaViewerScreen() {
  const { uri, type, name, caption } = useLocalSearchParams<{
    uri: string;
    type?: string;
    name?: string;
    caption?: string;
  }>();

  const [showControls, setShowControls] = useState(true);
  const isVideo = type === 'video';

  const handleShare = async () => {
    if (!uri) return;
    if (!(await Sharing.isAvailableAsync())) {
      Alert.alert('Sharing unavailable', 'Sharing is not supported on this device.');
      return;
    }
    // Shares the decrypted local copy; whatever app you pick will see the plaintext.
    await Sharing.shareAsync(uri);
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />

      {/* Media Canvas */}
      <TouchableOpacity
        style={styles.mediaContainer}
        activeOpacity={1}
        onPress={() => setShowControls(!showControls)}
      >
        {uri && isVideo ? (
          <VideoContent uri={uri} />
        ) : uri ? (
          <Image
            source={{ uri }}
            style={styles.image}
            resizeMode="contain"
          />
        ) : (
          <View style={styles.placeholder}>
            <View style={styles.placeholderIconHalo}>
              <Ionicons
                name={type === 'video' ? 'videocam' : 'image'}
                size={48}
                color={Colors.accent}
              />
            </View>
            <Text style={styles.placeholderText}>Nothing to show</Text>
            <Text style={styles.placeholderSub}>The file could not be opened.</Text>
          </View>
        )}
      </TouchableOpacity>

      {/* Floating Frosted Overlay Controls */}
      {showControls && (
        <SafeAreaView style={styles.overlay} edges={['top', 'bottom']}>
          {/* Top Bar */}
          <View style={styles.topBar}>
            <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()} activeOpacity={0.7}>
              <Ionicons name="arrow-back" size={20} color={Colors.white} />
            </TouchableOpacity>

            <View style={styles.mediaInfo}>
              <Text style={styles.mediaTitle} numberOfLines={1}>
                {name || (isVideo ? 'Video' : 'Photo')}
              </Text>
              <View style={styles.securityRow}>
                <Ionicons name="lock-closed" size={10} color={Colors.online} />
                <Text style={styles.securityLabel}>Decrypted on this device</Text>
              </View>
            </View>

            <View style={styles.actions}>
              <TouchableOpacity style={styles.iconBtn} onPress={handleShare} activeOpacity={0.7}>
                <Ionicons name="share-outline" size={20} color={Colors.white} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Bottom Bar / Metadata */}
          <View style={styles.bottomBar}>
            {caption ? (
              <View style={styles.captionContainer}>
                <Text style={styles.captionText}>{caption}</Text>
              </View>
            ) : null}
            <View style={styles.metaBadge}>
              <Ionicons name="shield-checkmark" size={13} color={Colors.online} />
              <Text style={styles.metaBadgeText}>
                Stored in the cloud only as ciphertext (XChaCha20-Poly1305)
              </Text>
            </View>
          </View>
        </SafeAreaView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#020408',
  },
  mediaContainer: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
  },
  placeholder: {
    alignItems: 'center',
    gap: Spacing.sm,
  },
  placeholderIconHalo: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(6, 182, 212, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.3)',
    marginBottom: Spacing.xs,
  },
  placeholderText: {
    color: Colors.textPrimary,
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
  },
  placeholderSub: {
    color: Colors.textTertiary,
    fontSize: Typography.xs,
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'space-between',
    pointerEvents: 'box-none',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    backgroundColor: 'rgba(5, 10, 20, 0.88)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(6, 182, 212, 0.15)',
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  mediaInfo: {
    flex: 1,
    paddingHorizontal: Spacing.md,
  },
  mediaTitle: {
    color: Colors.white,
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
  },
  securityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  securityLabel: {
    color: Colors.accent,
    fontSize: 10,
    fontWeight: Typography.medium,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  bottomBar: {
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    backgroundColor: 'rgba(5, 10, 20, 0.88)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(6, 182, 212, 0.15)',
    gap: Spacing.xs,
  },
  captionContainer: {
    paddingVertical: 2,
  },
  captionText: {
    color: Colors.white,
    fontSize: Typography.sm,
  },
  metaBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    justifyContent: 'center',
  },
  metaBadgeText: {
    color: Colors.textSecondary,
    fontSize: 10.5,
    letterSpacing: 0.2,
  },
});

