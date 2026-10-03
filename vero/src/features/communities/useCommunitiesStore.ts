import { useStore } from 'zustand';
import { communityRepository } from './CommunityRepository';
import { CommunitiesState, createCommunitiesStore } from './communitiesStore';

export const communitiesStore = createCommunitiesStore(communityRepository);

export function useCommunitiesStore<T>(selector: (s: CommunitiesState) => T): T {
  return useStore(communitiesStore, selector);
}
