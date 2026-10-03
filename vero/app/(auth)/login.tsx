import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Animated,
  ScrollView,
  Dimensions,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { Colors, Typography, Spacing, BorderRadius } from '../../src/shared/theme/theme';
import { Ionicons } from '@expo/vector-icons';

const { width } = Dimensions.get('window');

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');

  const { login, loginAsDemo, isLoading } = useAuthStore();

  const handleDemoLogin = async () => {
    await loginAsDemo();
    router.replace('/(tabs)/chats');
  };

  const shakeAnim = useRef(new Animated.Value(0)).current;

  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const validateForm = () => {
    let valid = true;
    setEmailError('');
    setPasswordError('');

    if (!email.trim()) {
      setEmailError('Email is required');
      valid = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailError('Enter a valid email address');
      valid = false;
    }

    if (!password) {
      setPasswordError('Password is required');
      valid = false;
    } else if (password.length < 6) {
      setPasswordError('Password must be at least 6 characters');
      valid = false;
    }

    return valid;
  };

  const handleLogin = async () => {
    if (!validateForm()) {
      shake();
      return;
    }

    const result = await login(email.trim(), password);
    if (!result.success) {
      shake();
      Alert.alert('Authentication Failed', result.error || 'Invalid cryptographic credentials');
    } else {
      router.replace('/(tabs)/chats');
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Cyber Hero Branding */}
        <View style={styles.header}>
          <View style={styles.logoHalo}>
            <View style={styles.logoContainer}>
              <Ionicons name="shield-checkmark" size={38} color={Colors.accent} />
            </View>
          </View>
          <Text style={styles.appName}>VERO</Text>
          <View style={styles.cryptoBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.cryptoBadgeText}>ZERO-KNOWLEDGE PROTOCOL</Text>
          </View>
          <Text style={styles.tagline}>Provably Private • Ephemeral by Design</Text>
        </View>

        {/* Glassmorphic Form Card */}
        <Animated.View style={[styles.form, { transform: [{ translateX: shakeAnim }] }]}>
          <Text style={styles.welcomeTitle}>Sign In</Text>
          <Text style={styles.welcomeSubtitle}>Unlock your local encrypted vault</Text>

          {/* Email Input */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>EMAIL ADDRESS</Text>
            <View
              style={[
                styles.inputWrapper,
                emailFocused && styles.inputWrapperFocused,
                emailError ? styles.inputError : null,
              ]}
            >
              <Ionicons
                name="mail-outline"
                size={19}
                color={emailFocused ? Colors.accent : Colors.textSecondary}
                style={styles.inputIcon}
              />
              <TextInput
                style={styles.input}
                placeholder="alice@vero.internal"
                placeholderTextColor={Colors.textTertiary}
                value={email}
                onChangeText={(t) => { setEmail(t); setEmailError(''); }}
                onFocus={() => setEmailFocused(true)}
                onBlur={() => setEmailFocused(false)}
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
                returnKeyType="next"
              />
            </View>
            {emailError ? <Text style={styles.errorText}>{emailError}</Text> : null}
          </View>

          {/* Password Input */}
          <View style={styles.inputGroup}>
            <View style={styles.passwordLabelRow}>
              <Text style={styles.inputLabel}>MASTER PASSPHRASE</Text>
              <TouchableOpacity>
                <Text style={styles.forgotPasswordText}>Recover vault?</Text>
              </TouchableOpacity>
            </View>
            <View
              style={[
                styles.inputWrapper,
                passwordFocused && styles.inputWrapperFocused,
                passwordError ? styles.inputError : null,
              ]}
            >
              <Ionicons
                name="lock-closed-outline"
                size={19}
                color={passwordFocused ? Colors.accent : Colors.textSecondary}
                style={styles.inputIcon}
              />
              <TextInput
                style={styles.input}
                placeholder="••••••••••••"
                placeholderTextColor={Colors.textTertiary}
                value={password}
                onChangeText={(t) => { setPassword(t); setPasswordError(''); }}
                onFocus={() => setPasswordFocused(true)}
                onBlur={() => setPasswordFocused(false)}
                secureTextEntry={!showPassword}
                autoComplete="password"
                returnKeyType="done"
                onSubmitEditing={handleLogin}
              />
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.eyeIcon}>
                <Ionicons
                  name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                  size={19}
                  color={Colors.textSecondary}
                />
              </TouchableOpacity>
            </View>
            {passwordError ? <Text style={styles.errorText}>{passwordError}</Text> : null}
          </View>

          {/* Primary Action Button */}
          <TouchableOpacity
            style={[styles.loginButton, isLoading && styles.loginButtonDisabled]}
            onPress={handleLogin}
            disabled={isLoading}
            activeOpacity={0.88}
          >
            {isLoading ? (
              <ActivityIndicator color={Colors.white} size="small" />
            ) : (
              <View style={styles.btnContent}>
                <Ionicons name="key-outline" size={18} color={Colors.white} style={{ marginRight: 8 }} />
                <Text style={styles.loginButtonText}>Decrypt & Sign In</Text>
              </View>
            )}
          </TouchableOpacity>

          {/* Divider */}
          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR EXPLORE</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Explore Demo Mode Button */}
          <TouchableOpacity
            style={styles.demoButton}
            onPress={handleDemoLogin}
            disabled={isLoading}
            activeOpacity={0.85}
          >
            <Ionicons name="sparkles" size={17} color={Colors.accent} style={{ marginRight: 8 }} />
            <Text style={styles.demoButtonText}>Launch Instant Demo Mode</Text>
          </TouchableOpacity>

          {/* E2EE notice */}
          <View style={styles.e2eeNotice}>
            <Ionicons name="shield-checkmark" size={13} color={Colors.online} />
            <Text style={styles.e2eeText}>Curve25519 & XSalsa20 Encrypted On-Device</Text>
          </View>
        </Animated.View>

        {/* Sign Up Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Need a cryptographic identity?</Text>
          <TouchableOpacity onPress={() => router.push('/(auth)/signup')}>
            <Text style={styles.signUpLink}> Create Identity</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing['2xl'],
    paddingVertical: Spacing['3xl'],
  },
  header: {
    alignItems: 'center',
    marginBottom: Spacing['3xl'],
  },
  logoHalo: {
    padding: 6,
    borderRadius: 36,
    backgroundColor: 'rgba(6, 182, 212, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
    marginBottom: Spacing.md,
  },
  logoContainer: {
    width: 68,
    height: 68,
    borderRadius: 30,
    backgroundColor: '#0A1526',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.4)',
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 18,
    elevation: 8,
  },
  appName: {
    fontSize: 28,
    fontWeight: Typography.extrabold,
    color: Colors.textPrimary,
    letterSpacing: 6,
    marginBottom: Spacing.xs,
  },
  cryptoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(6, 182, 212, 0.12)',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.3)',
    marginBottom: Spacing.xs,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.online,
  },
  cryptoBadgeText: {
    fontSize: 10,
    fontWeight: Typography.bold,
    color: Colors.accent,
    letterSpacing: 0.8,
  },
  tagline: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
    letterSpacing: 0.3,
  },
  form: {
    backgroundColor: '#080E1A',
    borderRadius: BorderRadius['2xl'],
    padding: Spacing['2xl'],
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.2)',
    marginBottom: Spacing.xl,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
  },
  welcomeTitle: {
    fontSize: Typography['2xl'],
    fontWeight: Typography.bold,
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  welcomeSubtitle: {
    fontSize: Typography.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.xl,
  },
  inputGroup: {
    marginBottom: Spacing.base,
  },
  passwordLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: Typography.bold,
    color: Colors.textSecondary,
    letterSpacing: 0.8,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#040711',
    borderRadius: BorderRadius.lg,
    borderWidth: 1.5,
    borderColor: '#1E293B',
    paddingHorizontal: Spacing.md,
    height: 50,
  },
  inputWrapperFocused: {
    borderColor: Colors.accent,
    backgroundColor: '#070D1E',
  },
  inputError: {
    borderColor: Colors.error,
  },
  inputIcon: {
    marginRight: Spacing.sm,
  },
  input: {
    flex: 1,
    color: Colors.textPrimary,
    fontSize: Typography.base,
    height: '100%',
  },
  eyeIcon: {
    padding: Spacing.xs,
  },
  errorText: {
    fontSize: Typography.xs,
    color: Colors.error,
    marginTop: Spacing.xs,
    marginLeft: Spacing.xs,
  },
  forgotPasswordText: {
    fontSize: Typography.xs,
    color: Colors.accent,
    fontWeight: Typography.medium,
  },
  loginButton: {
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.lg,
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.45,
    shadowRadius: 14,
    elevation: 8,
    marginTop: Spacing.xs,
  },
  btnContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  loginButtonDisabled: {
    opacity: 0.65,
  },
  loginButtonText: {
    color: Colors.white,
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    letterSpacing: 0.5,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: Spacing.base,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#1E293B',
  },
  dividerText: {
    fontSize: 10,
    fontWeight: Typography.bold,
    color: Colors.textTertiary,
    paddingHorizontal: Spacing.md,
    letterSpacing: 0.8,
  },
  demoButton: {
    backgroundColor: 'rgba(6, 182, 212, 0.08)',
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.35)',
    height: 48,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  demoButtonText: {
    color: Colors.accentLight,
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    letterSpacing: 0.3,
  },
  e2eeNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: Spacing.base,
  },
  e2eeText: {
    fontSize: 11,
    color: Colors.textTertiary,
    letterSpacing: 0.2,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  footerText: {
    fontSize: Typography.sm,
    color: Colors.textSecondary,
  },
  signUpLink: {
    fontSize: Typography.sm,
    color: Colors.accent,
    fontWeight: Typography.bold,
  },
});

