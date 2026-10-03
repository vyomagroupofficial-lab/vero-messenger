import React, { useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { authRepository } from '../../src/features/auth/AuthRepository';
import { isSupabaseConfigured } from '../../src/core/network/supabase';
import { AuthShell, Point } from '../../src/features/auth/AuthShell';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Button, Icon, Pressy, TextField, notify, useShake } from '../../src/shared/ui';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginScreen() {
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
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
      setEmailError(t('auth.errEmailRequired'));
      ok = false;
    } else if (!EMAIL_RE.test(email.trim())) {
      setEmailError(t('auth.errEmailInvalid'));
      ok = false;
    }
    if (!password) {
      setPasswordError(t('auth.errPasswordRequired'));
      ok = false;
    } else if (password.length < 6) {
      setPasswordError(t('auth.errPasswordShort', { count: 6 }));
      ok = false;
    }
    return ok;
  };

  const handleLogin = async () => {
    if (!isSupabaseConfigured) {
      notify(t('auth.notConfigured'), t('auth.notConfiguredBody'));
      return;
    }
    if (!validate()) {
      shake();
      return;
    }
    const result = await login(email.trim(), password);
    if (!result.success) {
      shake();
      notify(t('auth.signInFailed'), result.error || t('auth.signInFailedBody'));
    } else {
      router.replace('/(tabs)/chats');
    }
  };

  const handleForgot = async () => {
    if (!EMAIL_RE.test(email.trim())) {
      setEmailError(t('auth.errEmailFirst'));
      shake();
      return;
    }
    const res = await authRepository.sendPasswordReset(email);
    if (res.success) notify(t('auth.resetSent'), t('auth.resetSentBody', { email: email.trim() }));
    else notify(t('auth.resetFailed'), res.error);
  };

  const handleDemo = () => {
    loginAsDemo();
    router.replace('/(tabs)/chats');
  };

  return (
    <AuthShell
      headline={t('auth.headline')}
      panel={
        <View style={{ gap: 22 }}>
          <Point index={0} icon="lock" title={t('auth.point1Title')} body={t('auth.point1Body')} />
          <Point index={1} icon="shieldCheck" title={t('auth.point2Title')} body={t('auth.point2Body')} />
          <Point index={2} icon="devices" title={t('auth.point3Title')} body={t('auth.point3Body')} />
        </View>
      }
    >
      <Animated.View style={[{ gap: 18 }, shakeStyle]}>
        <Animated.View entering={FadeInDown.duration(500)} style={{ gap: 6, marginBottom: 4 }}>
          <Text style={[type.title, { fontSize: 34 }]} accessibilityRole="header">
            {t('auth.welcome')}
          </Text>
          <Text style={type.bodyMuted}>{t('auth.welcomeSub')}</Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(60).duration(500)}>
          <TextField
            label={t('auth.email')}
            icon="mail"
            placeholder={t('auth.emailPlaceholder')}
            value={email}
            onChangeText={(v) => {
              setEmail(v);
              setEmailError('');
            }}
            error={emailError}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType="next"
          />
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(120).duration(500)} style={{ gap: 8 }}>
          <TextField
            label={t('auth.password')}
            icon="lock"
            placeholder={t('auth.passwordPlaceholder')}
            value={password}
            onChangeText={(v) => {
              setPassword(v);
              setPasswordError('');
            }}
            error={passwordError}
            secureTextEntry={!showPassword}
            autoComplete="password"
            textContentType="password"
            returnKeyType="done"
            onSubmitEditing={handleLogin}
            right={
              <Pressy onPress={() => setShowPassword((v) => !v)} accessibilityLabel={showPassword ? t('auth.hidePassword') : t('auth.showPassword')} style={s.eye}>
                <Icon name={showPassword ? 'eyeOff' : 'eye'} size={19} color={c.faint} />
              </Pressy>
            }
          />
          <Pressy onPress={handleForgot} style={{ alignSelf: 'flex-end' }} accessibilityRole="link">
            <Text style={s.link}>{t('auth.forgot')}</Text>
          </Pressy>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(180).duration(500)} style={{ gap: 14 }}>
          <Button label={t('auth.signIn')} iconRight="arrowRight" onPress={handleLogin} loading={isLoading} />
          <View style={s.or}>
            <View style={s.orLine} />
            <Text style={type.small}>{t('common.or')}</Text>
            <View style={s.orLine} />
          </View>
          <Button label={t('auth.tryDemo')} icon="chat" variant="secondary" onPress={handleDemo} disabled={isLoading} />
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(240).duration(500)} style={s.footer}>
          <Text style={type.bodyMuted}>{t('auth.newHere')}</Text>
          <Pressy onPress={() => router.push('/(auth)/signup')} accessibilityRole="link">
            <Text style={[s.link, { fontSize: 14.5 }]}>{t('auth.createAccount')}</Text>
          </Pressy>
        </Animated.View>
      </Animated.View>
    </AuthShell>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  eye: { width: 44, height: 44, marginRight: -10, alignItems: 'center', justifyContent: 'center' },
  link: { fontFamily: f.semibold, fontSize: 13.5, color: c.accentText },
  or: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  orLine: { flex: 1, height: 1, backgroundColor: c.line },
  footer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 6 },
}));
