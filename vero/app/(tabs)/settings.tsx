import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import dayjs from 'dayjs';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { authRepository } from '../../src/features/auth/AuthRepository';
import { cryptoManager } from '../../src/core/crypto/CryptoManager';
import { databaseService } from '../../src/core/storage/DatabaseService';
import { friendlyError } from '../../src/core/network/supabase';
import { mediaRepository } from '../../src/features/media/MediaRepository';
import { useSettingsStore } from '../../src/features/settings/useSettingsStore';
import { updatePrivacySettings } from '../../src/features/settings/settingsSync';
import { useAppLockStore } from '../../src/features/settings/appLock';
import { useBackupStatus } from '../../src/features/backup/useBackupStore';
import { Palette, dark, light } from '../../src/shared/theme/theme';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { ThemePreference, useAppearance } from '../../src/shared/theme/appearance';
import { LANGUAGES, systemLanguage, useT } from '../../src/shared/i18n';
import {
  Avatar,
  Button,
  Eyebrow,
  Grain,
  Hatch,
  Icon,
  IconButton,
  IconName,
  Pressy,
  Rise,
  Sheet,
  TextField,
  Toggle,
  confirmAction,
  notify,
  useLayout,
} from '../../src/shared/ui';

type Section = 'appearance' | 'privacy' | 'security' | 'extras' | 'storage';
const SECTIONS: { key: Section; icon: IconName }[] = [
  { key: 'appearance', icon: 'moon' },
  { key: 'privacy', icon: 'lock' },
  { key: 'security', icon: 'shieldCheck' },
  { key: 'extras', icon: 'wallet' },
  { key: 'storage', icon: 'database' },
];


// ── Building blocks ─────────────────────────────────────────────────────────

function Row({ icon, label, hint, right, onPress, first, danger }: {
  icon?: IconName;
  label: string;
  hint?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  first?: boolean;
  danger?: boolean;
}) {
  const { c, type } = useTheme();
  const s = useStyles();
  const body = (
    <View style={[s.row, !first && s.rowBorder]}>
      {icon && (
        <View style={[s.rowIcon, danger && { backgroundColor: c.dangerTint }]}>
          <Icon name={icon} size={18} color={danger ? c.danger : c.accentText} />
        </View>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[s.rowLabel, danger && { color: c.danger }]}>{label}</Text>
        {hint ? <Text style={type.caption}>{hint}</Text> : null}
      </View>
      {right ?? (onPress ? <Icon name="forwardChevron" size={18} color={c.faint} /> : null)}
    </View>
  );
  return onPress ? (
    <Pressy onPress={onPress} scaleTo={0.985} accessibilityLabel={label}>
      {body}
    </Pressy>
  ) : (
    body
  );
}

function Card({ title, children, index = 0 }: { title?: string; children: React.ReactNode; index?: number }) {
  const s = useStyles();
  return (
    <Rise index={index} style={{ gap: 8 }}>
      {title ? <Eyebrow style={{ paddingHorizontal: 4 }}>{title}</Eyebrow> : null}
      <View style={s.card}>{children}</View>
    </Rise>
  );
}

/** A miniature chat drawn in a palette — the theme picker's preview. */
function Mini({ p }: { p: Palette }) {
  return (
    <View style={{ flex: 1, backgroundColor: p.bg, padding: 9, gap: 5, justifyContent: 'center' }}>
      <View style={{ alignSelf: 'flex-start', width: '62%', height: 11, borderRadius: 6, backgroundColor: p.theirs }} />
      <View style={{ alignSelf: 'flex-end', width: '54%', height: 11, borderRadius: 6, backgroundColor: p.mine }} />
      <View style={{ alignSelf: 'flex-start', width: '40%', height: 11, borderRadius: 6, backgroundColor: p.theirs }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 }}>
        <View style={{ flex: 1, height: 9, borderRadius: 5, backgroundColor: p.field }} />
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: p.accent }} />
      </View>
    </View>
  );
}

function ThemeTile({ value, label, selected, onPress }: { value: ThemePreference; label: string; selected: boolean; onPress: () => void }) {
  const { c } = useTheme();
  const s = useStyles();
  return (
    <Pressy
      onPress={onPress}
      scaleTo={0.96}
      style={{ flex: 1, gap: 8, alignItems: 'center' }}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
    >
      <View style={[s.tile, selected && { borderColor: c.accent, borderWidth: 2 }]}>
        {value === 'system' ? (
          <View style={{ flex: 1, flexDirection: 'row' }}>
            <View style={{ flex: 1, overflow: 'hidden' }}>
              <View style={{ width: '200%', height: '100%' }}>
                <Mini p={light} />
              </View>
            </View>
            <View style={{ flex: 1, overflow: 'hidden' }}>
              <View style={{ width: '200%', height: '100%', marginLeft: '-100%' }}>
                <Mini p={dark} />
              </View>
            </View>
          </View>
        ) : (
          <Mini p={value === 'light' ? light : dark} />
        )}
        {selected && (
          <Animated.View entering={FadeIn} style={s.tileCheck}>
            <Icon name="check" size={12} color={c.onAccent} strokeWidth={2.6} />
          </Animated.View>
        )}
      </View>
      <Text style={[s.tileLabel, selected && { color: c.text }]}>{label}</Text>
    </Pressy>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { c, type, f } = useTheme();
  const s = useStyles();
  const t = useT();

  const user = useAuthStore((st) => st.user);
  const deviceId = useAuthStore((st) => st.deviceId);
  const isDemo = useAuthStore((st) => st.isDemo);
  const logout = useAuthStore((st) => st.logout);
  const updateProfile = useAuthStore((st) => st.updateProfile);
  const settings = useSettingsStore();
  const appLockOn = useAppLockStore((st) => st.enabled);
  const backup = useBackupStatus(user?.id);
  const themePref = useAppearance((st) => st.theme);
  const langPref = useAppearance((st) => st.language);
  const setTheme = useAppearance((st) => st.setTheme);
  const setLanguage = useAppearance((st) => st.setLanguage);

  const [section, setSection] = useState<Section>('appearance');
  const [showKeys, setShowKeys] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showLanguage, setShowLanguage] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftAbout, setDraftAbout] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user && !isDemo) void cryptoManager.getIdentityPublicKey(user.id).then(setPublicKey);
  }, [user?.id, isDemo]);

  const handleLogout = () =>
    confirmAction({
      title: isDemo ? t('settings.leaveDemo') : t('settings.logout'),
      message: isDemo ? t('settings.leaveDemoBody') : t('settings.logoutBody'),
      confirmLabel: isDemo ? t('settings.leave') : t('settings.logout'),
      destructive: true,
      onConfirm: async () => {
        await logout();
        router.replace('/(auth)/login');
      },
    });

  const handleEraseDevice = () =>
    confirmAction({
      title: t('settings.erase'),
      message: t('settings.eraseBody'),
      confirmLabel: t('settings.eraseConfirm'),
      destructive: true,
      onConfirm: async () => {
        try {
          if (user && deviceId && !isDemo) {
            await authRepository.revokeDevice(deviceId).catch(() => undefined);
            await cryptoManager.clearIdentity(user.id);
          }
          await databaseService.clearAllData();
          mediaRepository.clearCache();
        } finally {
          await logout();
          router.replace('/(auth)/login');
        }
      },
    });

  const handleClearCache = () =>
    confirmAction({
      title: t('settings.clearCache'),
      message: t('settings.clearCacheBody'),
      confirmLabel: t('settings.clear'),
      destructive: true,
      onConfirm: () => {
        try {
          mediaRepository.clearCache();
          notify(t('common.done'), t('settings.cacheCleared'));
        } catch (e) {
          notify(t('settings.cacheFailed'), friendlyError(e));
        }
      },
    });

  const savePrivacy = (patch: Parameters<typeof updatePrivacySettings>[0]) => {
    updatePrivacySettings(patch).catch((e) => notify(t('settings.saveFailed'), friendlyError(e)));
  };

  const openProfileEditor = () => {
    setDraftName(user?.displayName || '');
    setDraftAbout(user?.about || '');
    setShowProfile(true);
  };

  const saveProfile = async () => {
    if (!draftName.trim()) return notify(t('settings.profile.nameRequired'), t('settings.profile.nameRequiredBody'));
    setSaving(true);
    const result = await updateProfile({ displayName: draftName, about: draftAbout });
    setSaving(false);
    if (result.success) setShowProfile(false);
    else notify(t('settings.profile.saveFailed'), result.error);
  };

  const name = user?.displayName || t('settings.setName');
  const currentLanguage = langPref === 'system' ? t('settings.languageSystem') : LANGUAGES.find((l) => l.code === langPref)?.native;
  const detected = LANGUAGES.find((l) => l.code === systemLanguage());

  // ── Section bodies ──

  const appearance = (
    <>
      <Card title={t('settings.theme')} index={0}>
        <View style={{ paddingVertical: 16, gap: 14 }}>
          <Text style={type.caption}>{t('settings.themeHint')}</Text>
          <View style={{ flexDirection: 'row', gap: 12 }} accessibilityRole="radiogroup" accessibilityLabel={t('settings.theme')}>
            {(['system', 'light', 'dark'] as const).map((v) => (
              <ThemeTile key={v} value={v} label={t(`settings.themes.${v}`)} selected={themePref === v} onPress={() => setTheme(v)} />
            ))}
          </View>
        </View>
      </Card>
      <Card title={t('settings.language')} index={1}>
        <Row first icon="globe" label={t('settings.language')} hint={t('settings.languageHint')} onPress={() => setShowLanguage(true)} right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={s.value} numberOfLines={1}>
              {currentLanguage}
            </Text>
            <Icon name="forwardChevron" size={18} color={c.faint} />
          </View>
        } />
      </Card>
    </>
  );

  const privacy = (
    <Card title={t('settings.sections.privacy')} index={0}>
      <Row first icon="checks" label={t('settings.readReceipts')} hint={t('settings.readReceiptsHint')} right={<Toggle label={t('settings.readReceipts')} value={settings.readReceipts} onValueChange={(v) => savePrivacy({ readReceipts: v })} />} />
      <Row icon="edit" label={t('settings.typing')} hint={t('settings.typingHint')} right={<Toggle label={t('settings.typing')} value={settings.typingIndicators} onValueChange={(v) => savePrivacy({ typingIndicators: v })} />} />
      <Row icon="eyeOff" label={t('settings.privacyMore')} hint={t('settings.privacyMoreHint')} onPress={() => router.push('/settings/privacy')} />
      <Row
        icon="fingerprint"
        label={t('settings.appLock')}
        onPress={() => router.push('/settings/privacy')}
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={s.value}>{appLockOn ? t('common.on') : t('common.off')}</Text>
            <Icon name="forwardChevron" size={18} color={c.faint} />
          </View>
        }
      />
      {!isDemo && (
        <Row
          icon="cloudUp"
          label={t('settings.backup')}
          hint={
            backup.methods.length
              ? t('settings.backupOn', { date: backup.lastBackupAt ? dayjs(backup.lastBackupAt).format('D MMM, h:mm A') : t('settings.backupNever') })
              : t('common.off')
          }
          onPress={() => router.push('/backup')}
        />
      )}
    </Card>
  );

  const security = (
    <Card title={t('settings.sections.security')} index={0}>
      {!isDemo && (
        <>
          <Row
            first
            icon="devices"
            label={t('settings.devices')}
            hint={t('settings.devicesHint')}
            onPress={() => router.push('/settings/devices')}
          />
          <Row icon="qr" label={t('settings.transfer')} hint={t('settings.transferHint')} onPress={() => router.push('/devices')} />
          <Row icon="eye" label={t('settings.findMe')} hint={t('settings.findMeHint')} onPress={() => router.push('/discovery/settings')} />
          <Row icon="key" label={t('settings.identityKey')} hint={t('settings.identityKeyHint')} onPress={() => setShowKeys(true)} />
        </>
      )}
      <Row first={isDemo} icon="shieldCheck" label={t('settings.howProtected')} hint={t('settings.howProtectedHint')} onPress={() => setShowAudit(true)} />
      <Row icon="download" label={t('updates.title', { defaultValue: 'App updates' })} hint={t('updates.hint', { defaultValue: 'Check for a new version' })} onPress={() => router.push('/settings/updates')} />
    </Card>
  );

  const storage = (
    <Card title={t('settings.sections.storage')} index={0}>
      <Row first icon="image" label={t('settings.clearCache')} hint={t('settings.clearCacheHint')} onPress={handleClearCache} />
      <Row icon="trash" label={t('settings.erase')} hint={t('settings.eraseHint')} onPress={handleEraseDevice} danger />
    </Card>
  );

  const extras = (
    <Card title={t('settings.sections.extras')} index={0}>
      <Row first icon="wallet" label={t('settings.payments')} hint={t('settings.paymentsHint')} onPress={() => router.push('/payments')} />
      <Row icon="bot" label={t('settings.bots')} hint={t('settings.botsHint')} onPress={() => router.push('/bots')} />
    </Card>
  );

  const bodies: Record<Section, React.ReactNode> = { appearance, privacy, security, extras, storage };

  const profileCard = (
    <Rise>
      <Pressy onPress={openProfileEditor} scaleTo={0.98} style={s.profile} hoverStyle={{ borderColor: c.accentLine }} accessibilityLabel={t('settings.editProfile')}>
        <Hatch gap={12} />
        <Avatar name={name} size={isWide ? 48 : 58} ring />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={[type.name, { fontSize: isWide ? 15.5 : 17 }]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={s.handle} numberOfLines={1}>
            @{user?.username || 'username'}
          </Text>
          {isDemo && <Text style={[type.caption, { color: c.accentText }]}>{t('settings.demoAccount')}</Text>}
        </View>
        <View style={s.editBadge}>
          <Icon name="edit" size={16} color={c.accentText} />
        </View>
      </Pressy>
    </Rise>
  );

  const audit = [
    { ok: true, title: 'e2eTitle', desc: 'e2eBody' },
    { ok: true, title: 'mediaTitle', desc: 'mediaBody' },
    { ok: true, title: 'keysTitle', desc: 'keysBody' },
    { ok: true, title: 'aclTitle', desc: 'aclBody' },
    { ok: true, title: 'pinTitle', desc: 'pinBody' },
    { ok: false, title: 'fsTitle', desc: 'fsBody' },
    { ok: false, title: 'metaTitle', desc: 'metaBody' },
  ];

  const sheets = (
    <>
      <Sheet visible={showProfile} onClose={() => setShowProfile(false)} title={t('settings.profile.title')}>
        <View style={{ alignItems: 'center', paddingVertical: 4 }}>
          <Avatar name={draftName || name} size={72} />
        </View>
        <TextField label={t('settings.profile.name')} icon="user" value={draftName} onChangeText={setDraftName} maxLength={64} />
        <TextField label={t('settings.profile.about')} icon="edit" value={draftAbout} onChangeText={setDraftAbout} maxLength={280} placeholder={t('settings.profile.aboutPlaceholder')} multiline />
        <View style={s.sheetNote}>
          <Icon name="eye" size={14} color={c.muted} />
          <Text style={[type.caption, { flex: 1 }]}>{t('settings.profile.visible')}</Text>
        </View>
        <Button label={t('common.save')} loading={saving} onPress={saveProfile} />
        <Button label={t('common.cancel')} variant="ghost" onPress={() => setShowProfile(false)} />
      </Sheet>

      <Sheet visible={showLanguage} onClose={() => setShowLanguage(false)} title={t('settings.language')}>
        <ScrollView style={{ maxHeight: 440 }} contentContainerStyle={{ gap: 4 }}>
          {[{ code: 'system' as const, native: t('settings.languageSystem'), english: t('settings.languageSystemDetail', { name: detected?.native ?? 'English' }) }, ...LANGUAGES].map((l) => {
            const on = langPref === l.code;
            return (
              <Pressy
                key={l.code}
                onPress={() => {
                  setLanguage(l.code);
                  setShowLanguage(false);
                }}
                scaleTo={0.98}
                hoverStyle={{ backgroundColor: c.tint }}
                style={[s.langRow, on && { backgroundColor: c.accentTint, borderColor: c.accentTint2 }]}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${l.native}, ${l.english}`}
              >
                <View style={{ flex: 1, gap: 1 }}>
                  {/* Native names use the system font so every script renders, whatever fonts are loaded. */}
                  <Text style={[s.langNative, l.code === 'system' && { fontFamily: f.semibold }]}>{l.native}</Text>
                  <Text style={type.caption}>{l.english}</Text>
                </View>
                {on && <Icon name="check" size={18} color={c.accentText} />}
              </Pressy>
            );
          })}
        </ScrollView>
      </Sheet>

      <Sheet visible={showKeys} onClose={() => setShowKeys(false)} title={t('settings.keys.title')}>
        {[
          [t('settings.keys.identity'), publicKey],
          [t('settings.keys.deviceId'), deviceId],
        ].map(([label, val]) => (
          <View key={label} style={s.keyBlock}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Eyebrow>{label ?? ''}</Eyebrow>
              {!!val && (
                <IconButton
                  icon="copy"
                  size={32}
                  label={t('settings.keys.copy')}
                  color={c.muted}
                  onPress={() => {
                    void Clipboard.setStringAsync(val);
                    notify(t('settings.keys.copied'));
                  }}
                />
              )}
            </View>
            <Text selectable style={s.keyText}>
              {val || '—'}
            </Text>
          </View>
        ))}
        <View style={s.sheetNote}>
          <Icon name="lock" size={14} color={c.success} />
          <Text style={[type.caption, { flex: 1 }]}>{t('settings.keys.note')}</Text>
        </View>
        <Button label={t('common.done')} variant="ghost" onPress={() => setShowKeys(false)} />
      </Sheet>

      <Sheet visible={showAudit} onClose={() => setShowAudit(false)} title={t('settings.audit.title')}>
        <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 14 }} showsVerticalScrollIndicator={false}>
          {audit.map((g, i) => (
            <Animated.View key={g.title} entering={FadeInDown.delay(i * 50)} style={s.guarantee}>
              <View style={[s.check, !g.ok && { backgroundColor: c.accentTint2 }]}>
                <Icon name={g.ok ? 'check' : 'info'} size={14} color={g.ok ? c.onAccent : c.accentText} strokeWidth={2.4} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[type.body, { fontFamily: f.semibold }]}>{t(`settings.audit.${g.title}`)}</Text>
                <Text style={type.caption}>{t(`settings.audit.${g.desc}`)}</Text>
              </View>
            </Animated.View>
          ))}
        </ScrollView>
        <Button label={t('common.gotIt')} variant="ghost" onPress={() => setShowAudit(false)} />
      </Sheet>
    </>
  );

  if (isWide) {
    return (
      <View style={[s.container, { flexDirection: 'row' }]}>
        <View style={s.subnav}>
          <Grain />
          <Text style={[type.title, { marginLeft: 8, marginBottom: 14 }]} accessibilityRole="header">
            {t('settings.title')}
          </Text>
          {profileCard}
          <View style={{ height: 10 }} />
          {SECTIONS.map((sec) => {
            const on = section === sec.key;
            return (
              <Pressy
                key={sec.key}
                onPress={() => setSection(sec.key)}
                scaleTo={0.98}
                hoverStyle={!on ? { backgroundColor: c.tint } : undefined}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={t(`settings.sections.${sec.key}`)}
                style={[s.navItem, on && s.navOn]}
              >
                <Icon name={sec.icon} size={19} color={on ? c.accentText : c.faint} />
                <Text style={[s.navText, on && { color: c.text }]}>{t(`settings.sections.${sec.key}`)}</Text>
              </Pressy>
            );
          })}
          <View style={{ flex: 1 }} />
          <Pressy onPress={handleLogout} style={s.navItem} hoverStyle={{ backgroundColor: c.dangerTint }} accessibilityLabel={isDemo ? t('settings.leaveDemo') : t('settings.logout')}>
            <Icon name="logout" size={19} color={c.danger} />
            <Text style={[s.navText, { color: c.danger }]}>{isDemo ? t('settings.leaveDemo') : t('settings.logout')}</Text>
          </Pressy>
        </View>
        <View style={{ flex: 1 }}>
          <Grain />
          <ScrollView contentContainerStyle={s.wideContent}>
            <Animated.View key={section} entering={FadeIn.duration(260)} style={{ gap: 6, marginBottom: 8 }}>
              <Text style={[type.title, { fontSize: 32 }]}>{t(`settings.sections.${section}`)}</Text>
              <Text style={type.bodyMuted}>{t('settings.lede')}</Text>
            </Animated.View>
            <View key={`${section}-body`} style={{ gap: 22 }}>
              {bodies[section]}
            </View>
          </ScrollView>
        </View>
        {sheets}
      </View>
    );
  }

  return (
    <View style={s.container}>
      <Grain />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 16, paddingBottom: 48, gap: 22 }} showsVerticalScrollIndicator={false}>
        <Text style={[type.title, { paddingHorizontal: 4 }]} accessibilityRole="header">
          {t('settings.title')}
        </Text>
        {profileCard}
        {appearance}
        {privacy}
        {security}
        {extras}
        {storage}
        <Rise index={4}>
          <View style={s.card}>
            <Row first icon="logout" label={isDemo ? t('settings.leaveDemo') : t('settings.logout')} danger onPress={handleLogout} />
          </View>
        </Rise>
        <Text style={[type.caption, { textAlign: 'center' }]}>{t('settings.footer')}</Text>
      </ScrollView>
      {sheets}
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  container: { flex: 1, backgroundColor: c.bg },
  card: { backgroundColor: c.panel, borderRadius: 22, borderWidth: 1, borderColor: c.line, paddingHorizontal: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 66, paddingVertical: 10 },
  rowBorder: { borderTopWidth: 1, borderTopColor: c.line },
  rowIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: c.raised },
  rowLabel: { fontFamily: f.medium, fontSize: 15.5, color: c.text },
  value: { fontFamily: f.medium, fontSize: 14, color: c.muted, maxWidth: 140 },
  handle: { fontFamily: f.script === 'latin' ? f.mono : f.body, fontSize: 12.5, color: c.muted },
  tile: { width: '100%', height: 112, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: c.line2 },
  tileCheck: { position: 'absolute', top: 6, right: 6, width: 20, height: 20, borderRadius: 10, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
  tileLabel: { fontFamily: f.medium, fontSize: 13, color: c.muted },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 22, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, overflow: 'hidden' },
  editBadge: { width: 36, height: 36, borderRadius: 12, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center' },
  subnav: { width: 300, paddingHorizontal: 16, paddingTop: 24, paddingBottom: 20, gap: 4, backgroundColor: c.panel, borderRightWidth: 1, borderRightColor: c.line },
  navItem: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 46, paddingHorizontal: 14, borderRadius: 14 },
  navOn: { backgroundColor: c.raised, borderWidth: 1, borderColor: c.line },
  navText: { fontFamily: f.medium, fontSize: 14.5, color: c.muted },
  wideContent: { padding: 40, gap: 22, maxWidth: 820, width: '100%', alignSelf: 'center' },
  langRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11, borderRadius: 14, borderWidth: 1, borderColor: 'transparent' },
  langNative: { fontSize: 16.5, color: c.text, fontWeight: '600' },
  keyBlock: { gap: 6, padding: 14, borderRadius: 14, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line },
  keyText: { fontFamily: f.mono, fontSize: 12.5, lineHeight: 18, color: c.text },
  sheetNote: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  deviceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: 16, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line },
  guarantee: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  check: { width: 24, height: 24, borderRadius: 12, backgroundColor: c.success, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
}));
