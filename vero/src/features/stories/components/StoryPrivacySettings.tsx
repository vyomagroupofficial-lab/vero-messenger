/**
 * "Who can see my stories" + muted authors. Saved on this device and synced to
 * the user's own story_privacy row; applied when the next story is posted.
 */

import React, { useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { Avatar, Button, Eyebrow, Icon, IconButton, Pressy } from '../../../shared/ui';
import { useAuthStore } from '../../auth/useAuthStore';
import { AudienceMode, StoryPrivacy, resolveAudience } from '../audience';
import { useStoryContacts } from '../hooks';
import { notify } from '../confirm';
import { useStoriesStore } from '../useStoriesStore';

const MODES: AudienceMode[] = ['contacts', 'contacts_except', 'only'];

export function StoryPrivacySettings() {
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const userId = useAuthStore((st) => st.user?.id) ?? '';
  const privacy = useStoriesStore((st) => st.privacy);
  const names = useStoriesStore((st) => st.names);
  const contacts = useStoryContacts();
  const [saving, setSaving] = useState(false);

  const save = async (patch: Partial<StoryPrivacy>) => {
    setSaving(true);
    try {
      await useStoriesStore.getState().setPrivacy(patch);
    } catch (e: any) {
      notify(t('stories.localOnly'), e?.message ?? t('stories.privacySyncFailed'));
    } finally {
      setSaving(false);
    }
  };

  const listKey = privacy.audience === 'contacts_except' ? 'exceptUserIds' : 'onlyUserIds';
  const selected = new Set(privacy[listKey]);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    void save({ [listKey]: [...next] });
  };

  const audienceCount = resolveAudience(contacts.map((ct) => ct.id), privacy, userId).length;
  const contactNames = useMemo(() => Object.fromEntries(contacts.map((ct) => [ct.id, ct.displayName])), [contacts]);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <IconButton icon="back" label={t('common.back')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/stories'))} />
        <Text style={[type.name, { flex: 1, fontSize: 18 }]} accessibilityRole="header">
          {t('stories.privacy')}
        </Text>
        {saving && (
          <Animated.Text entering={FadeIn} style={type.caption}>
            {t('stories.saving')}
          </Animated.Text>
        )}
      </View>

      <FlatList
        data={privacy.audience === 'contacts' ? [] : contacts}
        keyExtractor={(ct) => ct.id}
        contentContainerStyle={[s.list, { paddingBottom: insets.bottom + 40 }]}
        ListHeaderComponent={
          <View style={{ gap: 10 }}>
            <Eyebrow style={s.section}>{t('stories.whoCanSee')}</Eyebrow>
            {MODES.map((mode) => {
              const on = privacy.audience === mode;
              return (
                <Pressy
                  key={mode}
                  onPress={() => save({ audience: mode })}
                  scaleTo={0.98}
                  hoverStyle={!on ? { borderColor: c.line2 } : undefined}
                  style={[s.option, on && s.optionOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={t(`stories.mode_${mode}`)}
                >
                  <View style={[s.radio, on && { borderColor: c.accent }]}>{on && <Animated.View entering={ZoomIn.springify().damping(14)} style={s.radioDot} />}</View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={s.optionTitle}>{t(`stories.mode_${mode}`)}</Text>
                    <Text style={type.caption}>{t(`stories.modeHint_${mode}`)}</Text>
                  </View>
                </Pressy>
              );
            })}
            <View style={s.note}>
              <Icon name="lock" size={14} color={c.success} />
              <Text style={[type.caption, { flex: 1 }]}>{t('stories.audienceNote', { people: t('groups.people', { count: audienceCount }) })}</Text>
            </View>
            {privacy.audience !== 'contacts' && <Eyebrow style={s.section}>{privacy.audience === 'contacts_except' ? t('stories.hideFrom') : t('stories.shareOnly')}</Eyebrow>}
            {privacy.audience !== 'contacts' && contacts.length === 0 && <Text style={type.caption}>{t('stories.noContacts')}</Text>}
          </View>
        }
        renderItem={({ item }) => {
          const on = selected.has(item.id);
          return (
            <Pressy onPress={() => toggle(item.id)} scaleTo={0.98} hoverStyle={{ backgroundColor: c.tint }} style={s.row} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={item.displayName}>
              <Avatar name={item.displayName} size={40} />
              <Text style={s.rowName} numberOfLines={1}>
                {item.displayName}
              </Text>
              <View style={[s.box, on && s.boxOn]}>{on && <Icon name="check" size={14} color={c.onAccent} strokeWidth={2.6} />}</View>
            </Pressy>
          );
        }}
        ListFooterComponent={
          <View style={{ gap: 6 }}>
            <Eyebrow style={s.section}>{t('stories.mutedStories')}</Eyebrow>
            {privacy.mutedUserIds.length === 0 ? (
              <Text style={type.caption}>{t('stories.mutedHint')}</Text>
            ) : (
              privacy.mutedUserIds.map((id) => (
                <View key={id} style={s.row}>
                  <Avatar name={contactNames[id] ?? names[id] ?? '?'} size={40} />
                  <Text style={[s.rowName, { color: c.muted }]} numberOfLines={1}>
                    {contactNames[id] ?? names[id] ?? t('stories.unknown')}
                  </Text>
                  <Button label={t('channels.unmute')} size="sm" variant="secondary" onPress={() => void useStoriesStore.getState().toggleMute(id)} />
                </View>
              ))
            )}
          </View>
        }
      />
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  root: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line },
  list: { width: '100%', maxWidth: 640, alignSelf: 'center', paddingHorizontal: 16 },
  section: { marginTop: 18 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, backgroundColor: c.panel, borderRadius: 18, borderWidth: 1, borderColor: c.line },
  optionOn: { borderColor: c.accentLine, backgroundColor: c.accentTint },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: c.line3, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.accent },
  optionTitle: { fontFamily: f.semibold, fontSize: 15, color: c.text },
  note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 14 },
  rowName: { flex: 1, fontFamily: f.medium, fontSize: 15, color: c.text },
  box: { width: 24, height: 24, borderRadius: 8, borderWidth: 1.5, borderColor: c.line3, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: c.accent, borderColor: c.accent },
}));
