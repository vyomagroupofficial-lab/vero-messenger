import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, parseManifest, versionCode } from '../src/features/updates/version';

test('compareVersions orders semver numerically', () => {
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0', '1.0.1'), -1);
  assert.equal(compareVersions('2.0.0-rc.1', '1.9.9'), 1);
});

test('versionCode grows with every release', () => {
  assert.equal(versionCode('1.0.0'), 10000);
  assert.equal(versionCode('v1.2.3'), 10203);
  assert.ok(versionCode('1.10.0') > versionCode('1.9.99'));
});

test('parseManifest accepts only GitHub release APK URLs', () => {
  const ok = parseManifest({ version: 'v1.1.0', notes: 'x', android: { url: 'https://github.com/o/r/releases/download/v1.1.0/Vero-v1.1.0.apk', sha256: 'A'.repeat(64), size: 10 } });
  assert.equal(ok?.version, '1.1.0');
  assert.equal(ok?.android?.sha256, 'a'.repeat(64));
  assert.equal(parseManifest({ version: '1.1.0', android: { url: 'https://evil.example/x.apk' } })?.android, undefined);
  assert.equal(parseManifest({ version: 'latest' }), null);
  assert.equal(parseManifest(null), null);
});
