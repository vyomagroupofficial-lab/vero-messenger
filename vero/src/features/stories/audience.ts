/**
 * Story audience / privacy (pure). The setting is stored locally and synced to
 * the user's own `story_privacy` row; the audience itself is resolved on the
 * device at post time, and the server additionally drops anyone who is not a
 * contact (shared, unblocked direct chat).
 */

export type AudienceMode = 'contacts' | 'contacts_except' | 'only';

export interface StoryPrivacy {
  audience: AudienceMode;
  /** Used when audience = 'contacts_except'. */
  exceptUserIds: string[];
  /** Used when audience = 'only'. */
  onlyUserIds: string[];
  /** Authors whose stories I muted (shown last in the tray). */
  mutedUserIds: string[];
}

export const DEFAULT_PRIVACY: StoryPrivacy = {
  audience: 'contacts',
  exceptUserIds: [],
  onlyUserIds: [],
  mutedUserIds: [],
};

export const AUDIENCE_LABELS: Record<AudienceMode, string> = {
  contacts: 'My contacts',
  contacts_except: 'My contacts except…',
  only: 'Only share with…',
};

/**
 * Who a new story is shared with. `contactIds` are the people I share a direct
 * chat with. "Only share with" is still limited to current contacts, so a
 * stale selection can never reach someone I no longer talk to.
 */
export function resolveAudience(contactIds: string[], privacy: StoryPrivacy, selfId: string): string[] {
  const contacts = [...new Set(contactIds)].filter((id) => id && id !== selfId);
  switch (privacy.audience) {
    case 'contacts':
      return contacts;
    case 'contacts_except': {
      const excluded = new Set(privacy.exceptUserIds);
      return contacts.filter((id) => !excluded.has(id));
    }
    case 'only': {
      const allowed = new Set(privacy.onlyUserIds);
      return contacts.filter((id) => allowed.has(id));
    }
    default:
      return [];
  }
}

/** One-line description of who will see the next story. */
export function audienceSummary(contactIds: string[], privacy: StoryPrivacy, selfId: string): string {
  const n = resolveAudience(contactIds, privacy, selfId).length;
  const people = `${n} ${n === 1 ? 'person' : 'people'}`;
  switch (privacy.audience) {
    case 'contacts':
      return `My contacts · ${people}`;
    case 'contacts_except':
      return `My contacts except ${privacy.exceptUserIds.length} · ${people}`;
    case 'only':
      return `Only selected · ${people}`;
  }
}

/** Accepts a synced row (or anything) and returns a well-formed setting. */
export function normalizePrivacy(raw: any): StoryPrivacy {
  const ids = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))] : [];
  const mode: AudienceMode = ['contacts', 'contacts_except', 'only'].includes(raw?.audience)
    ? raw.audience
    : 'contacts';
  return {
    audience: mode,
    exceptUserIds: ids(raw?.exceptUserIds ?? raw?.except_user_ids),
    onlyUserIds: ids(raw?.onlyUserIds ?? raw?.only_user_ids),
    mutedUserIds: ids(raw?.mutedUserIds ?? raw?.muted_user_ids),
  };
}
