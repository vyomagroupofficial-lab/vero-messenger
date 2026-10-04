/**
 * Small pieces rendered inside a message bubble: "Forwarded" label, deleted
 * placeholder, "edited" and star markers.
 */

import React from 'react';
import { Text, View } from 'react-native';
import type { Message } from '../../../shared/models/Message';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { Icon } from '../../../shared/ui';
import { isFrequentlyForwarded } from '../forward';

export function ForwardedLabel({ hops, isOwn }: { hops?: number; isOwn?: boolean }) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  if (!hops || hops < 1) return null;
  const many = isFrequentlyForwarded(hops);
  const color = isOwn ? c.mineMeta : c.muted;
  return (
    <View style={s.row}>
      <Icon name="forward" size={12} color={color} />
      {many && <Icon name="forward" size={12} color={color} style={{ marginLeft: -8 }} />}
      <Text style={[s.forwarded, { color }]}>{many ? t('messages.forwardedMany') : t('messages.forwarded')}</Text>
    </View>
  );
}

export function RevokedBody({ isOwn }: { isOwn: boolean }) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const color = isOwn ? c.mineMeta : c.faint;
  return (
    <View style={[s.row, { marginBottom: 0 }]}>
      <Icon name="ban" size={14} color={color} />
      <Text style={[s.revoked, { color }]}>{isOwn ? t('preview.youDeleted') : t('preview.deleted')}</Text>
    </View>
  );
}

/** Footer markers before the time: ★ and "edited". */
export function FooterMarkers({ message }: { message: Pick<Message, 'starred' | 'editedAt' | 'revokedAt' | 'isOwn'> }) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  if (message.revokedAt) return null;
  const meta = message.isOwn ? c.mineMeta : c.faint;
  return (
    <>
      {message.starred && <Icon name="starFilled" size={11} color={c.accent} />}
      {!!message.editedAt && <Text style={[s.edited, { color: meta }]}>{t('messages.edited')}</Text>}
    </>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 3 },
  forwarded: { fontFamily: f.medium, fontSize: 11.5, fontStyle: 'italic' },
  revoked: { fontFamily: f.body, fontSize: 14, fontStyle: 'italic' },
  edited: { fontFamily: f.body, fontSize: 11, fontStyle: 'italic' },
}));
