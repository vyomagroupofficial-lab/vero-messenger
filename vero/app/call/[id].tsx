import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  StatusBar,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Typography, Spacing, BorderRadius } from '../../src/shared/theme/theme';
import { callService, ActiveCall } from '../../src/features/calls/CallService';

export default function CallScreen() {
  const { id } = useLocalSearchParams<{ id: string; name?: string; type?: string }>();
  const [callState, setCallState] = useState<ActiveCall | null>(callService.getActiveCall());
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<'front' | 'back'>('front');

  // Pulse animation for avatar ring
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const unsubscribe = callService.subscribe((currentCall) => {
      setCallState(currentCall);
      if (!currentCall || currentCall.status === 'ended' || currentCall.status === 'rejected') {
        setTimeout(() => {
          if (router.canGoBack()) {
            router.back();
          } else {
            router.replace('/(tabs)/calls');
          }
        }, 1200);
      }
    });

    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.15,
          duration: 1200,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1200,
          useNativeDriver: true,
        }),
      ])
    ).start();

    return () => {
      unsubscribe();
    };
  }, []);

  const formatDuration = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const remainingSecs = sec % 60;
    return `${mins.toString().padStart(2, '0')}:${remainingSecs.toString().padStart(2, '0')}`;
  };

  const handleEndCall = () => {
    callService.endCall();
  };

  const handleAcceptCall = () => {
    callService.acceptCall();
  };

  const peerName = callState?.peerName || 'Contact';
  const initials = peerName.slice(0, 2).toUpperCase();
  const isIncomingRinging = callState?.status === 'ringing' && !callState?.isInitiator;
  const isConnected = callState?.status === 'connected';

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#050A14" />

      {/* Top Security Banner */}
      <View style={styles.topSecurity}>
        <View style={styles.securityBadge}>
          <Ionicons name="lock-closed" size={13} color={Colors.accent} />
          <Text style={styles.securityText}>End-to-End Encrypted</Text>
        </View>
      </View>

      {/* Center Peer Info */}
      <View style={styles.centerSection}>
        <Animated.View style={[styles.avatarGlow, { transform: [{ scale: pulseAnim }] }]}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
        </Animated.View>

        <Text style={styles.peerName}>{peerName}</Text>

        <Text style={styles.callStatus}>
          {isConnected
            ? formatDuration(callState?.duration || 0)
            : callState?.status === 'ringing'
            ? 'Ringing...'
            : callState?.status === 'calling'
            ? 'Calling...'
            : callState?.status === 'ended'
            ? 'Call Ended'
            : callState?.status === 'rejected'
            ? 'Call Declined'
            : 'Connecting...'}
        </Text>

        {callState?.callType === 'video' && (
          <View style={styles.videoBadge}>
            <Ionicons name="videocam" size={14} color={Colors.textSecondary} />
            <Text style={styles.videoBadgeText}>Encrypted Video Channel</Text>
          </View>
        )}
      </View>

      {/* Controls */}
      <View style={styles.controlsSection}>
        {isIncomingRinging ? (
          /* Incoming Call Actions: Decline or Accept */
          <View style={styles.incomingActions}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.declineBtn]}
              onPress={handleEndCall}
              activeOpacity={0.8}
            >
              <Ionicons name="close" size={32} color={Colors.white} />
              <Text style={styles.btnLabel}>Decline</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionBtn, styles.acceptBtn]}
              onPress={handleAcceptCall}
              activeOpacity={0.8}
            >
              <Ionicons name="call" size={32} color={Colors.white} />
              <Text style={styles.btnLabel}>Accept</Text>
            </TouchableOpacity>
          </View>
        ) : (
          /* In-Call Controls */
          <View style={styles.inCallControls}>
            <View style={styles.controlsRow}>
              {/* Mute */}
              <TouchableOpacity
                style={[styles.controlBtn, isMuted && styles.controlBtnActive]}
                onPress={() => setIsMuted(!isMuted)}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={isMuted ? 'mic-off' : 'mic'}
                  size={24}
                  color={isMuted ? Colors.white : Colors.textPrimary}
                />
              </TouchableOpacity>

              {/* Video toggle */}
              <TouchableOpacity
                style={[styles.controlBtn, isVideoEnabled && styles.controlBtnActive]}
                onPress={() => setIsVideoEnabled(!isVideoEnabled)}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={isVideoEnabled ? 'videocam' : 'videocam-off'}
                  size={24}
                  color={isVideoEnabled ? Colors.white : Colors.textPrimary}
                />
              </TouchableOpacity>

              {/* Camera flip */}
              <TouchableOpacity
                style={styles.controlBtn}
                onPress={() => setCameraFacing(cameraFacing === 'front' ? 'back' : 'front')}
                activeOpacity={0.7}
              >
                <Ionicons name="camera-reverse-outline" size={24} color={Colors.textPrimary} />
              </TouchableOpacity>

              {/* Speaker */}
              <TouchableOpacity
                style={[styles.controlBtn, isSpeakerOn && styles.controlBtnActive]}
                onPress={() => setIsSpeakerOn(!isSpeakerOn)}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={isSpeakerOn ? 'volume-high' : 'volume-medium-outline'}
                  size={24}
                  color={isSpeakerOn ? Colors.white : Colors.textPrimary}
                />
              </TouchableOpacity>
            </View>

            {/* End Call Button */}
            <View style={styles.endCallWrapper}>
              <TouchableOpacity
                style={styles.endCallBtn}
                onPress={handleEndCall}
                activeOpacity={0.8}
              >
                <Ionicons name="call" size={30} color={Colors.white} style={styles.rotatedIcon} />
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050A14',
    justifyContent: 'space-between',
    paddingVertical: Spacing.xl,
  },
  topSecurity: {
    alignItems: 'center',
    marginTop: Spacing.md,
  },
  securityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.glassHighlight,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: `${Colors.accent}40`,
  },
  securityText: {
    color: Colors.accent,
    fontSize: Typography.xs,
    fontWeight: Typography.medium,
    letterSpacing: 0.3,
  },
  centerSection: {
    alignItems: 'center',
    gap: Spacing.md,
  },
  avatarGlow: {
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: 'rgba(6, 182, 212, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(6, 182, 212, 0.4)',
  },
  avatar: {
    width: 114,
    height: 114,
    borderRadius: 57,
    backgroundColor: '#0284C7',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: Colors.accentLight,
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
  },
  avatarText: {
    fontSize: Typography['3xl'],
    fontWeight: Typography.bold,
    color: '#FFF',
  },
  peerName: {
    fontSize: Typography['2xl'],
    fontWeight: Typography.bold,
    color: Colors.textPrimary,
    marginTop: Spacing.sm,
  },
  callStatus: {
    fontSize: Typography.base,
    color: Colors.accent,
    fontWeight: Typography.medium,
  },
  videoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: Spacing.xs,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    borderRadius: BorderRadius.sm,
  },
  videoBadgeText: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
  },
  controlsSection: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xl,
  },
  incomingActions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  actionBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
  },
  declineBtn: {
    backgroundColor: Colors.error,
  },
  acceptBtn: {
    backgroundColor: Colors.online,
  },
  btnLabel: {
    color: Colors.white,
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
  },
  inCallControls: {
    gap: Spacing['2xl'],
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  controlBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  controlBtnActive: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  endCallWrapper: {
    alignItems: 'center',
  },
  endCallBtn: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: Colors.error,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
  },
  rotatedIcon: {
    transform: [{ rotate: '135deg' }],
  },
});
