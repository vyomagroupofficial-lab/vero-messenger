/**
 * Chat screen add-ons: edit banner, multi-select bar, edit history sheet.
 */

import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated, { FadeInDown, ZoomIn } from 'react-native-reanimated';
import dayjs from 'dayjs';
import type { Message } from '../../../shared/models/Message';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { Icon, IconButton, Sheet } from '../../../shared/ui';
import type { EditHistoryEntry } from '../edits';

export function EditBanner({ message, onCancel }: { message: Message; onCancel: () => void }) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  return (
    <Animated.View entering={FadeInDown.springify().damping(18)} style={s.banner}>
      <View style={s.bannerIcon}>
        <Icon name="edit" size={16} color={c.accentText} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.bannerTitle}>{t('messages.editing')}</Text>
        <Text style={s.bannerText} numberOfLines={1}>
          {message.content || (message.messageType === 'text' ? '' : t('messages.addCaption'))}
        </Text>
      </View>
      <IconButton icon="close" label={t('messages.cancelEdit')} size={36} onPress={onCancel} />
    </Animated.View>
  );
}

export function SelectionBar({
  count,
  allStarred,
  canForward,
  onCancel,
  onStar,
  onForward,
  onCopy,
  onDelete,
}: {
  count: number;
  allStarred: boolean;
  canForward: boolean;
  onCancel: () => void;
  onStar: () => void;
  onForward: () => void;
  onCopy?: () => void;
  onDelete: () => void;
}) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  return (
    <Animated.View entering={FadeInDown.duration(200)} style={s.selection}>
      <IconButton icon="close" label={t('messages.cancelSelect')} onPress={onCancel} />
      <Animated.Text key={count} entering={ZoomIn.springify().damping(14)} style={s.count}>
        {count}
      </Animated.Text>
      <Text style={s.countLabel} numberOfLines={1}>
        {t('messages.selected', { count })}
      </Text>
      <IconButton icon={allStarred ? 'starFilled' : 'star'} label={allStarred ? t('thread.unstar') : t('thread.star')} color={c.accentText} disabled={!count} onPress={onStar} />
      {onCopy && <IconButton icon="copy" label={t('thread.copy')} disabled={!count} onPress={onCopy} />}
      <IconButton icon="forward" label={t('thread.forward')} disabled={!canForward} onPress={onForward} />
      <IconButton icon="trash" label={t('thread.deleteForMe')} color={c.danger} disabled={!count} onPress={onDelete} />
    </Animated.View>
  );
}

export function EditHistorySheet({ entries, onClose }: { entries: EditHistoryEntry[] | null; onClose: () => void }) {
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const all = entries ?? [];
  return (
    <Sheet visible={entries !== null} onClose={onClose} title={t('thread.editHistory')}>
      <View style={s.note}>
        <Icon name="lock" size={13} color={c.success} />
        <Text style={type.caption}>{t('messages.historyLocal')}</Text>
      </View>
      <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ gap: 10 }}>
        {all.map((e, i) => {
          const current = i === all.length - 1;
          return (
            <Animated.View key={`${e.at}-${i}`} entering={FadeInDown.delay(i * 40)} style={[s.version, current && s.versionCurrent]}>
              <View style={s.versionTop}>
                <Text style={[s.versionTag, current && { color: c.accentText }]}>
                  {i === 0 && all.length > 1 ? t('messages.original') : current ? t('messages.current') : t('messages.editN', { n: i })}
                </Text>
                <Text style={type.caption}>{dayjs(e.at).format('D MMM, h:mm A')}</Text>
              </View>
              <Text style={[type.body, !e.text && { color: c.faint, fontStyle: 'italic' }]}>{e.text || t('messages.noCaption')}</Text>
            </Animated.View>
          );
        })}
      </ScrollView>
    </Sheet>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  banner: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 14, paddingRight: 8, paddingVertical: 8, backgroundColor: c.panel, borderTopWidth: 1, borderTopColor: c.line },
  bannerIcon: { width: 34, height: 34, borderRadius: 12, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center' },
  bannerTitle: { fontFamily: f.semibold, fontSize: 12.5, color: c.accentText },
  bannerText: { fontFamily: f.body, fontSize: 13.5, color: c.muted, marginTop: 1 },
  selection: { height: 68, flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 8 },
  count: { fontFamily: f.display, fontSize: 22, color: c.accentText, marginLeft: 6 },
  countLabel: { flex: 1, fontFamily: f.medium, fontSize: 14, color: c.muted, marginLeft: 6 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  version: { padding: 12, borderRadius: 14, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line, gap: 6 },
  versionCurrent: { borderColor: c.accentLine, backgroundColor: c.accentTint },
  versionTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  versionTag: { fontFamily: f.semibold, fontSize: 12, color: c.muted, textTransform: 'uppercase', letterSpacing: 0.6 },
}));
