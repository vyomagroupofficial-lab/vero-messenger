// In-app updates.
//   Android: the release workflow publishes vero-update.json next to the APK on
//   GitHub Releases. We compare it with the installed version, download the APK
//   and hand it to Android's package installer (same signing key required).
//   Web: the build ships /version.json; a different build id means "reload".
//   iOS: updates come from the App Store / TestFlight, so nothing to do here.
import { Platform } from 'react-native';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import { compareVersions, parseManifest, type UpdateManifest } from './version';

const REPO = 'vyomagroupofficial-lab/vero-messenger';
export const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/vero-update.json`;
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

export type UpdateCheck =
  | { kind: 'none' }
  | { kind: 'android'; manifest: UpdateManifest }
  | { kind: 'web'; version: string };

export function installedVersion(): string {
  return Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '0.0.0';
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store' } as RequestInit);
  if (!res.ok) throw new Error(`Update check failed (${res.status})`);
  return res.json();
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  if (Platform.OS === 'web') {
    const build = process.env.EXPO_PUBLIC_BUILD_ID;
    if (!build || typeof window === 'undefined') return { kind: 'none' };
    const data = (await fetchJson(`/version.json?t=${Date.now()}`)) as { build?: string; version?: string };
    return data?.build && data.build !== build ? { kind: 'web', version: data.version ?? '' } : { kind: 'none' };
  }
  if (Platform.OS !== 'android') return { kind: 'none' };
  const manifest = parseManifest(await fetchJson(MANIFEST_URL));
  if (!manifest?.android) return { kind: 'none' };
  return compareVersions(manifest.version, installedVersion()) > 0 ? { kind: 'android', manifest } : { kind: 'none' };
}

/** Downloads the APK and opens the system installer. Resolves when the installer is shown. */
export async function installAndroidUpdate(manifest: UpdateManifest, onProgress?: (fraction: number) => void): Promise<void> {
  if (Platform.OS !== 'android' || !manifest.android) throw new Error('No Android update available');
  const target = `${FileSystem.cacheDirectory}vero-update-${manifest.version}.apk`;
  await FileSystem.deleteAsync(target, { idempotent: true });
  const task = FileSystem.createDownloadResumable(manifest.android.url, target, {}, (p) => {
    if (p.totalBytesExpectedToWrite > 0) onProgress?.(p.totalBytesWritten / p.totalBytesExpectedToWrite);
  });
  const result = await task.downloadAsync();
  if (!result || result.status !== 200) throw new Error('Download failed');
  if (manifest.android.size) {
    const info = await FileSystem.getInfoAsync(target);
    if (!info.exists || info.size !== manifest.android.size) throw new Error('Downloaded update is incomplete');
  }
  const IntentLauncher = await import('expo-intent-launcher');
  const contentUri = await FileSystem.getContentUriAsync(target);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    type: 'application/vnd.android.package-archive',
  });
}

export function reloadWeb(): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.location.reload();
}
