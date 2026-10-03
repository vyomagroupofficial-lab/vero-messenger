import { useEffect } from 'react';
import { useStore } from 'zustand';
import { supabase } from '../../core/network/supabase';
import { privateChannel } from '../../core/network/realtime';
import { channelRepository } from './ChannelRepository';
import { ChannelsState, createChannelsStore } from './channelsStore';

export const channelsStore = createChannelsStore(channelRepository);

export function useChannelsStore<T>(selector: (s: ChannelsState) => T): T {
  return useStore(channelsStore, selector);
}

const EVENTS = ['post.new', 'post.updated', 'post.deleted', 'post.reactions', 'channel.updated', 'channel.deleted'];

/** Live updates for an open channel over the private `channel:<id>` topic. */
export function useChannelRealtime(channelId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !channelId) return;
    const channel = privateChannel(`channel:${channelId}`);
    for (const event of EVENTS) {
      channel.on('broadcast', { event }, ({ payload }) => {
        if (event === 'channel.updated') {
          void channelRepository.getDetails(channelId).then((details) => {
            if (details) channelsStore.setState((s) => ({ channels: { ...s.channels, [channelId]: details } }));
          });
          return;
        }
        channelsStore.getState().applyRealtime(channelId, event, payload);
      });
    }
    channel.subscribe((status) => {
      // Catch up on anything missed while (re)connecting.
      if (status === 'SUBSCRIBED') void channelsStore.getState().open(channelId).catch(() => undefined);
    });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [channelId, enabled]);
}
