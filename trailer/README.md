# Vero — launch trailer

A ~48 second, beat-synced motion-graphics trailer for Vero Messenger, built with
[Remotion](https://www.remotion.dev). The app screens are rebuilt as React
components from the real code in `../vero/app`, using the same colours, sizes,
copy, icons and demo data, so every element can be animated.

Two compositions:

| id                    | size      | use                         |
| --------------------- | --------- | --------------------------- |
| `VeroTrailer`         | 1920×1080 | YouTube, X, website         |
| `VeroTrailerVertical` | 1080×1920 | Reels, TikTok, Shorts       |

## Live edit in the browser

```bash
cd trailer
npm install
npm run studio          # opens http://localhost:3000
```

Remotion Studio hot-reloads on every save. Scrub the timeline, edit any file in
`src/` and you see the change straight away. Render from the Studio's
**Render** button or from the CLI.

## Use the real song (FUNK ABNORMAL)

The repo ships with an original placeholder beat (`public/placeholder-beat.mp3`,
130 BPM) so it renders out of the box. To switch to the real track:

1. Get the audio file yourself. Use a copy you have the rights to use for a
   promo (licensed, or with the artist's permission). Name it
   `public/music.mp3`. It's git-ignored, so it never gets committed.
2. Sync it:
   ```bash
   npm run sync
   ```
   This detects the tempo and the song's first drop. It then writes
   `src/music.json` so the drop hits on **beat 16**, the frame where the VERO
   logo slams in. Every cut in the trailer comes from that beat grid, so the
   whole edit follows the song.
3. If you want a different part of the song:
   ```bash
   npm run sync -- --drop 41.5      # drop time in seconds
   npm run sync -- --bpm 130        # force the tempo if detection is off
   npm run sync -- --placeholder    # go back to the placeholder beat
   ```
4. Render:
   ```bash
   npm run render            # out/vero-trailer.mp4
   npm run render:vertical   # out/vero-trailer-vertical.mp4
   ```

`src/music.json` also has `musicVolume` and `sfxVolume`. The SFX layer
(impacts, whooshes, glitches in `public/sfx`) sits on top of the song. Set
`sfxVolume` to `0` to hear only the music.

## Edit map

All timing is in **beats** (`src/timing.ts → SECTIONS`):

| beats   | scene                      | file                    |
| ------- | -------------------------- | ----------------------- |
| 0–16    | cold open / "intercepted"  | `scenes/Open.tsx`       |
| 16–24   | **drop**: logo slam         | `scenes/Open.tsx`       |
| 24–32   | chat list                  | `scenes/Features.tsx`   |
| 32–40   | live conversation          | `scenes/Features.tsx`   |
| 40–44   | plaintext → ciphertext     | `scenes/Features.tsx`   |
| 44–48   | photos / videos / voice / files | `scenes/Features.tsx` |
| 48–56   | P2P encrypted calls        | `scenes/Security.tsx`   |
| 56–64   | safety number → VERIFIED   | `scenes/Security.tsx`   |
| 64–72   | groups + disappearing msgs | `scenes/Security.tsx`   |
| 72–80   | zero-knowledge diagram     | `scenes/Security.tsx`   |
| 80–88   | build-up montage           | `scenes/Finale.tsx`     |
| 88–104  | final logo + CTA           | `scenes/Finale.tsx`     |

- Screens: `src/screens/*` (recreated from `vero/app/**`).
- Effects (shake, flash, RGB split, glitch, grain, speed lines):
  `src/fx/index.tsx`.
- Change the CTA ("COMING SOON") in `scenes/Finale.tsx`.

## Other scripts

- `npm run placeholder-audio`: regenerates the placeholder beat and SFX
  (needs Python 3 + numpy + scipy).
- `node scripts/build-icons.mjs`: re-inlines the Ionicons used, after you add
  names to its list.
- `node scripts/stills.mjs VeroTrailer out/stills 230 600 1300`: renders single
  frames for quick review.

In a container without Chrome downloads, point Remotion at a local Chromium:
`REMOTION_BROWSER=/path/to/chrome npm run render`.

Fonts in `public/fonts` (Inter, Anton, JetBrains Mono, Unbounded) are under the
SIL Open Font License.
