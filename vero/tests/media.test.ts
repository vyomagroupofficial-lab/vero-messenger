import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_THUMB_LENGTH, parsePayload, sanitizeFileName, toMessageMedia } from '../src/shared/models/payload';
import {
  downsampleWaveform,
  formatDuration,
  meteringToLevel,
  nextRate,
  resampleForDisplay,
  sanitizeWaveform,
  WAVEFORM_BARS,
  WAVEFORM_MAX,
} from '../src/features/media/waveform';
import { parseStoryPayload } from '../src/features/stories/payload';
import type { MediaAttachment } from '../src/shared/models/Message';

const base = {
  mediaId: '6f1c2c1e-0000-4000-8000-000000000001',
  objectId: 'sb:conv/6f1c2c1e-0000-4000-8000-000000000001',
  key: 'k'.repeat(43),
  nonce: 'h'.repeat(32),
  hash: 'a'.repeat(64),
  mimeType: 'audio/mp4',
  size: 12345,
};

const media = (kind: string, m: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parsePayload(JSON.stringify({ t: 'media', kind, media: { ...base, ...m }, ...extra }));

describe('voice / media payloads', () => {
  test('voice note with v2 format, duration and waveform round-trips', () => {
    const waveform = downsampleWaveform([0.1, 0.5, 1, 0.2], WAVEFORM_BARS);
    const p = media('voice', { v: 2, chunkSize: 65536, durationMs: 4200, waveform });
    assert.ok(p && p.t === 'media' && p.kind === 'voice');
    assert.equal(p.media.v, 2);
    assert.equal(p.media.chunkSize, 65536);
    assert.equal(p.media.durationMs, 4200);
    assert.deepEqual(p.media.waveform, waveform);
    assert.equal(p.media.mimeType, 'audio/mp4');
  });

  test('old (v1) attachments still parse without a format field', () => {
    const p = media('image', { mimeType: 'image/jpeg' });
    assert.ok(p && p.t === 'media');
    assert.equal(p.media.v, undefined);
    assert.equal(p.media.chunkSize, undefined);
  });

  test('unknown formats or bad chunk sizes are rejected', () => {
    assert.equal(media('voice', { v: 3 }), null);
    assert.equal(media('voice', { v: '2', chunkSize: 65536 }), null);
    assert.equal(media('voice', { v: 2 }), null, 'v2 needs a chunk size');
    assert.equal(media('voice', { v: 2, chunkSize: 10 }), null);
    assert.equal(media('voice', { v: 2, chunkSize: 1e9 }), null);
    assert.equal(media('voice', { size: 1.5 }), null);
    assert.equal(media('voice', { size: -1 }), null);
  });

  test('hostile waveforms are dropped, not trusted', () => {
    for (const waveform of [[101], [-1], [1.5], ['9'], new Array(300).fill(1), 'abc', [], null]) {
      const p = media('voice', { waveform });
      assert.ok(p && p.t === 'media');
      assert.equal(p.media.waveform, undefined, JSON.stringify(waveform).slice(0, 30));
    }
    const img = media('image', { mimeType: 'image/jpeg', waveform: [1, 2, 3] });
    assert.ok(img && img.t === 'media');
    assert.equal(img.media.waveform, undefined, 'only voice notes carry a waveform');
  });

  test('thumbnails: base64 only, bounded, images/videos only', () => {
    const ok = media('video', { mimeType: 'video/mp4', thumb: '/9j/4AAQSkZJRg==', width: 1920, height: 1080, durationMs: 61000 });
    assert.ok(ok && ok.t === 'media');
    assert.equal(ok.media.thumb, '/9j/4AAQSkZJRg==');
    assert.equal(ok.media.width, 1920);
    assert.equal(ok.media.height, 1080);
    assert.equal(ok.media.durationMs, 61000);
    for (const thumb of ['<script>', 'x'.repeat(MAX_THUMB_LENGTH + 4), 42]) {
      const p = media('image', { mimeType: 'image/jpeg', thumb });
      assert.ok(p && p.t === 'media');
      assert.equal(p.media.thumb, undefined);
    }
    const doc = media('document', { mimeType: 'application/pdf', thumb: 'AAAA' });
    assert.ok(doc && doc.t === 'media');
    assert.equal(doc.media.thumb, undefined);
  });

  test('dimensions and durations are validated', () => {
    const p = media('image', { mimeType: 'image/png', width: 0, height: 100, durationMs: -5 });
    assert.ok(p && p.t === 'media');
    assert.equal(p.media.width, undefined);
    assert.equal(p.media.height, undefined);
    assert.equal(p.media.durationMs, undefined);
    const huge = media('video', { mimeType: 'video/mp4', width: 1e9, height: 10, durationMs: 1e12 });
    assert.ok(huge && huge.t === 'media');
    assert.equal(huge.media.width, undefined);
    assert.equal(huge.media.durationMs, undefined);
  });

  test('file names are stripped of paths and bidi tricks', () => {
    assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFileName('C:\\Users\\x\\report.pdf'), 'report.pdf');
    assert.equal(sanitizeFileName('evil\u202Efdp.exe'), 'evilfdp.exe');
    assert.equal(sanitizeFileName('...hidden'), 'hidden');
    assert.equal(sanitizeFileName('a\u0000b.txt'), 'ab.txt');
    assert.equal(sanitizeFileName(''), undefined);
    assert.equal(sanitizeFileName(42), undefined);
    assert.equal(sanitizeFileName('x'.repeat(400))?.length, 255);
    const p = media('document', { mimeType: 'application/pdf', fileName: '/tmp/Invoice\u202Etxt.exe' });
    assert.ok(p && p.t === 'media');
    assert.equal(p.media.fileName, 'Invoicetxt.exe');
  });

  test('device-local fields never go on the wire', () => {
    const local: MediaAttachment = { ...base, localUri: 'file:///cache/x.m4a', playedAt: '2026-01-01T00:00:00Z' };
    const wire = toMessageMedia(local);
    assert.equal((wire as MediaAttachment).localUri, undefined);
    assert.equal((wire as MediaAttachment).playedAt, undefined);
    const p = media('voice', { localUri: 'file:///etc/passwd', playedAt: 'yesterday' });
    assert.ok(p && p.t === 'media');
    assert.equal((p.media as MediaAttachment).localUri, undefined);
    assert.equal((p.media as MediaAttachment).playedAt, undefined);
  });

  test('story media refs carry the attachment format', () => {
    const ref = { path: 'a/b/c.bin', key: 'k', nonce: 'n', hash: 'h', mimeType: 'image/jpeg', size: 10 };
    const v2 = parseStoryPayload(JSON.stringify({ t: 'story', kind: 'image', media: { ...ref, v: 2, chunkSize: 65536 } }));
    assert.ok(v2 && v2.kind === 'image');
    assert.equal(v2.media.v, 2);
    assert.equal(v2.media.chunkSize, 65536);
    const v1 = parseStoryPayload(JSON.stringify({ t: 'story', kind: 'image', media: ref }));
    assert.ok(v1 && v1.kind === 'image');
    assert.equal(v1.media.v, undefined);
    assert.equal(parseStoryPayload(JSON.stringify({ t: 'story', kind: 'image', media: { ...ref, v: 2 } })), null);
    assert.equal(parseStoryPayload(JSON.stringify({ t: 'story', kind: 'image', media: { ...ref, v: 9 } })), null);
  });
});

describe('waveform', () => {
  test('metering dBFS maps to 0..1', () => {
    assert.equal(meteringToLevel(0), 1);
    assert.equal(meteringToLevel(5), 1);
    assert.equal(meteringToLevel(-60), 0);
    assert.equal(meteringToLevel(-160), 0);
    assert.equal(meteringToLevel(-30), 0.5);
    assert.equal(meteringToLevel(undefined), 0);
    assert.equal(meteringToLevel(NaN), 0);
  });

  test('downsampling keeps peaks and always yields exactly 64 bars of 0..100', () => {
    const samples = new Array(1000).fill(0.1);
    samples[500] = 0.9; // one short syllable
    const w = downsampleWaveform(samples);
    assert.equal(w.length, WAVEFORM_BARS);
    assert.ok(w.every((v) => Number.isInteger(v) && v >= 0 && v <= WAVEFORM_MAX));
    assert.equal(Math.max(...w), WAVEFORM_MAX, 'normalised so the loudest bar is full height');
    assert.equal(w[Math.floor((500 * WAVEFORM_BARS) / 1000)], WAVEFORM_MAX, 'the peak lands in its bucket');
    assert.equal(w.filter((v) => v === WAVEFORM_MAX).length, 1, 'a short peak is not smeared');
  });

  test('short recordings are stretched; silence and junk are safe', () => {
    const w = downsampleWaveform([0.2, 1]);
    assert.equal(w.length, WAVEFORM_BARS);
    assert.equal(w[0], 20);
    assert.equal(w[WAVEFORM_BARS - 1], 100);
    assert.deepEqual(downsampleWaveform([]), new Array(WAVEFORM_BARS).fill(0));
    assert.deepEqual(downsampleWaveform([0, 0, 0]), new Array(WAVEFORM_BARS).fill(0));
    assert.ok(downsampleWaveform([NaN, Infinity, -1, 2]).every((v) => v >= 0 && v <= 100));
    assert.deepEqual(downsampleWaveform([1], 0), []);
  });

  test('sanitize / resample / format', () => {
    assert.deepEqual(sanitizeWaveform([0, 50, 100]), [0, 50, 100]);
    assert.equal(sanitizeWaveform([0, 50, 100.5]), undefined);
    const display = resampleForDisplay(downsampleWaveform([0.1, 1, 0.1]), 40);
    assert.equal(display.length, 40);
    assert.deepEqual(resampleForDisplay(undefined, 3), [0, 0, 0]);
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(4_200), '0:04');
    assert.equal(formatDuration(61_000), '1:01');
    assert.equal(formatDuration(3_725_000), '1:02:05');
  });

  test('playback speed cycles 1x -> 1.5x -> 2x -> 1x', () => {
    assert.equal(nextRate(1), 1.5);
    assert.equal(nextRate(1.5), 2);
    assert.equal(nextRate(2), 1);
    assert.equal(nextRate(3), 1);
  });
});
