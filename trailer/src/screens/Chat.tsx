import React from 'react';
import {interpolate, Easing, spring} from 'remotion';
import {C} from '../theme';
import {Icon} from '../components/Icon';
import {FPS} from '../timing';

export type Msg =
  | {kind: 'text'; own: boolean; text: string; time: string; reaction?: string}
  | {kind: 'image'; own: boolean; caption?: string; time: string}
  | {kind: 'voice'; own: boolean; dur: string; time: string}
  | {kind: 'doc'; own: boolean; name: string; time: string};

export const DEMO_THREAD: Msg[] = [
  {kind: 'text', own: false, text: 'Did the new build land? 👀', time: '9:38'},
  {kind: 'text', own: true, text: 'Yep. Every message is sealed before it leaves my phone 🔐', time: '9:39'},
  {kind: 'text', own: false, text: 'So not even the server can read this?', time: '9:39'},
  {kind: 'text', own: true, text: 'Not even Vero. Only us. ⚡', time: '9:40', reaction: '🔥'},
  {kind: 'voice', own: false, dur: '0:12', time: '9:40'},
  {kind: 'image', own: true, caption: 'AES-GCM before upload 😎', time: '9:41'},
];

const Receipt: React.FC<{read: number}> = ({read}) => (
  <Icon name={read > 0.5 ? 'checkmark-done' : 'checkmark'} size={14} color={read > 0.5 ? '#BAF3FF' : 'rgba(255,255,255,0.65)'} />
);

const Bubble: React.FC<{m: Msg; read: number; frame: number}> = ({m, read, frame}) => {
  const own = m.own;
  const base: React.CSSProperties = {
    maxWidth: 296,
    borderRadius: 18,
    padding: '8px 12px',
    background: own ? `linear-gradient(160deg, ${C.bubbleSent}, ${C.bubbleSentEnd})` : '#0E1726',
    border: `1px solid ${own ? 'rgba(56,189,248,0.25)' : 'rgba(255,255,255,0.08)'}`,
    borderBottomRightRadius: own ? 4 : 18,
    borderBottomLeftRadius: own ? 18 : 4,
    color: own ? '#fff' : C.text,
    position: 'relative',
  };
  const footer = (
    <div style={{display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4, marginTop: 3}}>
      <span style={{fontSize: 10, color: own ? 'rgba(255,255,255,0.65)' : C.text3}}>{m.time}</span>
      {own && <Receipt read={read} />}
    </div>
  );
  let body: React.ReactNode;
  if (m.kind === 'text') body = <div style={{fontSize: 15, lineHeight: '21px'}}>{m.text}</div>;
  if (m.kind === 'voice') {
    body = (
      <div style={{display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', width: 230}}>
        <div style={{width: 32, height: 32, borderRadius: 16, background: 'rgba(6,182,212,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
          <Icon name="play" size={16} color={C.accent} />
        </div>
        <div style={{flex: 1, display: 'flex', alignItems: 'center', gap: 2.5, height: 26}}>
          {new Array(26).fill(0).map((_, i) => {
            const h = 5 + Math.abs(Math.sin(i * 1.7) * 15 + Math.sin(i * 0.6 + frame / 4) * 5);
            return <div key={i} style={{width: 3, height: h, borderRadius: 1.5, background: i < (frame / 3) % 26 ? C.accent : 'rgba(148,163,184,0.5)'}} />;
          })}
        </div>
        <span style={{fontSize: 11, color: C.text2}}>{m.dur}</span>
      </div>
    );
  }
  if (m.kind === 'image') {
    body = (
      <div>
        <div
          style={{
            width: 240,
            height: 150,
            borderRadius: 10,
            background: 'linear-gradient(135deg, #0ea5e9 0%, #6d28d9 55%, #ec4899 100%)',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div style={{position: 'absolute', inset: 0, background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.45), transparent 45%)'}} />
          <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: 60, background: 'linear-gradient(transparent, rgba(3,7,18,0.75))'}} />
          <div style={{position: 'absolute', left: 10, bottom: 8, display: 'flex', gap: 5, alignItems: 'center', fontSize: 10, fontWeight: 700, letterSpacing: 0.6}}>
            <Icon name="lock-closed" size={11} color="#fff" /> AES-256-GCM
          </div>
        </div>
        {m.caption && <div style={{fontSize: 14, marginTop: 6}}>{m.caption}</div>}
      </div>
    );
  }
  if (m.kind === 'doc') {
    body = (
      <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
        <div style={{width: 42, height: 42, borderRadius: 10, background: 'rgba(6,182,212,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
          <Icon name="document-text" size={24} color={C.accent} />
        </div>
        <div>
          <div style={{fontSize: 14, fontWeight: 600}}>{m.name}</div>
          <div style={{fontSize: 11, color: C.text3}}>Encrypted Blob · tap to view</div>
        </div>
      </div>
    );
  }
  return (
    <div style={base}>
      {body}
      {footer}
      {'reaction' in m && m.reaction && (
        <div
          style={{
            position: 'absolute',
            bottom: -14,
            left: own ? 10 : undefined,
            right: own ? undefined : 10,
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 14,
            padding: '1px 6px',
            fontSize: 13,
          }}
        >
          {m.reaction}
        </div>
      )}
    </div>
  );
};

export const ChatHeader: React.FC<{name: string; typing?: boolean}> = ({name, typing}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      padding: '8px 12px',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
      background: '#070D18',
      gap: 8,
    }}
  >
    <div style={{width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
      <Icon name="arrow-back" size={22} color={C.text} />
    </div>
    <div style={{position: 'relative'}}>
      <div style={{width: 42, height: 42, borderRadius: 21, background: '#0284C7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15}}>
        {name[0]}
      </div>
      <div style={{position: 'absolute', right: 0, bottom: 0, width: 12, height: 12, borderRadius: 6, background: C.emerald, border: '2px solid #070D18'}} />
    </div>
    <div style={{flex: 1, marginLeft: 4}}>
      <div style={{fontSize: 15, fontWeight: 700}}>{name}</div>
      <div style={{display: 'flex', alignItems: 'center', gap: 4, marginTop: 2}}>
        <Icon name="lock-closed" size={10} color={C.accent} />
        <span style={{fontSize: 11, color: C.emerald}}>{typing ? 'typing...' : 'E2EE · Tap to verify'}</span>
      </div>
    </div>
    {['call-outline', 'videocam-outline', 'ellipsis-vertical'].map((i) => (
      <div key={i} style={{width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
        <Icon name={i} size={22} color={C.text} />
      </div>
    ))}
  </div>
);

const Typing: React.FC<{frame: number}> = ({frame}) => (
  <div style={{display: 'flex', padding: '4px 8px'}}>
    <div style={{display: 'flex', gap: 5, background: '#0E1726', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 18, borderBottomLeftRadius: 4, padding: '12px 14px'}}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            background: C.accentLight,
            opacity: 0.35 + 0.65 * Math.max(0, Math.sin(frame / 3 - i * 0.9)),
            transform: `translateY(${-3 * Math.max(0, Math.sin(frame / 3 - i * 0.9))}px)`,
          }}
        />
      ))}
    </div>
  </div>
);

/**
 * `shown` = how many messages are visible (fractional part animates the
 * newest one in). `frame` = local frame for idle loops.
 */
export const Chat: React.FC<{
  frame: number;
  shown: number;
  thread?: Msg[];
  typing?: boolean;
  draft?: string;
  name?: string;
  vanish?: number[]; // per-message 0..1 disappear progress
  timerBanner?: string;
}> = ({frame, shown, thread = DEMO_THREAD, typing, draft = '', name = 'Sarah Connor', vanish, timerBanner}) => (
  <>
    <ChatHeader name={name} typing={typing} />
    {timerBanner && (
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: `${C.warning}20`, padding: '4px 0'}}>
        <Icon name="timer-outline" size={13} color={C.warning} />
        <span style={{color: C.warning, fontSize: 11, fontWeight: 600}}>Disappearing messages: {timerBanner}</span>
      </div>
    )}
    <div style={{flex: 1, padding: '12px 8px 16px', display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden', justifyContent: 'flex-end'}}>
      <div
        style={{
          display: 'flex',
          gap: 10,
          background: 'rgba(16,185,129,0.08)',
          border: '1px solid rgba(16,185,129,0.25)',
          borderRadius: 14,
          padding: 12,
          margin: '0 8px 6px',
        }}
      >
        <div style={{width: 30, height: 30, borderRadius: 15, background: 'rgba(16,185,129,0.16)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0}}>
          <Icon name="shield-checkmark" size={15} color={C.emerald} />
        </div>
        <div style={{fontSize: 11, color: C.text2, lineHeight: '16px'}}>
          Messages and calls are end-to-end encrypted with X25519 &amp; XSalsa20. No one outside of this chat, not even Vero, can read them.
        </div>
      </div>
      {thread.map((m, i) => {
        const p = Math.max(0, Math.min(1, shown - i));
        if (p <= 0) return null;
        const s = spring({frame: p * 12, fps: FPS, config: {damping: 11, stiffness: 180}, durationInFrames: 12});
        const v = vanish?.[i] ?? 0;
        if (v >= 1) return null;
        const read = interpolate(shown - i, [1.2, 1.5], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
        return (
          <div
            key={i}
            style={{
              display: 'flex',
              justifyContent: m.own ? 'flex-end' : 'flex-start',
              padding: '0 8px',
              transformOrigin: m.own ? 'bottom right' : 'bottom left',
              transform: `scale(${0.6 + 0.4 * s}) translateY(${(1 - s) * 30}px)`,
              opacity: Math.min(1, p * 3) * (1 - v),
              filter: v > 0 ? `blur(${v * 10}px)` : undefined,
              marginBottom: 'reaction' in m && m.reaction ? 10 : 0,
            }}
          >
            <Bubble m={m} read={read} frame={frame} />
          </div>
        );
      })}
      {typing && <Typing frame={frame} />}
    </div>
    <div style={{display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px 30px', borderTop: '1px solid rgba(255,255,255,0.06)', background: '#070D18'}}>
      <Icon name="add-circle-outline" size={26} color={C.accent} />
      <div
        style={{
          flex: 1,
          minHeight: 40,
          borderRadius: 20,
          background: C.input,
          border: `1px solid ${draft ? C.accent : 'rgba(255,255,255,0.1)'}`,
          display: 'flex',
          alignItems: 'center',
          padding: '0 14px',
          fontSize: 15,
          color: draft ? C.text : C.text3,
        }}
      >
        {draft || 'Message...'}
        {draft && <span style={{width: 2, height: 18, background: C.accent, marginLeft: 1, opacity: frame % 16 < 8 ? 1 : 0}} />}
      </div>
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          background: draft ? C.accent : 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: draft ? `0 0 16px ${C.accentGlow}` : undefined,
        }}
      >
        <Icon name={draft ? 'send' : 'mic-outline'} size={draft ? 18 : 24} color={draft ? '#fff' : C.accent} />
      </div>
    </div>
  </>
);

export const easeOut = Easing.out(Easing.cubic);
