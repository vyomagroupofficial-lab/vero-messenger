import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { AuthShell } from '../../src/features/auth/AuthShell';
import { Colors, Fonts, Type } from '../../src/shared/theme/theme';
import { Button, Icon, IconButton, Pressy, TextField, notify, useLayout, useShake } from '../../src/shared/ui';

function strengthOf(pw: string) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}
const STRENGTH = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'];
const STRENGTH_COLOR = [Colors.ember, Colors.ember, Colors.brassLight, Colors.sage, Colors.sage];

function Segment({ on, color }: { on: boolean; color: string }) {
  const a = useAnimatedStyle(() => ({ transform: [{ scaleX: withSpring(on ? 1 : 0, { damping: 18, stiffness: 200 }) }] }));
  return (
    <View style={styles.seg}>
      <Animated.View style={[styles.segFill, { backgroundColor: color, transformOrigin: 'left' } as any, a]} />
    </View>
  );
}

function Step({ n, title, body, active, index }: { n: string; title: string; body: string; active?: boolean; index: number }) {
  return (
    <Animated.View entering={FadeInDown.delay(150 + index * 100).duration(600)} style={styles.step}>
      <View style={[styles.stepNum, active ? { backgroundColor: Colors.brass } : styles.stepIdle]}>
        <Text style={[styles.stepNumText, active && { color: Colors.brassInk }]}>{n}</Text>
      </View>
      <View style={{ flex: 1, gap: 3, paddingTop: 6 }}>
        <Text style={[Type.name, { fontSize: 16 }]}>{title}</Text>
        <Text style={[Type.bodyMuted, { fontSize: 14 }]}>{body}</Text>
      </View>
    </Animated.View>
  );
}

export default function SignupScreen() {
  const { isWide } = useLayout();
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { signUp, isLoading } = useAuthStore();
  const { style: shakeStyle, shake } = useShake();
  const strength = useMemo(() => strengthOf(password), [password]);

  const set = (key: string, fn: (v: string) => void) => (v: string) => {
    fn(v);
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!displayName.trim()) e.displayName = 'Add the name people will see';
    else if (displayName.trim().length < 2) e.displayName = 'At least 2 characters';
    if (!username.trim()) e.username = 'Pick a username';
    else if (username.length < 3) e.username = 'At least 3 characters';
    else if (!/^[a-zA-Z0-9_]+$/.test(username)) e.username = 'Letters, numbers and underscores only';
    if (!email.trim()) e.email = 'Enter your email';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = 'That doesn’t look like an email address';
    if (!password) e.password = 'Choose a password';
    else if (password.length < 8) e.password = 'At least 8 characters';
    if (!confirmPassword) e.confirmPassword = 'Type your password again';
    else if (password !== confirmPassword) e.confirmPassword = 'Passwords don’t match';
    setErrors(e);
    return Object.keys(e).length === 0;
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
      notify('Couldn’t create your account', result.error || 'Please try again.');
    } else {
      router.replace('/(tabs)/chats');
    }
  };

  const eye = (
    <Pressy onPress={() => setShowPassword((s) => !s)} accessibilityLabel={showPassword ? 'Hide password' : 'Show password'} style={styles.eye}>
      <Icon name={showPassword ? 'eyeOff' : 'eye'} size={19} color={Colors.faint} />
    </Pressy>
  );

  return (
    <AuthShell
      headline="Three steps to a private inbox."
      mobileHeadline="Create your account"
      panelTone="ink"
      topBar={
        <IconButton icon="back" label="Back to sign in" variant="glass" onPress={() => (router.canGoBack() ? router.back() : router.replace('/(auth)/login'))} />
      }
      panel={
        <View style={{ gap: 26 }}>
          <Step index={0} n="01" active title="Tell us who you are" body="A name your friends will recognise." />
          <Step index={1} n="02" title="Your keys are made on this device" body="They never leave it — not even to us." />
          <Step index={2} n="03" title="Start talking" body="Invite people, make groups, call — all encrypted." />
        </View>
      }
    >
      <Animated.View style={[{ gap: 16 }, shakeStyle]}>
        {isWide && (
          <Animated.View entering={FadeInDown.duration(500)} style={{ gap: 6, marginBottom: 4 }}>
            <Text style={[Type.eyebrow, { color: Colors.brass }]}>STEP 1 OF 3</Text>
            <Text style={[Type.title, { fontSize: 34 }]}>Create your account</Text>
          </Animated.View>
        )}
        {!isWide && <Text style={Type.bodyMuted}>Your encryption keys are made right here, on this device.</Text>}

        <TextField label="Display name" icon="user" placeholder="Your name" value={displayName} onChangeText={set('displayName', setDisplayName)} error={errors.displayName} autoCapitalize="words" />
        <TextField label="Username" icon="at" placeholder="yourname" value={username} onChangeText={set('username', setUsername)} error={errors.username} autoCapitalize="none" />
        <TextField label="Email" icon="mail" placeholder="you@example.com" value={email} onChangeText={set('email', setEmail)} error={errors.email} autoCapitalize="none" keyboardType="email-address" />
        <View style={{ gap: 8 }}>
          <TextField
            label="Password"
            icon="lock"
            placeholder="At least 8 characters"
            value={password}
            onChangeText={set('password', setPassword)}
            error={errors.password}
            secureTextEntry={!showPassword}
            right={eye}
          />
          {password.length > 0 && (
            <Animated.View entering={FadeInDown.duration(250)} style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {[1, 2, 3, 4].map((i) => (
                  <Segment key={i} on={strength >= i} color={STRENGTH_COLOR[strength]} />
                ))}
              </View>
              <Text style={[Type.caption, { color: STRENGTH_COLOR[strength] }]}>{STRENGTH[strength]} password</Text>
            </Animated.View>
          )}
        </View>
        <TextField
          label="Confirm password"
          icon="shieldCheck"
          placeholder="Type it again"
          value={confirmPassword}
          onChangeText={set('confirmPassword', setConfirmPassword)}
          error={errors.confirmPassword}
          secureTextEntry={!showPassword}
          onSubmitEditing={handleSignUp}
        />

        <View style={styles.note}>
          <Icon name="key" size={18} color={Colors.sage} />
          <Text style={[Type.caption, { flex: 1, color: '#B7D3C1', lineHeight: 18 }]}>
            Your keys are created on this device and never leave it. Vero can’t recover your password, so keep it somewhere safe.
          </Text>
        </View>

        <Button label="Create account" iconRight="arrowRight" onPress={handleSignUp} loading={isLoading} />

        <View style={styles.footer}>
          <Text style={Type.bodyMuted}>Already have an account?</Text>
          <Pressy onPress={() => router.replace('/(auth)/login')} accessibilityRole="link">
            <Text style={styles.link}>Sign in</Text>
          </Pressy>
        </View>
      </Animated.View>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  eye: { width: 40, height: 40, marginRight: -8, alignItems: 'center', justifyContent: 'center' },
  seg: { flex: 1, height: 5, borderRadius: 3, backgroundColor: Colors.field, overflow: 'hidden' },
  segFill: { height: '100%', borderRadius: 3 },
  note: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: 16, backgroundColor: Colors.sageTint },
  link: { fontFamily: Fonts.semibold, fontSize: 14.5, color: Colors.brass },
  footer: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 4 },
  step: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  stepNum: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  stepIdle: { backgroundColor: Colors.raised, borderWidth: 1, borderColor: Colors.line2 },
  stepNumText: { fontFamily: Fonts.monoMedium, fontSize: 13, color: Colors.cream },
});
