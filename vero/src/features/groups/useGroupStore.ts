import { useStore } from 'zustand';
import { currentSession } from '../../core/session';
import { groupRepository } from './GroupRepository';
import { createGroupStore, GroupState } from './groupStore';

export const groupStore = createGroupStore(groupRepository, () => currentSession()?.userId ?? null);

export function useGroupStore<T>(selector: (s: GroupState) => T): T {
  return useStore(groupStore, selector);
}
