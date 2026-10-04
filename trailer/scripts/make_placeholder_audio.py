#!/usr/bin/env python3
"""
Synthesises an original phonk / brazilian-funk style placeholder beat plus the
trailer's sound-effects, all locked to the same beat grid the video uses.

The placeholder lets the trailer render with audio out of the box. Drop the
real song in `public/` and run `npm run sync` to switch over (see README).

Outputs:
  public/placeholder-beat.mp3
  public/sfx/impact.wav, whoosh.wav, glitch.wav, riser.wav
"""
import os
import subprocess
import wave

import numpy as np
from scipy.signal import lfilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")
SR = 44100

BPM = 130.0  # the placeholder is always 130 BPM, music.json is rewritten by sync
BEAT = 60.0 / BPM
S16 = BEAT / 4
TOTAL_BEATS = 108
N = int(SR * BEAT * TOTAL_BEATS) + SR

rng = np.random.default_rng(7)


def t_of(n):
    return np.arange(n) / SR


def env_exp(n, decay):
    return np.exp(-t_of(n) / decay)


def place(buf, sig, at_sec, gain=1.0):
    i = int(at_sec * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i] * gain


def onepole_lp(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    return lfilter([1 - a], [1, -a], x)


def hp(x, cutoff):
    return x - onepole_lp(x, cutoff)


# ── instruments ──────────────────────────────────────────────────────────────
def kick(length=0.55):
    n = int(SR * length)
    t = t_of(n)
    freq = 45 + 140 * np.exp(-t / 0.035)
    phase = 2 * np.pi * np.cumsum(freq) / SR
    s = np.sin(phase) * env_exp(n, 0.22)
    click = rng.standard_normal(n) * env_exp(n, 0.003) * 0.4
    return np.tanh((s + click) * 2.6) * 0.9


def clap():
    n = int(SR * 0.28)
    noise = rng.standard_normal(n)
    e = np.zeros(n)
    for off in (0.0, 0.011, 0.022):
        k = int(off * SR)
        e[k:] += np.exp(-t_of(n - k) / 0.012)
    e += 0.6 * np.exp(-t_of(n) / 0.09)
    s = hp(noise, 900) * e
    return np.tanh(s * 1.4) * 0.55


def hat(open_=False):
    n = int(SR * (0.18 if open_ else 0.05))
    s = hp(rng.standard_normal(n), 7000) * env_exp(n, 0.06 if open_ else 0.012)
    return s * 0.35


def cowbell(freq_mult=1.0, length=0.22):
    # classic 808 cowbell: two detuned squares, band-limited, sharp decay
    n = int(SR * length)
    t = t_of(n)
    f1, f2 = 540 * freq_mult, 800 * freq_mult
    sq = np.sign(np.sin(2 * np.pi * f1 * t)) + np.sign(np.sin(2 * np.pi * f2 * t))
    e = 0.7 * np.exp(-t / 0.015) + 0.3 * np.exp(-t / 0.11)
    s = hp(onepole_lp(sq, 4200), 500) * e
    return s * 0.32


def bass808(freq, length):
    n = int(SR * length)
    t = t_of(n)
    f = freq * (1 + 0.6 * np.exp(-t / 0.02))
    s = np.sin(2 * np.pi * np.cumsum(f) / SR)
    e = np.minimum(1, t / 0.004) * np.exp(-t / (length * 0.9))
    return np.tanh(s * e * 3.0) * 0.55


def noise_riser(length):
    n = int(SR * length)
    t = t_of(n)
    ramp = (t / length) ** 2.2
    noise = rng.standard_normal(n)
    s = hp(noise, 2500) * ramp * 0.35
    sweep = np.sin(2 * np.pi * np.cumsum(200 + 1800 * ramp) / SR) * ramp * 0.18
    return s + sweep


def impact():
    n = int(SR * 2.2)
    t = t_of(n)
    boom = np.sin(2 * np.pi * np.cumsum(30 + 90 * np.exp(-t / 0.08)) / SR) * env_exp(n, 0.7)
    crack = onepole_lp(rng.standard_normal(n), 3000) * env_exp(n, 0.25) * 0.6
    return np.tanh((boom + crack) * 2.0) * 0.8


def whoosh(length=0.45):
    n = int(SR * length)
    t = t_of(n)
    shape = np.sin(np.pi * t / length) ** 2
    noise = rng.standard_normal(n)
    # sweep the cutoff upwards in short chunks
    chunks = np.array_split(noise, 24)
    lo = np.concatenate(
        [onepole_lp(c, 600 + 5000 * i / 24) for i, c in enumerate(chunks)]
    )
    return hp(lo, 300) * shape * 0.6


def glitch():
    n = int(SR * 0.16)
    t = t_of(n)
    sq = np.sign(np.sin(2 * np.pi * (1200 + 900 * np.sign(np.sin(2 * np.pi * 45 * t))) * t))
    crush = np.round(rng.standard_normal(n) * 3) / 3
    return (sq * 0.25 + crush * 0.15) * env_exp(n, 0.06)


# ── arrangement ──────────────────────────────────────────────────────────────
mix = np.zeros(N)
melody_bus = np.zeros(N)

# F# minor-ish phonk cowbell riff, one bar of 16ths (None = rest), semitone offsets
RIFF = [0, None, 0, 3, None, 0, 7, None, 5, None, 3, 0, None, 3, 5, None]
RIFF_B = [0, None, 0, 3, None, 0, 10, None, 8, None, 7, 5, None, 3, 2, None]
BASS = [0, 0, -2, -4]  # root per bar (semitones from F#1)
F_SHARP_1 = 46.25

KICK_16 = [0, 3, 6, 10]          # tamborzão-style kick placement in 16ths
CLAP_16 = [4, 12]

DROP = 16
BREAK = (80, 88)  # filtered build before the finale
END = 104

for beat in range(0, END, 4):  # one bar at a time
    bar_t = beat * BEAT
    bar_i = beat // 4
    riff = RIFF_B if bar_i % 4 == 3 else RIFF
    for s, semi in enumerate(riff):
        if semi is None:
            continue
        place(melody_bus, cowbell(2 ** (semi / 12)), bar_t + s * S16)

    in_drop = DROP <= beat < END and not (BREAK[0] <= beat < BREAK[1])
    if in_drop:
        for s in KICK_16:
            place(mix, kick(), bar_t + s * S16, 1.0)
        for s in CLAP_16:
            place(mix, clap(), bar_t + s * S16)
        for s in range(0, 16, 2):
            place(mix, hat(open_=(s % 8 == 6)), bar_t + s * S16)
        root = F_SHARP_1 * 2 ** (BASS[bar_i % 4] / 12)
        for s in KICK_16:
            place(mix, bass808(root, S16 * 3.2), bar_t + s * S16, 0.9)
    elif beat < DROP:
        # cold open: hats come in on the second half, kick teases the last bar
        if beat >= 8:
            for s in range(0, 16, 2):
                place(mix, hat(), bar_t + s * S16, 0.7)
        if beat == 12:
            for s in (0, 6, 8, 10, 12, 13, 14, 15):
                place(mix, kick(0.25), bar_t + s * S16, 0.55)
    else:  # break
        for s in range(0, 16, 1 if beat >= 84 else 2):
            place(mix, clap() * 0.5, bar_t + s * S16, 0.35 + 0.4 * ((beat - BREAK[0]) / 8))

# the intro and break cowbells are low-passed for that muffled-then-open feel
intro_end = int(DROP * BEAT * SR)
melody_bus[:intro_end] = onepole_lp(melody_bus[:intro_end], 1500) * 1.6
b0, b1 = int(BREAK[0] * BEAT * SR), int(BREAK[1] * BEAT * SR)
melody_bus[b0:b1] = onepole_lp(melody_bus[b0:b1], 1200) * 1.6
mix += melody_bus

# risers + impacts on the drops
riser_len = 4 * BEAT
place(mix, noise_riser(riser_len), (DROP - 4) * BEAT, 0.9)
place(mix, impact(), DROP * BEAT, 0.9)
place(mix, noise_riser(8 * BEAT), BREAK[0] * BEAT, 0.9)
place(mix, impact(), BREAK[1] * BEAT, 1.0)

# tail: let the last impact ring out, then fade
end_s = END * BEAT
place(mix, impact(), end_s - 4 * BEAT, 0.6)
fade_start = int((end_s - 2 * BEAT) * SR)
fade = np.ones(N)
fade[fade_start:] = np.linspace(1, 0, N - fade_start) ** 2
mix *= fade

# soft clip + normalise
mix = np.tanh(mix * 1.2)
mix /= np.max(np.abs(mix)) + 1e-9
mix *= 0.92


def write_wav(path, sig, stereo_width=0.0):
    sig = np.clip(sig, -1, 1)
    if stereo_width:
        d = int(SR * 0.012)
        right = np.concatenate([np.zeros(d), sig[:-d]])
        left_ch = sig
        right_ch = sig * (1 - stereo_width) + right * stereo_width
    else:
        left_ch = right_ch = sig
    data = (np.stack([left_ch, right_ch], axis=1) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


os.makedirs(os.path.join(PUBLIC, "sfx"), exist_ok=True)
tmp = os.path.join(PUBLIC, "placeholder-beat.wav")
write_wav(tmp, mix, stereo_width=0.35)
subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error", "-i", tmp, "-b:a", "192k",
     os.path.join(PUBLIC, "placeholder-beat.mp3")],
    check=True,
)
os.remove(tmp)

for name, sig in {
    "impact": impact(),
    "whoosh": whoosh(),
    "glitch": glitch(),
    "riser": noise_riser(4 * BEAT),
}.items():
    write_wav(os.path.join(PUBLIC, "sfx", f"{name}.wav"), sig / (np.max(np.abs(sig)) + 1e-9) * 0.9)

print(f"placeholder beat: {BPM} BPM, {TOTAL_BEATS} beats, drop at beat {DROP}")
