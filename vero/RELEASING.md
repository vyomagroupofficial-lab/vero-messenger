# Releasing Vero

`.github/workflows/release.yml` builds every client on GitHub's runners:

| Output | Built on |
|---|---|
| Android APK (`Vero-vX.Y.Z.apk`) | ubuntu-latest (Expo prebuild + Gradle) |
| Web build (`Vero-web-vX.Y.Z.zip`) | ubuntu-latest (`expo export --platform web`) |
| Windows installer (`.exe`) | windows-latest (electron-builder NSIS) |
| macOS disk image (`.dmg`) | macos-latest (unsigned) |
| Linux (`.AppImage`, `.deb`) | ubuntu-latest |

## Publish a release

```bash
git tag v1.0.0 && git push origin v1.0.0
```

The workflow builds everything and attaches it to a GitHub Release for that tag.
Pushing a change to the workflow file on a `claude/**` branch runs a dry run
(builds only, artifacts on the run page, no release).

## One-time: Android signing key (required for in-app updates)

Android only installs an update over an existing app if both are signed with
the same key. Add these repository secrets (Settings → Secrets and variables
→ Actions):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | base64 of the release keystore |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | `vero` |
| `ANDROID_KEY_PASSWORD` | key password |

Keep the keystore safe and backed up: losing it means users must uninstall to
upgrade. Without the secrets, builds are signed with a throwaway debug key.

## Optional

- Repository variables `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`
  point builds at another Supabase project.
- Windows/macOS code-signing certificates (`CSC_LINK`, `CSC_KEY_PASSWORD`) remove
  the "unknown publisher" warnings.
