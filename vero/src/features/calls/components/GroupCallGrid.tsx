/**
 * Participant grid for group calls (and the 1:1 video layout's building
 * block). Everyone, including you, gets a tile with mute / camera indicators;
 * the active speaker (from WebRTC audio levels) gets a highlighted border.
 * When someone shares their screen it is shown large, with everyone else in a
 * strip below.
 */

import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Colors, Typography, Spacing } from '../../../shared/theme/theme';
import type { ActiveCall, CallParticipantView } from '../CallService';
import { ParticipantTile } from './ParticipantTile';

export function gridShape(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 1, rows: 2 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 2, rows: 3 };
  return { cols: 2, rows: Math.ceil(count / 2) };
}

interface Tile {
  key: string;
  participant: CallParticipantView | null; // null = you
}

export function GroupCallGrid({ call }: { call: ActiveCall }) {
  const local = call.local;
  const tiles: Tile[] = [{ key: 'local', participant: null }, ...call.participants.map((p) => ({ key: p.deviceId, participant: p }))];

  const renderTile = (t: Tile, compact = false) => {
    const p = t.participant;
    if (!p) {
      return (
        <ParticipantTile
          key={t.key}
          name="You"
          isLocal
          stream={local.stream}
          videoEnabled={local.cameraOn && !local.screenSharing}
          audioMuted={local.micMuted}
          screenSharing={false}
          mirror={local.facing === 'user'}
          active={call.activeSpeakerId === 'local'}
          speaking={local.speaking}
          compact={compact}
          zOrder={1}
        />
      );
    }
    return (
      <ParticipantTile
        key={t.key}
        name={p.name}
        stream={p.stream}
        videoEnabled={p.videoEnabled}
        audioMuted={p.audioMuted}
        screenSharing={p.screenSharing}
        active={call.activeSpeakerId === p.deviceId}
        speaking={p.speaking}
        connection={p.connection}
        compact={compact}
      />
    );
  };

  // Someone is presenting: their screen large, everyone else in a strip.
  const presenter = call.presenterId && call.presenterId !== 'local' ? call.participants.find((p) => p.deviceId === call.presenterId) : null;
  if (presenter) {
    const others = tiles.filter((t) => t.key !== presenter.deviceId);
    return (
      <View style={styles.container}>
        <View style={styles.stage}>{renderTile({ key: presenter.deviceId, participant: presenter })}</View>
        <ScrollView horizontal style={styles.strip} contentContainerStyle={styles.stripContent}>
          {others.map((t) => (
            <View key={t.key} style={styles.stripTile}>
              {renderTile(t, true)}
            </View>
          ))}
        </ScrollView>
      </View>
    );
  }

  const { cols, rows } = gridShape(tiles.length);
  return (
    <View style={styles.container}>
      {call.presenterId === 'local' && (
        <Text style={styles.presentingNote}>You are sharing your screen with everyone in the call</Text>
      )}
      <View style={styles.grid}>
        {tiles.map((t) => (
          <View key={t.key} style={{ width: `${100 / cols}%`, height: `${100 / rows}%` }}>
            {renderTile(t, tiles.length > 4)}
          </View>
        ))}
      </View>
      {call.participants.length === 0 && call.status === 'connected' && (
        <Text style={styles.waiting}>Waiting for others to join…</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  grid: { flex: 1, flexDirection: 'row', flexWrap: 'wrap' },
  stage: { flex: 1 },
  strip: { flexGrow: 0, height: 110, marginTop: Spacing.xs },
  stripContent: { paddingHorizontal: 2 },
  stripTile: { width: 96, height: 104 },
  presentingNote: {
    color: Colors.accentLight,
    fontSize: Typography.xs,
    textAlign: 'center',
    marginBottom: Spacing.xs,
  },
  waiting: {
    color: Colors.textSecondary,
    fontSize: Typography.sm,
    textAlign: 'center',
    marginTop: Spacing.sm,
  },
});
