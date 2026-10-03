import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, StatusBar, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Typography, Spacing, BorderRadius } from '../src/shared/theme/theme';

const { width } = Dimensions.get('window');

export default function SplashScreen() {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.85)).current;
  const pulse1 = useRef(new Animated.Value(0.2)).current;
  const pulse2 = useRef(new Animated.Value(0.1)).current;
  const pulse3 = useRef(new Animated.Value(0.05)).current;

  useEffect(() => {
    // Initial entrance
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 900,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 7,
        tension: 40,
        useNativeDriver: true,
      }),
    ]).start();

    // Concentric pulsing radar waves
    const createPulseLoop = (anim: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, {
            toValue: 0.6,
            duration: 1200,
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: 0.1,
            duration: 1200,
            useNativeDriver: true,
          }),
        ])
      );
    };

    const l1 = createPulseLoop(pulse1, 0);
    const l2 = createPulseLoop(pulse2, 400);
    const l3 = createPulseLoop(pulse3, 800);

    l1.start();
    l2.start();
    l3.start();

    return () => {
      l1.stop();
      l2.stop();
      l3.stop();
    };
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#030712" />

      {/* Cyber Background Glow */}
      <View style={styles.ambientGlow} />

      <Animated.View
        style={[
          styles.content,
          {
            opacity: fadeAnim,
            transform: [{ scale: scaleAnim }],
          },
        ]}
      >
        {/* Concentric Cyber Rings */}
        <View style={styles.radarContainer}>
          <Animated.View style={[styles.pulseRing3, { opacity: pulse3 }]} />
          <Animated.View style={[styles.pulseRing2, { opacity: pulse2 }]} />
          <Animated.View style={[styles.pulseRing1, { opacity: pulse1 }]} />

          <View style={styles.logoHalo}>
            <View style={styles.iconCircle}>
              <Ionicons name="shield-checkmark" size={54} color={Colors.accent} />
            </View>
          </View>
        </View>

        <Text style={styles.appName}>VERO</Text>
        <Text style={styles.tagline}>Private messaging • End-to-end encrypted</Text>

        <View style={styles.protocolBadge}>
          <View style={styles.liveDot} />
          <Text style={styles.protocolText}>LIBSODIUM • X25519 • XCHACHA20-POLY1305</Text>
        </View>
      </Animated.View>

      {/* Footer Zero-Knowledge Assertion */}
      <View style={styles.footer}>
        <Ionicons name="lock-closed" size={13} color={Colors.online} />
        <Text style={styles.footerText}>Your keys never leave your device</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#030712',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  ambientGlow: {
    position: 'absolute',
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: 'rgba(6, 182, 212, 0.06)',
    top: '35%',
  },
  content: {
    alignItems: 'center',
  },
  radarContainer: {
    width: 220,
    height: 220,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    marginBottom: Spacing.xl,
  },
  pulseRing3: {
    position: 'absolute',
    width: 220,
    height: 220,
    borderRadius: 110,
    borderWidth: 1,
    borderColor: Colors.accent,
  },
  pulseRing2: {
    position: 'absolute',
    width: 170,
    height: 170,
    borderRadius: 85,
    borderWidth: 1.5,
    borderColor: Colors.accent,
  },
  pulseRing1: {
    position: 'absolute',
    width: 130,
    height: 130,
    borderRadius: 65,
    borderWidth: 1.5,
    borderColor: Colors.accentLight,
  },
  logoHalo: {
    padding: 8,
    borderRadius: 50,
    backgroundColor: 'rgba(6, 182, 212, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.3)',
  },
  iconCircle: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: '#080E1A',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(6, 182, 212, 0.5)',
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 24,
    elevation: 12,
  },
  appName: {
    fontSize: 34,
    fontWeight: Typography.extrabold,
    color: Colors.white,
    letterSpacing: 8,
    marginBottom: 6,
  },
  tagline: {
    fontSize: Typography.sm,
    color: Colors.textSecondary,
    letterSpacing: 0.5,
    marginBottom: Spacing.lg,
  },
  protocolBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(6, 182, 212, 0.08)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.online,
  },
  protocolText: {
    fontSize: 10,
    fontWeight: Typography.bold,
    color: Colors.accentLight,
    letterSpacing: 0.8,
  },
  footer: {
    position: 'absolute',
    bottom: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.2)',
  },
  footerText: {
    fontSize: Typography.xs,
    color: Colors.online,
    letterSpacing: 0.5,
    fontWeight: Typography.medium,
  },
});

