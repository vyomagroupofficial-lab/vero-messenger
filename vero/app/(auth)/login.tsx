import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { AuthShell, Point } from '../../src/features/auth/AuthShell';
import { Colors, Fonts, Type } from '../../src/shared/theme/theme';
import { Button, Icon, Pressy, TextField, notify, useShake } from '../../src/shared/ui';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const { login, loginAsDemo, isLoading } = useAuthStore();
  const { style: shakeStyle, shake } = useShake();

  const validate = () => {
    let ok = true;
    setEmailError('');
    setPasswordError('');
    if (!email.trim()) {
      setEmailError('Enter your email');
      ok = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailError('That doesn’t look like an email address');
      ok = false;
    }
    if (!password) {
      setPasswordError('Enter your password');
      ok = false;
    } else if (password.length < 6) {
      setPasswordError('Passwords are at least 6 characters');
      ok = false;
    }
    return ok;
  };

  const handleLogin = async () => {
    if (!validate()) {
      shake();
      return;
    }
    const result = await login(email.trim(), password);
    if (!result.success) {
      shake();
      notify('Couldn’t sign in', result.error || 'Check your email and password and try again.');
    } else {
      router.replace('/(tabs)/chats');
    }
  };

  const handleDemo = async () => {
    await loginAsDemo();
    router.replace('/(tabs)/chats');
  };

  return (
    <AuthShell
      headline="Your conversations stay yours."
      panel={
        <View style={{ gap: 22 }}>
          <Point index={0} icon="lock" title="Locked on your device" body="Every message and photo is encrypted before it leaves your phone." />
          <Point index={1} icon="shieldCheck" title="Nothing readable on our servers" body="We deliver your messages — we can’t open them." />
          <Point index={2} icon="devices" title="Phone and desktop, in sync" body="Link a device in seconds with a QR code." />
        </View>
      }
    >
      <Animated.View style={[{ gap: 18 }, shakeStyle]}>
        <Animated.View entering={FadeInDown.duration(500)} style={{ gap: 6, marginBottom: 4 }}>
          <Text style={[Type.title, { fontSize: 34 }]}>Welcome back</Text>
          <Text style={Type.bodyMuted}>Sign in to unlock your chats on this device.</Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(60).duration(500)}>
          <TextField
            label="Email"
            icon="mail"
            placeholder="you@example.com"
            value={email}
            onChangeText={(t) => {
              setEmail(t);
              setEmailError('');
            }}
            error={emailError}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            returnKeyType="next"
          />
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(120).duration(500)} style={{ gap: 8 }}>
          <TextField
            label="Password"
            icon="lock"
            placeholder="Your password"
            value={password}
            onChangeText={(t) => {
              setPassword(t);
              setPasswordError('');
            }}
            error={passwordError}
            secureTextEntry={!showPassword}
            autoComplete="password"
            returnKeyType="done"
            onSubmitEditing={handleLogin}
            right={
              <Pressy onPress={() => setShowPassword((s) => !s)} accessibilityLabel={showPassword ? 'Hide password' : 'Show password'} style={styles.eye}>
                <Icon name={showPassword ? 'eyeOff' : 'eye'} size={19} color={Colors.faint} />
              </Pressy>
            }
          />
          <Pressy
            onPress={() => notify('Reset your password', 'We’ll email you a link. Your chats stay encrypted with your device keys.')}
            style={{ alignSelf: 'flex-end' }}
            accessibilityRole="link"
          >
            <Text style={styles.link}>Forgot password?</Text>
          </Pressy>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(180).duration(500)} style={{ gap: 14 }}>
          <Button label="Sign in" iconRight="arrowRight" onPress={handleLogin} loading={isLoading} />
          <View style={styles.or}>
            <View style={styles.orLine} />
            <Text style={Type.small}>or</Text>
            <View style={styles.orLine} />
          </View>
          <Button label="Try the demo" icon="chat" variant="secondary" onPress={handleDemo} disabled={isLoading} />
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(240).duration(500)} style={styles.footer}>
          <Text style={Type.bodyMuted}>New to Vero?</Text>
          <Pressy onPress={() => router.push('/(auth)/signup')} accessibilityRole="link">
            <Text style={[styles.link, { fontSize: 14.5 }]}>Create an account</Text>
          </Pressy>
        </Animated.View>
      </Animated.View>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  eye: { width: 40, height: 40, marginRight: -8, alignItems: 'center', justifyContent: 'center' },
  link: { fontFamily: Fonts.semibold, fontSize: 13.5, color: Colors.brass },
  or: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  orLine: { flex: 1, height: 1, backgroundColor: Colors.line },
  footer: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 6 },
});
