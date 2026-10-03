// Mesh bookkeeping + negotiation over a simulated network: several PeerMesh
// instances exchange REAL sealed signals (createSignalCodec + libsodium); the
// RTCPeerConnections are fakes that model the signalling state machine
// (stable / have-local-offer / have-remote-offer / rollback) closely enough
// to exercise perfect negotiation, glare, renegotiation and ICE restarts.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import sodiumModule from 'libsodium-wrappers';
import { Sodium, generateIdentityKeyPair } from '../src/core/crypto/primitives';
import { PeerMesh, isPolite, type MeshSignal } from '../src/features/calls/PeerMesh';
import { audioLevelFromStats } from '../src/features/calls/PeerSession';
import { LocalMedia } from '../src/features/calls/LocalMedia';
import { createSignalCodec, type PeerIdentity, type SignalCodec } from '../src/features/calls/signalingCrypto';
import type {
  IceCandidateInit,
  MediaAdapter,
  PeerConfig,
  PeerHandlers,
  PeerLike,
  SenderLike,
  SessionDescriptionInit,
  StreamLike,
  TrackLike,
} from '../src/features/calls/mediaTypes';

let sodium: Sodium;
before(async () => {
  await sodiumModule.ready;
  sodium = sodiumModule as unknown as Sodium;
});

const CALL = '77777777-7777-4777-8777-777777777777';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ── Fakes ───────────────────────────────────────────────────────────────────

let idCounter = 0;
class FakeTrack implements TrackLike {
  readonly id = `track-${++idCounter}`;
  enabled = true;
  readyState = 'live';
  constructor(readonly kind: string) {}
  stop() {
    this.readyState = 'ended';
  }
}

class FakeStream implements StreamLike {
  readonly id = `stream-${++idCounter}`;
  private tracks: TrackLike[];
  constructor(tracks: TrackLike[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(t: TrackLike) {
    if (!this.tracks.includes(t)) this.tracks.push(t);
  }
  removeTrack(t: TrackLike) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

class FakeSender implements SenderLike {
  replaced = 0;
  constructor(public track: TrackLike | null) {}
  async replaceTrack(t: TrackLike | null) {
    this.track = t;
    this.replaced++;
  }
}

class FakePeer implements PeerLike {
  signalingState = 'stable';
  iceConnectionState = 'new';
  connectionState = 'new';
  localDescription: { type: string | null; sdp: string } | null = null;
  remoteDescription: { type: string | null; sdp: string } | null = null;
  senders: FakeSender[] = [];
  candidatesAdded: IceCandidateInit[] = [];
  offers = 0;
  closed = false;
  private announced = new Set<string>();
  private remoteStream = new FakeStream();
  static all: FakePeer[] = [];

  constructor(readonly owner: string, private readonly h: PeerHandlers) {
    FakePeer.all.push(this);
  }

  private kinds() {
    return this.senders.map((s) => s.track?.kind ?? 'video').sort().join(',');
  }

  async createOffer(o?: { iceRestart?: boolean }): Promise<SessionDescriptionInit> {
    this.offers++;
    return { type: 'offer', sdp: `offer|${this.owner}|${this.offers}|${this.kinds()}${o?.iceRestart ? '|restart' : ''}` };
  }
  async createAnswer(): Promise<SessionDescriptionInit> {
    assert.equal(this.signalingState, 'have-remote-offer');
    return { type: 'answer', sdp: `answer|${this.owner}|${this.kinds()}` };
  }
  async setLocalDescription(d: SessionDescriptionInit) {
    await tick();
    if (d.type === 'rollback') {
      if (this.signalingState === 'have-local-offer') this.signalingState = 'stable';
      return;
    }
    if (d.type === 'offer') {
      if (this.signalingState !== 'stable') throw new Error(`InvalidStateError: offer in ${this.signalingState}`);
      this.signalingState = 'have-local-offer';
      this.localDescription = { type: 'offer', sdp: d.sdp! };
      setTimeout(() => this.h.onIceCandidate({ candidate: `candidate:${this.owner}`, sdpMid: '0', sdpMLineIndex: 0 }), 1);
    } else if (d.type === 'answer') {
      if (this.signalingState !== 'have-remote-offer') throw new Error('InvalidStateError: answer');
      this.signalingState = 'stable';
      this.localDescription = { type: 'answer', sdp: d.sdp! };
      setTimeout(() => this.h.onIceCandidate({ candidate: `candidate:${this.owner}`, sdpMid: '0', sdpMLineIndex: 0 }), 1);
      this.maybeConnect();
    }
  }
  async setRemoteDescription(d: SessionDescriptionInit) {
    await tick();
    if (d.type === 'offer') {
      if (this.signalingState !== 'stable') throw new Error(`InvalidStateError: remote offer in ${this.signalingState}`);
      this.signalingState = 'have-remote-offer';
    } else if (d.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') throw new Error('InvalidStateError: remote answer');
      this.signalingState = 'stable';
      this.maybeConnect();
    }
    this.remoteDescription = { type: d.type, sdp: d.sdp! };
    for (const kind of (d.sdp ?? '').split('|')[3]?.split(',') ?? []) {
      if (kind && !this.announced.has(kind)) {
        this.announced.add(kind);
        const track = new FakeTrack(kind);
        this.remoteStream.addTrack(track);
        this.h.onTrack(track, [this.remoteStream]);
      }
    }
  }
  async addIceCandidate(c: IceCandidateInit) {
    if (!this.remoteDescription) throw new Error('no remote description');
    this.candidatesAdded.push(c);
  }
  addTrack(track: TrackLike): SenderLike {
    const s = new FakeSender(track);
    this.senders.push(s);
    return s;
  }
  getSenders() {
    return this.senders;
  }
  async getStats() {
    return new Map<string, any>([
      ['in', { type: 'inbound-rtp', kind: 'audio', audioLevel: 0.3 }],
      ['src', { type: 'media-source', kind: 'audio', audioLevel: 0.6 }],
      ['vid', { type: 'inbound-rtp', kind: 'video' }],
    ]);
  }
  close() {
    this.closed = true;
  }
  private maybeConnect() {
    if (this.iceConnectionState === 'connected') return;
    setTimeout(() => this.setIce('connected'), 2);
  }
  setIce(state: string) {
    this.iceConnectionState = state;
    this.h.onIceConnectionStateChange(state);
  }
}

function fakeAdapter(owner: string): MediaAdapter {
  return {
    unavailableReason: () => null,
    createPeer: (_c: PeerConfig, h: PeerHandlers) => new FakePeer(owner, h),
    createStream: (tracks) => new FakeStream(tracks),
    getUserMedia: async ({ video }) => new FakeStream([new FakeTrack('audio'), ...(video ? [new FakeTrack('video')] : [])]),
    screenShareSupport: () => ({ supported: true }),
    getDisplayMedia: async () => new FakeStream([new FakeTrack('video')]),
    switchCamera: async (_t, facing) => ({ facing: facing === 'user' ? 'environment' : 'user' }),
    attachRemoteAudio: () => {},
    audio: {
      supportsSpeakerToggle: false,
      startOutgoing() {},
      startRingtone() {},
      stopRingtone() {},
      startInCall() {},
      setSpeakerphone() {},
      stop() {},
    },
  };
}

// ── Simulated network of devices ────────────────────────────────────────────

interface Device {
  id: string;
  userId: string;
  keys: { publicKey: string; secretKey: string };
  codec: SignalCodec;
  mesh: PeerMesh;
  audio: TrackLike;
  admit: (deviceId: string, userId: string) => boolean;
  rejected: string[];
  sent: { to: string; type: string }[];
}

function network() {
  const devices = new Map<string, Device>();
  const directory: Record<string, PeerIdentity> = {};
  let sendChain = Promise.resolve();

  function deliver(raw: unknown, fromId: string) {
    for (const d of devices.values()) {
      if (d.id === fromId) continue;
      void d.codec
        .open(raw)
        .then((opened) => {
          if (!opened) return;
          return d.mesh.handleSignal(opened.from, opened.message, () => d.admit(opened.from.deviceId, opened.from.userId));
        })
        .then((r) => {
          if (r === 'rejected') d.rejected.push(fromId);
        })
        .catch((e) => d.rejected.push(`${fromId}:${(e as Error).message}`));
    }
  }

  function add(id: string, userId: string, opts: { maxPeers?: number; keysOverride?: { publicKey: string; secretKey: string } } = {}) {
    const keys = generateIdentityKeyPair(sodium);
    directory[id] = { deviceId: id, userId, publicKey: keys.publicKey };
    const secret = opts.keysOverride?.secretKey ?? keys.secretKey;
    const audio = new FakeTrack('audio');
    const stream = new FakeStream([audio]);
    const dev: Device = {
      id,
      userId,
      keys,
      audio,
      rejected: [],
      sent: [],
      admit: () => true,
      codec: createSignalCodec({
        callId: CALL,
        myDeviceId: id,
        sessionId: `s-${id}`,
        withSecretKey: async (fn) => fn(sodium, secret),
        resolveDevice: async (x) => directory[x] ?? null,
      }),
      mesh: null as unknown as PeerMesh,
    };
    dev.mesh = new PeerMesh({
      myDeviceId: id,
      adapter: fakeAdapter(id),
      config: { iceServers: [] },
      localStream: stream,
      maxPeers: opts.maxPeers ?? 7,
      getTracks: () => ({ audio, video: null }),
      send: (to: string, type: MeshSignal, data: unknown) => {
        dev.sent.push({ to, type });
        sendChain = sendChain.then(async () => deliver(await dev.codec.seal(to, type, data), id));
      },
      onChange: () => {},
    });
    devices.set(id, dev);
    return dev;
  }

  async function settle(ms = 400) {
    await tick(ms);
  }

  return { add, settle, devices, directory };
}

function connectedPeers(d: Device): string[] {
  return d.mesh
    .list()
    .filter((p) => p.state === 'connected')
    .map((p) => p.deviceId)
    .sort();
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('politeness is antisymmetric', () => {
  assert.notEqual(isPolite('a', 'b'), isPolite('b', 'a'));
});

test('1:1: the answering device offers, both ends connect and get remote audio', async () => {
  const net = network();
  const caller = net.add('dev-a', 'alice');
  const callee = net.add('dev-b', 'bob');
  assert.equal(callee.mesh.connect('dev-a', 'alice', true), 'started');
  await net.settle();
  assert.deepEqual(connectedPeers(caller), ['dev-b']);
  assert.deepEqual(connectedPeers(callee), ['dev-a']);
  const remote = caller.mesh.list()[0].stream!;
  assert.equal(remote.getAudioTracks().length, 1, 'caller receives the callee audio');
  const pc = caller.mesh.session('dev-b')!.peer as FakePeer;
  assert.ok(pc.candidatesAdded.some((c) => c.candidate === 'candidate:dev-b'), 'trickled ICE arrived (sealed)');
});

test('group: a newcomer connects to everyone already in the call (full mesh)', async () => {
  const net = network();
  const a = net.add('dev-a', 'alice');
  const b = net.add('dev-b', 'bob');
  const c = net.add('dev-c', 'carol');
  const d = net.add('dev-d', 'dave');
  b.mesh.connect('dev-a', 'alice', true); // b joined after a
  await net.settle();
  c.mesh.connect('dev-a', 'alice', true); // c joins: offers to a and b
  c.mesh.connect('dev-b', 'bob', true);
  await net.settle();
  d.mesh.connect('dev-a', 'alice', true);
  d.mesh.connect('dev-b', 'bob', true);
  d.mesh.connect('dev-c', 'carol', true);
  await net.settle(600);
  assert.deepEqual(connectedPeers(a), ['dev-b', 'dev-c', 'dev-d']);
  assert.deepEqual(connectedPeers(b), ['dev-a', 'dev-c', 'dev-d']);
  assert.deepEqual(connectedPeers(c), ['dev-a', 'dev-b', 'dev-d']);
  assert.deepEqual(connectedPeers(d), ['dev-a', 'dev-b', 'dev-c']);
  for (const dev of [a, b, c, d]) assert.equal(dev.rejected.length, 0);
});

test('glare: both sides offer at the same time and still end up with one stable connection', async () => {
  const net = network();
  const a = net.add('dev-a', 'alice');
  const b = net.add('dev-b', 'bob');
  a.mesh.connect('dev-b', 'bob', true);
  b.mesh.connect('dev-a', 'alice', true);
  await net.settle(600);
  assert.deepEqual(connectedPeers(a), ['dev-b']);
  assert.deepEqual(connectedPeers(b), ['dev-a']);
  assert.equal(a.mesh.size, 1);
  assert.equal(b.mesh.size, 1);
  assert.equal(a.mesh.session('dev-b')!.peer.signalingState, 'stable');
  assert.equal(b.mesh.session('dev-a')!.peer.signalingState, 'stable');
});

test('leave: "bye" closes the connection on every other device', async () => {
  const net = network();
  const firstPeer = FakePeer.all.length;
  const a = net.add('dev-a', 'alice');
  const b = net.add('dev-b', 'bob');
  const c = net.add('dev-c', 'carol');
  b.mesh.connect('dev-a', 'alice', true);
  c.mesh.connect('dev-a', 'alice', true);
  c.mesh.connect('dev-b', 'bob', true);
  await net.settle(500);
  const cPeers = FakePeer.all.slice(firstPeer).filter((p) => p.owner === 'dev-c');
  assert.equal(cPeers.length, 2);
  c.mesh.closeAll(true);
  await net.settle(200);
  assert.deepEqual(a.mesh.list().map((p) => p.deviceId), ['dev-b']);
  assert.deepEqual(b.mesh.list().map((p) => p.deviceId), ['dev-a']);
  assert.ok(cPeers.every((p) => p.closed), 'the leaver closed its peer connections');
  assert.equal(c.mesh.connect('dev-a', 'alice', true), 'full', 'a closed mesh accepts nothing');
});

test('admission: offers from devices that are not call participants are refused', async () => {
  const net = network();
  const a = net.add('dev-a', 'alice');
  const outsider = net.add('dev-x', 'mallory');
  a.admit = (deviceId) => deviceId !== 'dev-x';
  outsider.mesh.connect('dev-a', 'alice', true);
  await net.settle();
  assert.equal(a.mesh.size, 0, 'no connection was created for the outsider');
  assert.deepEqual(a.rejected, ['dev-x']);
});

test('impersonation: a device signing with the wrong key is rejected before the mesh sees it', async () => {
  const net = network();
  const a = net.add('dev-a', 'alice');
  const mallory = generateIdentityKeyPair(sodium);
  // "dev-b" is registered (pinned) with its real key, but this instance signs with Mallory's.
  const fake = net.add('dev-b', 'bob', { keysOverride: mallory });
  fake.mesh.connect('dev-a', 'alice', true);
  await net.settle();
  assert.equal(a.mesh.size, 0);
  assert.ok(a.rejected.some((r) => /authentication|binding/.test(r)), `rejected: ${a.rejected.join(';')}`);
});

test('a device of a different user cannot take over an existing connection', async () => {
  const net = network();
  const a = net.add('dev-a', 'alice');
  const b = net.add('dev-b', 'bob');
  b.mesh.connect('dev-a', 'alice', true);
  await net.settle();
  // Same device id, now claiming a different owner (the key directory would never return this).
  const r = await a.mesh.handleSignal({ deviceId: 'dev-b', userId: 'eve' }, { type: 'restart', data: {}, sid: 'x', seq: 1 }, () => true);
  assert.equal(r, 'rejected');
});

test('limit: a mesh never holds more peers than allowed', async () => {
  const net = network();
  const a = net.add('dev-a', 'alice', { maxPeers: 1 });
  const b = net.add('dev-b', 'bob');
  const c = net.add('dev-c', 'carol');
  b.mesh.connect('dev-a', 'alice', true);
  await net.settle();
  c.mesh.connect('dev-a', 'alice', true);
  await net.settle();
  assert.equal(a.mesh.size, 1);
  assert.deepEqual(a.rejected, ['dev-c']);
  assert.equal(a.mesh.connect('dev-z', 'zed', true), 'full');
  assert.equal(a.mesh.connect('dev-a', 'alice', true), 'self');
  assert.equal(a.mesh.connect('dev-b', 'bob', true), 'exists');
});

test('video added mid-call renegotiates; later swaps use replaceTrack without a new offer', async () => {
  const net = network();
  const a = net.add('dev-a', 'alice');
  const b = net.add('dev-b', 'bob');
  b.mesh.connect('dev-a', 'alice', true);
  await net.settle();
  const camera = new FakeTrack('video');
  await b.mesh.setTrack('video', camera);
  await net.settle();
  const remote = a.mesh.list()[0].stream!;
  assert.equal(remote.getVideoTracks().length, 1, 'remote sees the new video track');
  const pcB = b.mesh.session('dev-a')!.peer as FakePeer;
  const offersBefore = pcB.offers;
  const screen = new FakeTrack('video');
  await b.mesh.setTrack('video', screen); // screen share
  await net.settle(100);
  assert.equal(pcB.offers, offersBefore, 'replaceTrack needs no renegotiation');
  assert.equal(pcB.senders.find((s) => s.track?.kind === 'video')?.track, screen);
  await b.mesh.setTrack('video', null); // camera off
  assert.equal(pcB.senders.find((s) => s.replaced > 0)?.track, null);
});

test('ICE failure triggers a restart offer from the impolite side and recovers', async () => {
  const net = network();
  const a = net.add('dev-a', 'alice');
  const b = net.add('dev-b', 'bob');
  b.mesh.connect('dev-a', 'alice', true);
  await net.settle();
  const impolite = isPolite('dev-a', 'dev-b') ? b : a;
  const polite = impolite === a ? b : a;
  const pcPolite = polite.mesh.session(impolite.id)!.peer as FakePeer;
  pcPolite.setIce('failed'); // polite side notices first and asks for a restart
  await net.settle(300);
  const pcImpolite = impolite.mesh.session(polite.id)!.peer as FakePeer;
  assert.ok(polite.sent.some((s) => s.type === 'restart'), 'polite peer asked for a restart');
  assert.match(pcImpolite.localDescription!.sdp, /restart/, 'impolite peer sent an ICE-restart offer');
  pcPolite.setIce('connected');
  assert.equal(polite.mesh.list()[0].state, 'connected');
});

test('local media: camera on/off, screen share and restore drive the sent video track', async () => {
  const sent: (string | null)[] = [];
  const local = new LocalMedia({
    adapter: fakeAdapter('me'),
    onSendTrack: async (kind, track) => {
      if (kind === 'video') sent.push(track ? track.id : null);
    },
    onChange: () => {},
  });
  await local.start(false); // voice call
  assert.equal(local.tracks.video, null);
  local.setMicMuted(true);
  assert.equal(local.tracks.audio!.enabled, false, 'mute disables the real audio track');
  await local.setCameraOn(true);
  const cam = local.tracks.video!;
  assert.equal(sent.at(-1), cam.id);
  await local.startScreenShare();
  const screen = local.tracks.video!;
  assert.notEqual(screen.id, cam.id);
  assert.equal(sent.at(-1), screen.id, 'screen replaces the camera for everyone');
  assert.equal(local.state.screenSharing, true);
  await local.stopScreenShare();
  assert.equal(sent.at(-1), cam.id, 'camera comes back after sharing');
  await local.setCameraOn(false);
  assert.equal(sent.at(-1), null);
  assert.equal(cam.readyState, 'ended', 'camera off releases the camera');
  assert.equal(local.stream!.getVideoTracks().length, 0);
  local.stop();
  assert.equal(local.tracks.audio, null);
});

test('audio levels are read from WebRTC stats', async () => {
  const net = network();
  const a = net.add('dev-a', 'alice');
  const b = net.add('dev-b', 'bob');
  b.mesh.connect('dev-a', 'alice', true);
  await net.settle();
  const levels = await a.mesh.remoteAudioLevels();
  assert.equal(levels.get('dev-b'), 0.3);
  assert.equal(await a.mesh.localAudioLevel(), 0.6);
  const legacy = new Map([['t', { type: 'track', kind: 'audio', remoteSource: true, audioLevel: 0.9 }]]);
  assert.equal(audioLevelFromStats(legacy, 'inbound'), 0.9);
  assert.equal(audioLevelFromStats(new Map(), 'inbound'), 0);
});
