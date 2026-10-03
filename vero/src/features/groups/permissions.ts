/**
 * Client mirror of the server's group permission rules (007 migration).
 * The server is authoritative; this only decides what the UI offers.
 */

import type { GroupRole, GroupSettings } from './types';

export const isAdminRole = (role: GroupRole | null | undefined): boolean => role === 'admin' || role === 'owner';

export function canSendMessages(role: GroupRole | null | undefined, settings: Pick<GroupSettings, 'onlyAdminsSend' | 'deletedAt'>): boolean {
  if (!role || settings.deletedAt) return false;
  return !settings.onlyAdminsSend || isAdminRole(role);
}

export function canEditInfo(role: GroupRole | null | undefined, settings: Pick<GroupSettings, 'onlyAdminsEditInfo' | 'deletedAt'>): boolean {
  if (!role || settings.deletedAt) return false;
  return !settings.onlyAdminsEditInfo || isAdminRole(role);
}

export const canManageMembers = (role: GroupRole | null | undefined): boolean => isAdminRole(role);
export const canManageInvites = (role: GroupRole | null | undefined): boolean => isAdminRole(role);
export const canChangeSettings = (role: GroupRole | null | undefined): boolean => isAdminRole(role);

/** Admins promote members; only the owner dismisses admins; admins may step down. */
export function canChangeRole(
  actor: { id: string; role: GroupRole | null | undefined },
  target: { id: string; role: GroupRole },
  newRole: 'admin' | 'member'
): boolean {
  if (!isAdminRole(actor.role) || target.role === 'owner' || target.role === newRole) return false;
  if (newRole === 'admin') return true;
  return actor.role === 'owner' || actor.id === target.id;
}

/** Any admin removes any non-owner (001's remove_group_member rule). */
export function canRemoveMember(actor: { id: string; role: GroupRole | null | undefined }, target: { id: string; role: GroupRole }): boolean {
  if (actor.id === target.id) return false; // use "Leave group"
  return isAdminRole(actor.role) && target.role !== 'owner';
}

export const canTransferOwnership = (role: GroupRole | null | undefined): boolean => role === 'owner';
export const canDeleteGroup = (role: GroupRole | null | undefined): boolean => role === 'owner';

const ROLE_ORDER: Record<GroupRole, number> = { owner: 0, admin: 1, member: 2 };

/** Owner, then admins, then members; alphabetical within a role. */
export function sortMembers<T extends { role: GroupRole; displayName: string }>(members: T[]): T[] {
  return [...members].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.displayName.localeCompare(b.displayName)
  );
}
