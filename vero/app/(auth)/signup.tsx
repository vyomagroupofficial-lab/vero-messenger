import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeInDown, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { isSupabaseConfigured } from '../../src/core/network/supabase';
import { AuthShell } from '../../src/features/auth/AuthShell';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Button, Icon, IconButton, Pressy, TextField, notify, useLayout, useShake } from '../../src/shared/ui';

function strengthOf(pw: string) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}

function Segment({ on, color }: { on: boolean; color: string }) {
  const s = useStyles();
  const a = useAnimatedStyle(() => ({ transform: [{ scaleX: withSpring(on ? 1 : 0, { damping: 18, stiffness: 200 }) }] }));
  return (
    <View style={s.seg}>
      <Animated.View style={[s.segFill, { backgroundColor: color, transformOrigin: 'left' } as any, a]} />
    </View>
  );
}

function Step({ n, title, body, active, index }: { n: string; title: string; body: string; active?: boolean; index: number }) {
  const { type } = useTheme();
  const s = useStyles();
  return (
    <Animated.View entering={FadeInDown.delay(150 + index * 100).duration(600)} style={s.step}>
      <View style={[s.stepNum, active ? s.stepActive : s.stepIdle]}>
        <Text style={[s.stepNumText, active && s.stepNumActive]}>{n}</Text>
      </View>
      <View style={{ flex: 1, gap: 3, paddingTop: 6 }}>
        <Text style={type.name}>{title}</Text>
        <Text style={type.bodyMuted}>{body}</Text>
      </View>
    </Animated.View>
  );
}

export default function SignupScreen() {
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
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
  const strengthColor = [c.danger, c.danger, c.accentText, c.success, c.success][strength];

  const set = (key: string, fn: (v: string) => void) => (v: string) => {
    fn(v);
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const validate = () => {
    const e: Record<string, string> = {};
    const name = displayName.trim();
    const user = username.trim();
    if (!name) e.displayName = t('auth.errNameRequired');
    else if (name.length > 64) e.displayName = t('auth.errNameLong', { count: 64 });
    if (!user) e.username = t('auth.errUsernameRequired');
    else if (user.length < 3 || user.length > 30) e.username = t('auth.errUsernameLength');
    else if (!/^[a-zA-Z0-9_]+$/.test(user)) e.username = t('auth.errUsernameChars');
    if (!email.trim()) e.email = t('auth.errEmailRequired');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) e.email = t('auth.errEmailInvalid');
    if (!password) e.password = t('auth.errNewPasswordRequired');
    else if (password.length < 8) e.password = t('auth.errNewPasswordShort', { count: 8 });
    if (!confirmPassword) e.confirmPassword = t('auth.errConfirmRequired');
    else if (password !== confirmPassword) e.confirmPassword = t('auth.errConfirmMismatch');
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSignUp = async () => {
    if (!isSupabaseConfigured) {
      notify(t('auth.notConfigured'), t('auth.notConfiguredBody'));
      return;
    }
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
      notify(t('auth.signupFailed'), result.error || t('auth.signupFailedBody'));
    } else if (result.needsEmailConfirmation) {
      notify(t('auth.confirmEmail'), t('auth.confirmEmailBody', { email: email.trim() }));
      router.replace('/(auth)/login');
    } else {
      router.replace('/(tabs)/chats');
    }
  };

  const eye = (
    <Pressy onPress={() => setShowPassword((v) => !v)} accessibilityLabel={showPassword ? t('auth.hidePassword') : t('auth.showPassword')} style={s.eye}>
      <Icon name={showPassword ? 'eyeOff' : 'eye'} size={19} color={c.faint} />
    </Pressy>
  );

  return (
    <AuthShell
      headline={t('auth.signupHeadline')}
      mobileHeadline={t('auth.signupMobileHeadline')}
      tone="surface"
      topBar={
        <IconButton
          icon="back"
          label={t('auth.backToSignIn')}
          variant="filled"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(auth)/login'))}
        />
      }
      panel={
        <View style={{ gap: 26 }}>
          <Step index={0} n="01" active title={t('auth.step1Title')} body={t('auth.step1Body')} />
          <Step index={1} n="02" title={t('auth.step2Title')} body={t('auth.step2Body')} />
          <Step index={2} n="03" title={t('auth.step3Title')} body={t('auth.step3Body')} />
        </View>
      }
    >
      <Animated.View style={[{ gap: 16 }, shakeStyle]}>
        {isWide ? (
          <Animated.View entering={FadeInDown.duration(500)} style={{ gap: 6, marginBottom: 4 }}>
            <Text style={[type.eyebrow, { color: c.accentText }]}>{t('auth.step', { n: 1, total: 3 })}</Text>
            <Text style={[type.title, { fontSize: 34 }]} accessibilityRole="header">
              {t('auth.signupTitle')}
            </Text>
          </Animated.View>
        ) : (
          <Text style={type.bodyMuted}>{t('auth.signupSub')}</Text>
        )}

        <TextField label={t('auth.displayName')} icon="user" placeholder={t('auth.displayNamePlaceholder')} value={displayName} onChangeText={set('displayName', setDisplayName)} error={errors.displayName} autoCapitalize="words" textContentType="name" />
        <TextField label={t('auth.username')} icon="at" placeholder={t('auth.usernamePlaceholder')} value={username} onChangeText={set('username', setUsername)} error={errors.username} autoCapitalize="none" textContentType="username" />
        <TextField label={t('auth.email')} icon="mail" placeholder={t('auth.emailPlaceholder')} value={email} onChangeText={set('email', setEmail)} error={errors.email} autoCapitalize="none" keyboardType="email-address" textContentType="emailAddress" />
        <View style={{ gap: 8 }}>
          <TextField
            label={t('auth.password')}
            icon="lock"
            placeholder={t('auth.newPasswordPlaceholder')}
            value={password}
            onChangeText={set('password', setPassword)}
            error={errors.password}
            secureTextEntry={!showPassword}
            textContentType="newPassword"
            right={eye}
          />
          {password.length > 0 && (
            <Animated.View entering={FadeInDown.duration(250)} style={{ gap: 6 }} accessibilityLiveRegion="polite">
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {[1, 2, 3, 4].map((i) => (
                  <Segment key={i} on={strength >= i} color={strengthColor} />
                ))}
              </View>
              <Text style={[type.caption, { color: strengthColor }]}>{t(`auth.strength${strength}`)}</Text>
            </Animated.View>
          )}
        </View>
        <TextField
          label={t('auth.confirmPassword')}
          icon="shieldCheck"
          placeholder={t('auth.confirmPlaceholder')}
          value={confirmPassword}
          onChangeText={set('confirmPassword', setConfirmPassword)}
          error={errors.confirmPassword}
          secureTextEntry={!showPassword}
          textContentType="newPassword"
          onSubmitEditing={handleSignUp}
        />

        <View style={s.note}>
          <Icon name="key" size={18} color={c.success} />
          <Text style={[type.caption, { flex: 1, color: c.successInk }]}>{t('auth.keysNote')}</Text>
        </View>

        <Button label={t('auth.create')} iconRight="arrowRight" onPress={handleSignUp} loading={isLoading} />

        <View style={s.footer}>
          <Text style={type.bodyMuted}>{t('auth.haveAccount')}</Text>
          <Pressy onPress={() => router.replace('/(auth)/login')} accessibilityRole="link">
            <Text style={s.link}>{t('auth.signIn')}</Text>
          </Pressy>
        </View>
      </Animated.View>
    </AuthShell>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  eye: { width: 44, height: 44, marginRight: -10, alignItems: 'center', justifyContent: 'center' },
  seg: { flex: 1, height: 5, borderRadius: 3, backgroundColor: c.field, overflow: 'hidden' },
  segFill: { height: '100%', borderRadius: 3 },
  note: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: 16, backgroundColor: c.successTint },
  link: { fontFamily: f.semibold, fontSize: 14.5, color: c.accentText },
  footer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 4 },
  step: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  stepNum: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  stepActive: { backgroundColor: c.accent },
  stepIdle: { backgroundColor: c.raised, borderWidth: 1, borderColor: c.line2 },
  stepNumText: { fontFamily: f.monoMedium, fontSize: 13, color: c.text },
  stepNumActive: { color: c.onAccent },
}));
