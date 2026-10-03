// Browser harness for scripts/calls-browser-check.mjs: runs several PeerMesh
// instances in ONE Chromium page with REAL RTCPeerConnections, the real web
// media adapter (fake camera / microphone), LocalMedia and libsodium-sealed
// signalling passed over an in-memory bus. Not part of `npm test`.
import sodiumModule from 'libsodium-wrappers';
import { generateIdentityKeyPair, type Sodium } from '../../src/core/crypto/primitives';
import { mediaAdapter } from '../../src/features/calls/webrtc.web';
import { PeerMesh, type MeshSignal } from '../../src/features/calls/PeerMesh';
import { LocalMedia } from '../../src/features/calls/LocalMedia';
import { createSignalCodec, type PeerIdentity } from '../../src/features/calls/signalingCrypto';

const CALL = '99999999-9999-4999-8999-999999999999';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Dev {
  id: string;
  mesh: PeerMesh;
  local: LocalMedia;
}

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error(`timeout: ${what}`);
}

async function inboundVideo(mesh: PeerMesh, from: string): Promise<{ frames: number; width: number }> {
  const s = mesh.session(from);
  if (!s) return { frames: 0, width: 0 };
  const report: any = await s.peer.getStats();
  let frames = 0;
  let width = 0;
  report.forEach((r: any) => {
    if (r.type === 'inbound-rtp' && r.kind === 'video') {
      frames = Math.max(frames, r.framesDecoded ?? 0);
      width = Math.max(width, r.frameWidth ?? 0);
    }
  });
  return { frames, width };
}

(window as any).runCallsCheck = async () => {
  await sodiumModule.ready;
  const sodium = sodiumModule as unknown as Sodium;
  const results: string[] = [];
  const ok = (msg: string) => results.push(`ok - ${msg}`);
  const directory: Record<string, PeerIdentity> = {};
  const devices = new Map<string, Dev>();
  let chain = Promise.resolve();

  // A canvas stands in for the screen (headless Chromium has none).
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d')!;
  setInterval(() => {
    ctx.fillStyle = `hsl(${Date.now() % 360}, 70%, 50%)`;
    ctx.fillRect(0, 0, 320, 180);
  }, 50);
  (navigator.mediaDevices as any).getDisplayMedia = async () => (canvas as any).captureStream(15);

  async function add(id: string, video: boolean): Promise<Dev> {
    const keys = generateIdentityKeyPair(sodium);
    directory[id] = { deviceId: id, userId: `user-${id}`, publicKey: keys.publicKey };
    const codec = createSignalCodec({
      callId: CALL,
      myDeviceId: id,
      sessionId: `s-${id}`,
      withSecretKey: async (fn) => fn(sodium, keys.secretKey),
      resolveDevice: async (x) => directory[x] ?? null,
    });
    let mesh: PeerMesh | null = null;
    const local = new LocalMedia({
      adapter: mediaAdapter,
      onSendTrack: async (kind, track) => {
        await mesh?.setTrack(kind, track);
      },
      onChange: () => {},
    });
    await local.start(video);
    mesh = new PeerMesh({
      myDeviceId: id,
      adapter: mediaAdapter,
      config: { iceServers: [] },
      localStream: local.stream!,
      maxPeers: 7,
      getTracks: () => local.tracks,
      send: (to: string, type: MeshSignal, data: unknown) => {
        chain = chain.then(async () => {
          const sealed = JSON.parse(JSON.stringify(await codec.seal(to, type, data))); // as on the wire
          for (const other of devices.values()) {
            if (other.id === id) continue;
            void (other as any).codec
              .open(sealed)
              .then((opened: any) => opened && other.mesh.handleSignal(opened.from, opened.message, () => true));
          }
        });
      },
      // As CallService does: play every remote stream (Chrome only measures audio that plays out).
      onChange: () => mesh?.list().forEach((p) => p.stream && mediaAdapter.attachRemoteAudio(`${id}>${p.deviceId}`, p.stream)),
    });
    const dev = { id, mesh, local, codec } as Dev & { codec: typeof codec };
    devices.set(id, dev);
    return dev;
  }

  const allConnected = (d: Dev, n: number) => d.mesh.list().filter((p) => p.state === 'connected').length === n;

  // 1:1 video call: B (answering device) offers to A.
  const a = await add('dev-a', true);
  const b = await add('dev-b', true);
  b.mesh.connect('dev-a', 'user-dev-a', true);
  await waitFor('A<->B connected', () => allConnected(a, 1) && allConnected(b, 1));
  await waitFor('A decodes B video', async () => (await inboundVideo(a.mesh, 'dev-b')).frames > 5);
  await waitFor('B decodes A video', async () => (await inboundVideo(b.mesh, 'dev-a')).frames > 5);
  ok('1:1 video: real RTCPeerConnections connect over sealed signalling and decode video both ways');

  try {
    await waitFor('audio level from fake microphone', async () => ((await a.mesh.remoteAudioLevels()).get('dev-b') ?? 0) > 0.001, 8000);
  } catch (e) {
    const rep: any = await a.mesh.session('dev-b')!.peer.getStats();
    const audio: any[] = [];
    rep.forEach((r: any) => (r.kind === 'audio' || r.type === 'media-source' ? audio.push(r) : null));
    throw new Error(`${(e as Error).message}: ${JSON.stringify(audio).slice(0, 1500)}`);
  }
  ok('audio levels are read from real WebRTC stats');

  // C joins voice-only: full mesh of three.
  const c = await add('dev-c', false);
  c.mesh.connect('dev-a', 'user-dev-a', true);
  c.mesh.connect('dev-b', 'user-dev-b', true);
  await waitFor('3-way mesh', () => allConnected(a, 2) && allConnected(b, 2) && allConnected(c, 2));
  ok('group: newcomer connects to everyone (3-device mesh)');

  // C turns the camera on mid-call: new transceiver + renegotiation.
  await c.local.setCameraOn(true);
  await waitFor('A decodes C video after renegotiation', async () => (await inboundVideo(a.mesh, 'dev-c')).frames > 5);
  await waitFor('B decodes C video after renegotiation', async () => (await inboundVideo(b.mesh, 'dev-c')).frames > 5);
  ok('camera turned on in a voice call renegotiates and reaches every peer');

  // B shares its "screen" (canvas): replaceTrack, no renegotiation.
  const before = (await inboundVideo(a.mesh, 'dev-b')).width;
  await b.local.startScreenShare();
  await waitFor('A sees the 320px screen', async () => (await inboundVideo(a.mesh, 'dev-b')).width === 320, 20000);
  ok(`screen share replaces the camera track (frame width ${before} -> 320)`);
  await b.local.stopScreenShare();
  await waitFor('camera restored', async () => (await inboundVideo(a.mesh, 'dev-b')).width !== 320, 20000);
  ok('stopping the share restores the camera');

  // Mute really disables the audio track.
  b.local.setMicMuted(true);
  if (b.local.tracks.audio?.enabled !== false) throw new Error('mute did not disable the track');
  ok('mute disables the microphone track');

  // Glare between two fresh devices.
  const d = await add('dev-d', false);
  const e = await add('dev-e', false);
  d.mesh.connect('dev-e', 'user-dev-e', true);
  e.mesh.connect('dev-d', 'user-dev-d', true);
  await waitFor('glare resolved', () => allConnected(d, 1) && allConnected(e, 1));
  ok('simultaneous offers (glare) resolve to one connection');

  // C leaves.
  c.mesh.closeAll(true);
  c.local.stop();
  await waitFor('C removed', () => !a.mesh.has('dev-c') && !b.mesh.has('dev-c'));
  ok('leaving sends bye and the others drop the connection');

  for (const dev of devices.values()) {
    dev.mesh.closeAll(false);
    dev.local.stop();
  }
  return results;
};
