import React from 'react';
import {interpolate, random} from 'remotion';
import {C, avatarColor} from '../theme';
import {Icon} from '../components/Icon';
import {MONO} from '../fonts';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

// ── Call screen (vero/app/call/[id].tsx) ────────────────────────────────────
export const CallScreen: React.FC<{frame: number; seconds: number; beatPulse: number; video?: boolean}> = ({
  frame,
  seconds,
  beatPulse,
  video = true,
}) => {
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(Math.floor(seconds % 60)).padStart(2, '0');
  const ctl = (icon: string, active?: boolean) => (
    <div
      style={{
        width: 60,
        height: 60,
        borderRadius: 30,
        background: active ? C.accent : 'rgba(255,255,255,0.08)',
        border: `1px solid ${active ? C.accentLight : 'rgba(255,255,255,0.1)'}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={icon} size={24} color={active ? '#fff' : C.text} />
    </div>
  );
  return (
    <div style={{flex: 1, background: C.callBg, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '24px 0 40px'}}>
      <div style={{display: 'flex', justifyContent: 'center', marginTop: 12}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 999, background: 'rgba(6,182,212,0.1)', border: '1px solid rgba(6,182,212,0.3)'}}>
          <Icon name="lock-closed" size={13} color={C.accent} />
          <span style={{fontSize: 13, color: C.accentLight, fontWeight: 600}}>End-to-End Encrypted</span>
        </div>
      </div>
      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
        <div style={{position: 'relative', width: 240, height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
          {[0, 1, 2].map((i) => {
            const ph = ((frame / 30 + i * 0.33) % 1);
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  width: 130 + ph * 110,
                  height: 130 + ph * 110,
                  borderRadius: '50%',
                  border: `2px solid ${C.accent}`,
                  opacity: (1 - ph) * 0.6,
                }}
              />
            );
          })}
          <div
            style={{
              width: 130,
              height: 130,
              borderRadius: 65,
              background: avatarColor('Sarah'),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 42,
              fontWeight: 700,
              transform: `scale(${1 + beatPulse * 0.08})`,
              boxShadow: `0 0 ${40 + beatPulse * 40}px ${C.accentGlow}`,
              border: '3px solid rgba(255,255,255,0.15)',
            }}
          >
            SC
          </div>
        </div>
        <div style={{fontSize: 28, fontWeight: 700, marginTop: 8}}>Sarah Connor</div>
        <div style={{fontSize: 17, color: C.emerald, marginTop: 6, fontFamily: MONO, fontWeight: 700, letterSpacing: 1}}>
          {mm}:{ss}
        </div>
        {video && (
          <div style={{display: 'flex', alignItems: 'center', gap: 6, marginTop: 14, padding: '5px 12px', borderRadius: 999, background: 'rgba(255,255,255,0.05)'}}>
            <Icon name="videocam" size={14} color={C.text2} />
            <span style={{fontSize: 12, color: C.text2}}>Encrypted Video Channel</span>
          </div>
        )}
        {/* live audio waveform */}
        <div style={{display: 'flex', alignItems: 'center', gap: 4, height: 50, marginTop: 20}}>
          {new Array(22).fill(0).map((_, i) => {
            const h = 6 + Math.abs(Math.sin(i * 0.8 + frame / 3)) * 18 + beatPulse * 22 * Math.abs(Math.sin(i * 1.3));
            return <div key={i} style={{width: 4, height: h, borderRadius: 2, background: i % 3 === 0 ? C.emerald : C.accent}} />;
          })}
        </div>
      </div>
      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 28}}>
        <div style={{display: 'flex', gap: 18}}>
          {ctl('mic')}
          {ctl('videocam', true)}
          {ctl('camera-reverse-outline')}
          {ctl('volume-high', true)}
        </div>
        <div style={{width: 72, height: 72, borderRadius: 36, background: C.error, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 24px ${C.error}88`}}>
          <Icon name="call" size={30} color="#fff" style={{transform: 'rotate(135deg)'}} />
        </div>
      </div>
    </div>
  );
};

// ── Verify safety number (vero/app/verify-safety-number.tsx) ────────────────
export const SAFETY_NUMBER = '45210 99823 10452 77312 88124 00192 34109 65521 11842 59021 84729 44012'.split(' ');

export const SafetyScreen: React.FC<{frame: number; reveal: number; verified: number}> = ({frame, reveal, verified}) => {
  const ok = verified > 0.5;
  return (
    <div style={{flex: 1, display: 'flex', flexDirection: 'column'}}>
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: `1px solid ${C.border}`}}>
        <Icon name="arrow-back" size={22} color={C.text} />
        <span style={{fontSize: 17, fontWeight: 700}}>Verify Safety Number</span>
        <Icon name="key" size={20} color={C.text} />
      </div>
      <div style={{padding: 18, display: 'flex', flexDirection: 'column', gap: 16}}>
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            padding: 14,
            borderRadius: 14,
            background: ok ? 'rgba(16,185,129,0.1)' : 'rgba(6,182,212,0.08)',
            border: `1px solid ${ok ? 'rgba(16,185,129,0.35)' : 'rgba(6,182,212,0.25)'}`,
          }}
        >
          <Icon name={ok ? 'checkmark-circle' : 'shield-checkmark-outline'} size={30} color={ok ? C.emerald : C.accent} />
          <div>
            <div style={{fontSize: 15, fontWeight: 700, color: ok ? C.emerald : C.text}}>{ok ? 'Identity Verified' : 'Verify Sarah Connor'}</div>
            <div style={{fontSize: 12, color: C.text2, marginTop: 2}}>Compare these numbers on both devices.</div>
          </div>
        </div>
        <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 16, borderRadius: 18, background: C.surface, border: `1px solid ${C.border}`, position: 'relative', overflow: 'hidden'}}>
          <div style={{padding: 10, borderRadius: 14, background: 'rgba(6,182,212,0.06)'}}>
            <Icon name="qr-code" size={140} color={C.accentLight} />
          </div>
          {/* scanning laser */}
          {!ok && (
            <div style={{position: 'absolute', left: 30, right: 30, top: 24 + ((frame * 6) % 150), height: 2, background: C.accentLight, boxShadow: `0 0 12px ${C.accentLight}`}} />
          )}
          <div style={{fontSize: 11, color: C.text3, marginTop: 10, textAlign: 'center'}}>Scan QR code on peer device for instant zero-knowledge pairing</div>
        </div>
        <div style={{padding: 16, borderRadius: 18, background: C.surface, border: `1px solid ${C.border}`}}>
          <div style={{fontSize: 12, fontWeight: 700, color: C.text2, marginBottom: 12, letterSpacing: 0.4}}>60-Digit Numeric Fingerprint</div>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10}}>
            {SAFETY_NUMBER.map((block, i) => {
              const p = interpolate(reveal, [i / 12, i / 12 + 0.12], [0, 1], clamp);
              const settled = p >= 1;
              const shown = settled
                ? block
                : block
                    .split('')
                    .map((_, k) => Math.floor(random(`sn${i}${k}${frame}`) * 10))
                    .join('');
              return (
                <div
                  key={i}
                  style={{
                    fontFamily: MONO,
                    fontWeight: 700,
                    fontSize: 17,
                    letterSpacing: 1.5,
                    textAlign: 'center',
                    padding: '7px 0',
                    borderRadius: 8,
                    background: settled ? (ok ? 'rgba(16,185,129,0.12)' : 'rgba(6,182,212,0.08)') : 'rgba(255,255,255,0.03)',
                    color: settled ? (ok ? C.emeraldLight : C.text) : C.text3,
                    opacity: p > 0 ? 1 : 0.35,
                  }}
                >
                  {p > 0 ? shown : '•••••'}
                </div>
              );
            })}
          </div>
        </div>
        <div
          style={{
            height: 52,
            borderRadius: 14,
            background: ok ? C.emerald : C.accent,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            fontWeight: 700,
            fontSize: 16,
            boxShadow: `0 0 24px ${ok ? C.emerald : C.accent}66`,
            transform: `scale(${1 + Math.max(0, 1 - Math.abs(verified - 0.5) * 6) * 0.06})`,
          }}
        >
          <Icon name={ok ? 'checkmark-circle' : 'finger-print'} size={20} color="#fff" />
          {ok ? 'Verified' : 'Mark as Verified'}
        </div>
      </div>
    </div>
  );
};

// ── New group (vero/app/new-group.tsx) ──────────────────────────────────────
const GROUP_CONTACTS = [
  ['Sarah Connor', 'sarah_c', '#0284C7'],
  ['Marcus Vance', 'marcus_v', '#7C3AED'],
  ['Elena Rostova', 'elena_r', '#0D9488'],
  ['David Kim', 'david_k', '#D97706'],
  ['Priya Sharma', 'priya_s', '#E11D48'],
  ['Kai Nakamura', 'kai_n', '#4F46E5'],
];

export const NewGroupScreen: React.FC<{frame: number; selected: number; typed: string}> = ({frame, selected, typed}) => (
  <div style={{flex: 1, display: 'flex', flexDirection: 'column'}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: `1px solid ${C.border}`}}>
      <div style={{width: 36, height: 36, borderRadius: 18, background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
        <Icon name="arrow-back" size={20} color={C.text} />
      </div>
      <div style={{flex: 1}}>
        <div style={{fontSize: 17, fontWeight: 700}}>New Encrypted Group</div>
        <div style={{fontSize: 11, color: C.purpleLight, fontWeight: 600}}>Pairwise Double Ratchet</div>
      </div>
      <div style={{padding: '8px 16px', borderRadius: 999, background: selected >= 2 ? C.accent : 'rgba(255,255,255,0.06)', fontWeight: 700, fontSize: 14}}>Create</div>
    </div>
    <div style={{display: 'flex', alignItems: 'center', gap: 14, padding: 16}}>
      <div style={{width: 58, height: 58, borderRadius: 29, background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
        <Icon name="people" size={26} color={C.accent} />
      </div>
      <div style={{flex: 1, borderBottom: `2px solid ${C.accent}`, padding: '8px 0', fontSize: 17, fontWeight: 600, display: 'flex', alignItems: 'center'}}>
        {typed || <span style={{color: C.text3}}>Group name</span>}
        {typed && <span style={{width: 2, height: 20, background: C.accent, marginLeft: 1, opacity: frame % 16 < 8 ? 1 : 0}} />}
      </div>
      <span style={{fontSize: 11, color: C.text3}}>{typed.length}/50</span>
    </div>
    <div style={{display: 'flex', gap: 8, padding: '0 16px 12px', flexWrap: 'wrap', minHeight: 40}}>
      {GROUP_CONTACTS.slice(0, Math.floor(selected)).map(([n, , col]) => (
        <div key={n} style={{display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 4px 4px', borderRadius: 999, background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.35)'}}>
          <div style={{width: 24, height: 24, borderRadius: 12, background: col, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>{n[0]}</div>
          <span style={{fontSize: 12, fontWeight: 600}}>{n.split(' ')[0]}</span>
          <Icon name="close" size={13} color={C.text2} />
        </div>
      ))}
    </div>
    <div style={{display: 'flex', alignItems: 'center', gap: 8, margin: '0 16px 10px', padding: '8px 12px', borderRadius: 10, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)'}}>
      <Icon name="shield-checkmark" size={14} color={C.emerald} />
      <span style={{fontSize: 11, color: C.emeraldLight}}>Each member keeps independent end-to-end ratchet sessions.</span>
    </div>
    {GROUP_CONTACTS.map(([n, u, col], i) => {
      const on = i < Math.floor(selected);
      return (
        <div key={n} style={{display: 'flex', alignItems: 'center', gap: 14, padding: '10px 16px', background: on ? 'rgba(6,182,212,0.06)' : undefined}}>
          <div style={{width: 46, height: 46, borderRadius: 23, background: col, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700}}>{n.slice(0, 2).toUpperCase()}</div>
          <div style={{flex: 1}}>
            <div style={{fontSize: 15, fontWeight: 600}}>{n}</div>
            <div style={{fontSize: 12, color: C.text3}}>@{u}</div>
          </div>
          <div style={{width: 24, height: 24, borderRadius: 12, border: `2px solid ${on ? C.accent : C.muted}`, background: on ? C.accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
            {on && <Icon name="checkmark" size={14} color="#fff" />}
          </div>
        </div>
      );
    })}
  </div>
);

// ── Settings (vero/app/(tabs)/settings.tsx) ─────────────────────────────────
const SETTINGS: Array<[string, Array<[string, string, string, string?]>]> = [
  ['PRIVACY', [
    ['eye-off', 'Online Status', C.accent, 'toggle'],
    ['checkmark-done', 'Read Receipts', C.emerald, 'toggle'],
    ['timer-outline', 'Disappearing Messages Default', C.warning, '1 hour'],
  ]],
  ['SECURITY', [
    ['phone-portrait', 'Linked Devices', C.purple, '1 device (Current)'],
    ['finger-print', 'App Lock (Biometrics/PIN)', C.accent, 'toggle'],
    ['key', 'Encryption Keys', C.emerald, 'View Public Keys'],
    ['shield-checkmark', 'Security Audit & Guarantees', C.accentLight],
  ]],
  ['BACKUP', [['cloud-upload', 'Google Drive Encrypted Backup', C.purpleLight, 'Client-side AES-256']]],
];

export const SettingsScreen: React.FC<{t: number}> = ({t}) => (
  <div style={{flex: 1, display: 'flex', flexDirection: 'column', padding: '0 0 90px'}}>
    <div style={{padding: '8px 20px 14px', fontSize: 28, fontWeight: 800}}>Settings</div>
    <div style={{display: 'flex', alignItems: 'center', gap: 14, margin: '0 16px 10px', padding: 16, borderRadius: 18, background: C.surface, border: `1px solid ${C.border}`}}>
      <div style={{width: 60, height: 60, borderRadius: 30, background: `linear-gradient(135deg, ${C.accent}, ${C.purple})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 800}}>AC</div>
      <div>
        <div style={{fontSize: 18, fontWeight: 700}}>Alex Chen</div>
        <div style={{fontSize: 13, color: C.text2}}>@alex_chen</div>
        <div style={{display: 'flex', alignItems: 'center', gap: 4, marginTop: 4}}>
          <Icon name="shield-checkmark" size={13} color={C.accent} />
          <span style={{fontSize: 11, color: C.accent, fontWeight: 600}}>Encrypted Account</span>
        </div>
      </div>
    </div>
    {SETTINGS.map(([title, items], si) => (
      <div key={title} style={{margin: '8px 16px 0', opacity: interpolate(t, [si * 0.15, si * 0.15 + 0.3], [0, 1], clamp)}}>
        <div style={{fontSize: 11, fontWeight: 700, color: C.text3, letterSpacing: 1, margin: '6px 4px'}}>{title}</div>
        <div style={{borderRadius: 16, background: C.surface, border: `1px solid ${C.border}`, overflow: 'hidden'}}>
          {items.map(([icon, label, col, value]) => (
            <div key={label} style={{display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderBottom: `1px solid ${C.border}`}}>
              <div style={{width: 32, height: 32, borderRadius: 9, background: `${col}22`, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
                <Icon name={icon} size={17} color={col} />
              </div>
              <div style={{flex: 1}}>
                <div style={{fontSize: 14, fontWeight: 500}}>{label}</div>
                {value && value !== 'toggle' && <div style={{fontSize: 11, color: C.text3, marginTop: 1}}>{value}</div>}
              </div>
              {value === 'toggle' ? (
                <div style={{width: 44, height: 26, borderRadius: 13, background: C.accent, padding: 3, display: 'flex', justifyContent: 'flex-end'}}>
                  <div style={{width: 20, height: 20, borderRadius: 10, background: '#fff'}} />
                </div>
              ) : (
                <Icon name="chevron-forward" size={18} color={C.text3} />
              )}
            </div>
          ))}
        </div>
      </div>
    ))}
  </div>
);

// ── Splash / brand mark (vero/app/splash.tsx) ───────────────────────────────
export const ShieldMark: React.FC<{size: number; glow?: number}> = ({size, glow = 1}) => (
  <div
    style={{
      padding: size * 0.09,
      borderRadius: '50%',
      background: 'rgba(6,182,212,0.1)',
      border: '1px solid rgba(6,182,212,0.3)',
    }}
  >
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: '#080E1A',
        border: `${Math.max(1.5, size / 60)}px solid rgba(6,182,212,0.5)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: `0 0 ${size * 0.27 * glow}px ${C.accent}cc, inset 0 0 ${size * 0.2}px rgba(6,182,212,0.25)`,
      }}
    >
      <Icon name="shield-checkmark" size={size * 0.6} color={C.accent} />
    </div>
  </div>
);
