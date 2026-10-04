/**
 * The video area of the call screen: the participant grid for group calls,
 * or the remote video full-size with your camera picture-in-picture for 1:1
 * video calls (a shared screen is shown uncropped).
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import type { ActiveCall } from '../CallService';
import { CallVideoView } from './CallVideoView';
import { videoTrackKey } from './callVideoTypes';
import { GroupCallGrid } from './GroupCallGrid';
import { ParticipantTile } from './ParticipantTile';

const LIVE = ['calling', 'connecting', 'connected', 'reconnecting'];

/** Whether the call screen should show the stage instead of the avatar view. */
export function callHasStage(call: ActiveCall | null): boolean {
  if (!call || !LIVE.includes(call.status)) return false;
  if (call.kind === 'group') return call.status !== 'calling';
  const remote = call.participants[0];
  return call.local.cameraOn || call.local.screenSharing || !!remote?.videoEnabled || !!remote?.screenSharing;
}

export function CallStage({ call }: { call: ActiveCall }) {
  if (call.kind === 'group') {
    return (
      <View style={styles.fill}>
        <GroupCallGrid call={call} />
      </View>
    );
  }

  const remote = call.participants[0] ?? null;
  const remoteHasVideo = !!remote && remote.videoEnabled && !!videoTrackKey(remote.stream) && remote.connection === 'connected';
  const localPreview = call.local.cameraOn && !call.local.screenSharing && !!videoTrackKey(call.local.stream);

  return (
    <View style={styles.fill}>
      {remoteHasVideo ? (
        <CallVideoView stream={remote!.stream} objectFit={remote!.screenSharing ? 'contain' : 'cover'} style={StyleSheet.absoluteFill} />
      ) : remote ? (
        <ParticipantTile
          name={remote.name}
          stream={null}
          videoEnabled={false}
          audioMuted={remote.audioMuted}
          connection={remote.connection}
          style={StyleSheet.absoluteFill}
        />
      ) : localPreview ? (
        // Ringing a video call: show yourself full-size until they answer.
        <CallVideoView stream={call.local.stream} mirror={call.local.facing === 'user'} style={StyleSheet.absoluteFill} />
      ) : null}

      {remote && localPreview && (
        <View style={styles.pip}>
          <CallVideoView stream={call.local.stream} mirror={call.local.facing === 'user'} zOrder={1} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignSelf: 'stretch', borderRadius: 26, overflow: 'hidden' },
  pip: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 112,
    height: 158,
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(237,231,217,0.3)',
    backgroundColor: '#0C0E0D',
  },
});
