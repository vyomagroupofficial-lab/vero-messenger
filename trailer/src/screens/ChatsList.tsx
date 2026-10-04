import React from 'react';
import {interpolate, Easing} from 'remotion';
import {C, avatarColor} from '../theme';
import {Icon} from '../components/Icon';

// Seeded from DEMO_CONVERSATIONS in vero/app/(tabs)/chats.tsx (+ a few more rows to fill the screen)
export const CONVERSATIONS = [
  {name: 'Sarah Connor', group: false, msg: 'Verified our 60-digit safety number! All green 🔒', time: '12 min', unread: 0, own: false},
  {name: 'Marcus Vance (DevOps)', group: false, msg: '📷 Encrypted media transfer complete via Drive proxy', time: '45 min', unread: 2, own: true},
  {name: 'Vero Security Core', group: true, msg: 'Zero-Knowledge audit verified: No plaintexts in Supabase.', time: '2 h', unread: 0, own: false},
  {name: 'Elena Rostova', group: false, msg: 'Ratchet keys rotated. We are ghosts now 👻', time: '3 h', unread: 5, own: false},
  {name: 'David Kim', group: false, msg: '📄 Vero_Audit_Report.pdf', time: '5 h', unread: 0, own: true},
  {name: 'Launch Squad', group: true, msg: '🎤 Voice message · 0:42', time: '1 d', unread: 12, own: false},
  {name: 'Priya Sharma', group: false, msg: 'see you at 9 🔥', time: '1 d', unread: 0, own: false},
  {name: 'Kai Nakamura', group: false, msg: 'Call ended · 14:08 · P2P encrypted', time: '2 d', unread: 0, own: true},
];

const CATEGORIES = ['All', 'Direct', 'Groups', 'Unread'];

const HeaderBtn: React.FC<{icon: string; primary?: boolean}> = ({icon, primary}) => (
  <div
    style={{
      width: 38,
      height: 38,
      borderRadius: 19,
      background: primary ? 'rgba(6,182,212,0.12)' : 'rgba(255,255,255,0.04)',
      border: `1px solid ${primary ? 'rgba(6,182,212,0.3)' : 'rgba(255,255,255,0.08)'}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    <Icon name={icon} size={20} color={primary ? C.accentLight : C.text} />
  </div>
);

export const VeroHeader: React.FC = () => (
  <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 24px 8px'}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
      <div
        style={{
          width: 38,
          height: 38,
          borderRadius: 12,
          background: 'rgba(6,182,212,0.12)',
          border: '1px solid rgba(6,182,212,0.3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="shield-checkmark" size={20} color={C.accent} />
      </div>
      <div>
        <div style={{fontSize: 20, fontWeight: 800, letterSpacing: 3}}>VERO</div>
        <div style={{display: 'flex', alignItems: 'center', gap: 5, marginTop: 1}}>
          <div style={{width: 6, height: 6, borderRadius: 3, background: C.emerald}} />
          <div style={{fontSize: 9, fontWeight: 700, color: C.emerald, letterSpacing: 0.8}}>E2EE ACTIVE</div>
        </div>
      </div>
    </div>
    <div style={{display: 'flex', gap: 8}}>
      <HeaderBtn icon="search-outline" />
      <HeaderBtn icon="people-outline" />
      <HeaderBtn icon="create-outline" primary />
    </div>
  </div>
);

export const ChatRow: React.FC<{c: (typeof CONVERSATIONS)[number]; highlight?: number}> = ({c, highlight = 0}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      padding: '12px 24px',
      background: `rgba(6,182,212,${0.12 * highlight})`,
    }}
  >
    <div style={{position: 'relative', marginRight: 16}}>
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 26,
          background: avatarColor(c.name),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 15,
          fontWeight: 700,
          letterSpacing: 0.5,
          boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
        }}
      >
        {c.group ? <Icon name="people" size={24} color="#fff" /> : c.name.slice(0, 2).toUpperCase()}
      </div>
      <div
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 13,
          height: 13,
          borderRadius: 7,
          background: C.emerald,
          border: `2px solid ${C.bg}`,
        }}
      />
    </div>
    <div style={{flex: 1, minWidth: 0}}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 6, minWidth: 0}}>
          <div style={{fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
            {c.name}
          </div>
          <Icon name="shield-checkmark" size={12} color={C.emerald} />
        </div>
        <div style={{fontSize: 11, color: C.text3, flexShrink: 0, marginLeft: 6}}>{c.time}</div>
      </div>
      <div style={{display: 'flex', alignItems: 'center'}}>
        {c.own && <Icon name="checkmark-done" size={15} color={C.accentLight} style={{marginRight: 4}} />}
        <div
          style={{
            flex: 1,
            fontSize: 13,
            color: c.unread ? C.text : C.text2,
            fontWeight: c.unread ? 600 : 400,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            marginRight: 8,
          }}
        >
          {c.msg}
        </div>
        {c.unread > 0 && (
          <div
            style={{
              background: C.accent,
              borderRadius: 10,
              minWidth: 20,
              height: 20,
              padding: '0 6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              fontWeight: 700,
              boxShadow: `0 2px 6px ${C.accentGlow}`,
            }}
          >
            {c.unread}
          </div>
        )}
      </div>
    </div>
  </div>
);

const TabBar: React.FC<{active?: number}> = ({active = 0}) => {
  const tabs = [
    ['chatbubbles', 'Chats'],
    ['call-outline', 'Calls'],
    ['person-outline', 'Contacts'],
    ['settings-outline', 'Settings'],
  ];
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 84,
        background: 'rgba(5,11,23,0.96)',
        borderTop: `1px solid ${C.border}`,
        display: 'flex',
        justifyContent: 'space-around',
        paddingTop: 10,
      }}
    >
      {tabs.map(([icon, label], i) => (
        <div key={label} style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4}}>
          <Icon name={icon} size={24} color={i === active ? C.accent : C.text3} />
          <div style={{fontSize: 10, fontWeight: 600, color: i === active ? C.accent : C.text3}}>{label}</div>
        </div>
      ))}
    </div>
  );
};

/** `t` drives the staggered row entrance (0 → rows fully in after ~0.6). */
export const ChatsList: React.FC<{t: number; active?: string; highlightRow?: number; highlight?: number; scroll?: number}> = ({
  t,
  active = 'All',
  highlightRow = -1,
  highlight = 0,
  scroll = 0,
}) => (
  <>
    <VeroHeader />
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '8px 24px',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
      }}
    >
      {CATEGORIES.map((cat) => {
        const on = cat === active;
        return (
          <div
            key={cat}
            style={{
              padding: '6px 12px',
              borderRadius: 999,
              background: on ? 'rgba(6,182,212,0.15)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${on ? 'rgba(6,182,212,0.35)' : 'transparent'}`,
              fontSize: 11,
              fontWeight: 600,
              color: on ? C.accentLight : C.text3,
            }}
          >
            {cat}
          </div>
        );
      })}
    </div>
    <div style={{paddingTop: 8, transform: `translateY(${-scroll}px)`}}>
      {CONVERSATIONS.map((c, i) => {
        const p = interpolate(t, [i * 0.07, i * 0.07 + 0.35], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.out(Easing.cubic),
        });
        return (
          <div key={c.name} style={{opacity: p, transform: `translateX(${(1 - p) * 120}px)`}}>
            <ChatRow c={c} highlight={i === highlightRow ? highlight : 0} />
            <div style={{height: 1, background: 'rgba(255,255,255,0.04)', marginLeft: 84}} />
          </div>
        );
      })}
    </div>
    <TabBar />
  </>
);

export {TabBar};
