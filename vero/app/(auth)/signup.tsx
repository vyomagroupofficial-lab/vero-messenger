import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Alert,
  Animated,
} from 'react-native';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { Colors, Typography, Spacing, BorderRadius } from '../../src/shared/theme/theme';
import { Ionicons } from '@expo/vector-icons';

export default function SignupScreen() {
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { signUp, isLoading } = useAuthStore();
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

  const validate = () => {
    const newErrors: Record<string, string> = {};

    if (!displayName.trim()) newErrors.displayName = 'Display name is required';
    else if (displayName.length < 2) newErrors.displayName = 'Must be at least 2 characters';

    if (!username.trim()) newErrors.username = 'Username is required';
    else if (username.length < 3) newErrors.username = 'Must be at least 3 characters';
    else if (!/^[a-zA-Z0-9_]+$/.test(username)) newErrors.username = 'Only alphanumeric characters & underscores';

    if (!email.trim()) newErrors.email = 'Email address is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) newErrors.email = 'Enter a valid email address';

    if (!password) newErrors.password = 'Master passphrase is required';
    else if (password.length < 8) newErrors.password = 'Minimum 8 characters required';

    if (!confirmPassword) newErrors.confirmPassword = 'Confirmation required';
    else if (password !== confirmPassword) newErrors.confirmPassword = 'Passphrases do not match';

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSignUp = async () => {
    if (!validate()) {
      shake();
      return;
    }

    const result = await signUp({
      email: email.trim(),
      password,
      username: username.trim().toLowerCase(),
      displayName: displayName.trim(),
    });

    if (!result.success) {
      shake();
      Alert.alert('Registration Failed', result.error || 'Failed to create cryptographic identity');
    } else {
      router.replace('/(tabs)/chats');
    }
  };

  const renderField = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    options: {
      placeholder: string;
      icon: keyof typeof Ionicons.glyphMap;
      secure?: boolean;
      keyboardType?: 'default' | 'email-address';
      autoCapitalize?: 'none' | 'words';
      fieldKey: string;
      suffix?: React.ReactNode;
    }
  ) => {
    const isFocused = focusedField === options.fieldKey;
    const hasError = !!errors[options.fieldKey];

    return (
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>{label}</Text>
        <View
          style={[
            styles.inputWrapper,
            isFocused && styles.inputWrapperFocused,
            hasError ? styles.inputError : null,
          ]}
        >
          <Ionicons
            name={options.icon}
            size={18}
            color={isFocused ? Colors.accent : Colors.textSecondary}
            style={styles.inputIcon}
          />
          <TextInput
            style={styles.input}
            placeholder={options.placeholder}
            placeholderTextColor={Colors.textTertiary}
            value={value}
            onChangeText={(t) => {
              onChange(t);
              setErrors((e) => ({ ...e, [options.fieldKey]: '' }));
            }}
            onFocus={() => setFocusedField(options.fieldKey)}
            onBlur={() => setFocusedField(null)}
            secureTextEntry={options.secure && !showPassword}
            keyboardType={options.keyboardType}
            autoCapitalize={options.autoCapitalize || 'none'}
          />
          {options.suffix}
        </View>
        {hasError ? (
          <Text style={styles.errorText}>{errors[options.fieldKey]}</Text>
        ) : null}
      </View>
    );
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
        {/* Top Back Action */}
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={20} color={Colors.textPrimary} />
        </TouchableOpacity>

        {/* Hero Header */}
        <View style={styles.header}>
          <View style={styles.logoHalo}>
            <View style={styles.logoContainer}>
              <Ionicons name="key-outline" size={32} color={Colors.accent} />
            </View>
          </View>
          <Text style={styles.title}>Create Identity</Text>
          <Text style={styles.subtitle}>Client-side derived keys • Zero plaintext</Text>
        </View>

        {/* Form Container */}
        <Animated.View style={[styles.form, { transform: [{ translateX: shakeAnim }] }]}>
          {renderField('DISPLAY NAME', displayName, setDisplayName, {
            placeholder: 'Alex Rivera',
            icon: 'person-outline',
            autoCapitalize: 'words',
            fieldKey: 'displayName',
          })}

          {renderField('USERNAME', username, setUsername, {
            placeholder: 'alex_r',
            icon: 'at-outline',
            fieldKey: 'username',
          })}

          {renderField('EMAIL ADDRESS', email, setEmail, {
            placeholder: 'alex@example.com',
            icon: 'mail-outline',
            keyboardType: 'email-address',
            fieldKey: 'email',
          })}

          {renderField('MASTER PASSPHRASE', password, setPassword, {
            placeholder: 'Minimum 8 characters',
            icon: 'lock-closed-outline',
            secure: true,
            fieldKey: 'password',
            suffix: (
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.eyeIcon}>
                <Ionicons
                  name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                  size={19}
                  color={Colors.textSecondary}
                />
              </TouchableOpacity>
            ),
          })}

          {renderField('CONFIRM PASSPHRASE', confirmPassword, setConfirmPassword, {
            placeholder: 'Re-enter passphrase',
            icon: 'shield-checkmark-outline',
            secure: true,
            fieldKey: 'confirmPassword',
          })}

          {/* Cryptographic notice */}
          <View style={styles.privacyNotice}>
            <Ionicons name="shield-checkmark" size={18} color={Colors.online} />
            <Text style={styles.privacyText}>
              Your Curve25519 identity keypair is generated directly on this device. Vero never holds your private keys.
            </Text>
          </View>

          {/* Submit */}
          <TouchableOpacity
            style={[styles.signupButton, isLoading && styles.buttonDisabled]}
            onPress={handleSignUp}
            disabled={isLoading}
            activeOpacity={0.88}
          >
            {isLoading ? (
              <ActivityIndicator color={Colors.white} size="small" />
            ) : (
              <View style={styles.btnContent}>
                <Ionicons name="finger-print-outline" size={19} color={Colors.white} style={{ marginRight: 8 }} />
                <Text style={styles.signupButtonText}>Generate Keys & Register</Text>
              </View>
            )}
          </TouchableOpacity>
        </Animated.View>

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Already have an encrypted vault?</Text>
          <TouchableOpacity onPress={() => router.push('/(auth)/login')}>
            <Text style={styles.loginLink}> Sign In</Text>
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
    paddingHorizontal: Spacing['2xl'],
    paddingVertical: Spacing.xl,
  },
  backButton: {
    marginBottom: Spacing.md,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#080E1A',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
  },
  header: {
    alignItems: 'center',
    marginBottom: Spacing.xl,
  },
  logoHalo: {
    padding: 5,
    borderRadius: 30,
    backgroundColor: 'rgba(6, 182, 212, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
    marginBottom: Spacing.sm,
  },
  logoContainer: {
    width: 58,
    height: 58,
    borderRadius: 24,
    backgroundColor: '#0A1526',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.35)',
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 15,
  },
  title: {
    fontSize: Typography['2xl'],
    fontWeight: Typography.bold,
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
    letterSpacing: 0.4,
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
  inputGroup: {
    marginBottom: Spacing.md,
  },
  inputLabel: {
    fontSize: 10.5,
    fontWeight: Typography.bold,
    color: Colors.textSecondary,
    marginBottom: 5,
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
    height: 48,
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
    fontSize: Typography.sm,
    height: '100%',
  },
  eyeIcon: {
    padding: Spacing.xs,
  },
  errorText: {
    fontSize: Typography.xs,
    color: Colors.error,
    marginTop: 3,
    marginLeft: Spacing.xs,
  },
  privacyNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    marginVertical: Spacing.base,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.25)',
    gap: Spacing.sm,
  },
  privacyText: {
    flex: 1,
    fontSize: 11,
    color: Colors.textSecondary,
    lineHeight: 16,
  },
  signupButton: {
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
  buttonDisabled: {
    opacity: 0.65,
  },
  signupButtonText: {
    color: Colors.white,
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    letterSpacing: 0.4,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: Spacing.lg,
  },
  footerText: {
    fontSize: Typography.sm,
    color: Colors.textSecondary,
  },
  loginLink: {
    fontSize: Typography.sm,
    color: Colors.accent,
    fontWeight: Typography.bold,
  },
});

