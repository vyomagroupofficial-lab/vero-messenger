// Expo config plugin for Vero calls (react-native-webrtc + react-native-incall-manager).
//
// Used instead of @config-plugins/react-native-webrtc, which adds
// SYSTEM_ALERT_WINDOW and misses what Android 12-14 need for Bluetooth headsets
// and screen sharing (MediaProjection foreground service).
//
// Options (app.json -> plugins -> ["./plugins/withVeroCalls", { ... }]):
//   cameraPermission / microphonePermission  iOS usage strings (only set when
//                                            no other plugin already did)
//   iosScreenShareExtension                  bundle id of a Broadcast Upload
//                                            Extension (enables iOS screen sharing)
//   iosAppGroup                              App Group shared with that extension
//
// Native modules only work in a development / production build
// (`npx expo run:android`, `eas build`), never in Expo Go.
const { AndroidConfig, withAndroidManifest, withInfoPlist, createRunOncePlugin } = require('expo/config-plugins');

const ANDROID_PERMISSIONS = [
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.INTERNET',
  'android.permission.WAKE_LOCK',
  'android.permission.VIBRATE',
  // Bluetooth headsets (Android 12+ runtime permission).
  'android.permission.BLUETOOTH_CONNECT',
  // Screen sharing runs react-native-webrtc's MediaProjectionService
  // (foregroundServiceType="mediaProjection", declared in the library manifest).
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
  // Keep camera / microphone working while a call runs in the background.
  'android.permission.FOREGROUND_SERVICE_CAMERA',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
];

function withLegacyBluetooth(config) {
  return withAndroidManifest(config, (c) => {
    const manifest = c.modResults.manifest;
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    const list = manifest['uses-permission'];
    const name = 'android.permission.BLUETOOTH';
    if (!list.some((p) => p.$ && p.$['android:name'] === name)) {
      // Pre-Android 12 only; BLUETOOTH_CONNECT replaces it.
      list.push({ $: { 'android:name': name, 'android:maxSdkVersion': '30' } });
    }
    return c;
  });
}

function withCallsInfoPlist(config, props) {
  return withInfoPlist(config, (c) => {
    const plist = c.modResults;
    if (!plist.NSCameraUsageDescription) {
      plist.NSCameraUsageDescription =
        props.cameraPermission || 'Vero uses the camera for video calls and for photos you send end-to-end encrypted.';
    }
    if (!plist.NSMicrophoneUsageDescription) {
      plist.NSMicrophoneUsageDescription =
        props.microphonePermission || 'Vero uses the microphone for calls and voice messages.';
    }
    // audio: keep a call's audio running when the app goes to the background.
    // voip: needed for a future CallKit / PushKit integration (see README "Calls").
    const modes = new Set(plist.UIBackgroundModes || []);
    modes.add('audio');
    modes.add('voip');
    plist.UIBackgroundModes = [...modes];
    if (props.iosScreenShareExtension) {
      plist.RTCScreenSharingExtension = props.iosScreenShareExtension;
      if (props.iosAppGroup) plist.RTCAppGroupIdentifier = props.iosAppGroup;
    }
    return c;
  });
}

const withVeroCalls = (config, props = {}) => {
  config = AndroidConfig.Permissions.withPermissions(config, ANDROID_PERMISSIONS);
  config = withLegacyBluetooth(config);
  config = withCallsInfoPlist(config, props || {});
  return config;
};

module.exports = createRunOncePlugin(withVeroCalls, 'vero-calls', '1.0.0');
