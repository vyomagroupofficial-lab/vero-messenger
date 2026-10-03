/**
 * Current signed-in context, readable from non-React code without importing
 * the auth store (avoids import cycles between stores and repositories).
 */

import { useAuthStore } from '../features/auth/useAuthStore';

export interface SessionContext {
  userId: string;
  deviceId: string;
  displayName: string;
  isDemo: boolean;
}

export function currentSession(): SessionContext | null {
  const { user, deviceId, isDemo } = useAuthStore.getState();
  if (!user || !deviceId) return null;
  return { userId: user.id, deviceId, displayName: user.displayName || user.username || 'You', isDemo };
}

export function requireSession(): SessionContext {
  const s = currentSession();
  if (!s) throw new Error('Not signed in');
  return s;
}
