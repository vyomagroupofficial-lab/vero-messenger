import { useEffect, useMemo } from 'react';
import { Platform, TextStyle } from 'react-native';
import { useChatsStore } from '../chats/useChatsStore';
import type { StoryFont } from './payload';
import {
  Contact,
  contactsFromConversations,
  myStories,
  startStoriesLive,
  storyGroups,
  useStoriesStore,
} from './useStoriesStore';

/** Keeps stories fresh via realtime pings while mounted (shared subscription). */
export function useStoriesLive(): void {
  useEffect(() => startStoriesLive(), []);
}

/** People I share a direct chat with (loads the chat list if it isn't yet). */
export function useStoryContacts(): Contact[] {
  const conversations = useChatsStore((s) => s.conversations);
  useEffect(() => {
    if (useChatsStore.getState().conversations.length === 0) void useChatsStore.getState().load({ sync: false });
  }, []);
  return useMemo(() => contactsFromConversations(conversations), [conversations]);
}

export function useStoryTray() {
  const stories = useStoriesStore((s) => s.stories);
  const seen = useStoriesStore((s) => s.seen);
  const privacy = useStoriesStore((s) => s.privacy);
  const names = useStoriesStore((s) => s.names);
  return useMemo(
    () => ({ mine: myStories(stories), groups: storyGroups(stories, seen, privacy, names) }),
    [stories, seen, privacy, names]
  );
}

const SERIF = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, serif' });
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, monospace' });

export function storyFontStyle(font: StoryFont): TextStyle {
  switch (font) {
    case 'serif':
      return { fontFamily: SERIF, fontWeight: '500' };
    case 'mono':
      return { fontFamily: MONO, fontWeight: '500' };
    case 'bold':
      return { fontWeight: '900', letterSpacing: -0.5 };
    default:
      return { fontWeight: '600' };
  }
}

export const STORY_FONT_LABELS: Record<StoryFont, string> = {
  sans: 'Clean',
  serif: 'Serif',
  mono: 'Typewriter',
  bold: 'Bold',
};
