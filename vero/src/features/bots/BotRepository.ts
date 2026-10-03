/**
 * Bot directory, bot info for chats (badge, command menu, mini-app) and
 * bot management through the `bot-admin` Edge Function.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../../core/network/supabase';
import { functionError } from '../stickers/extMedia';
import { BotCommand, isValidMiniAppUrl, parseBotCommands } from './validation';

export interface BotInfo {
  userId: string;
  ownerId: string;
  name: string;
  username?: string;
  description: string | null;
  commands: BotCommand[];
  miniAppUrl: string | null;
  isPublic: boolean;
}

export interface MyBot extends BotInfo {
  webhookUrl: string | null;
}

export interface NewBotInput {
  username: string;
  name: string;
  description?: string;
  commands: BotCommand[];
  miniAppUrl?: string;
  isPublic: boolean;
}

const COLUMNS = 'user_id, owner_id, name, description, commands, mini_app_url, is_public, profile:profiles!bots_user_id_fkey(username)';

function toBot(r: any): BotInfo {
  const profile = Array.isArray(r.profile) ? r.profile[0] : r.profile;
  return {
    userId: r.user_id,
    ownerId: r.owner_id,
    name: r.name,
    username: profile?.username ?? r.username ?? undefined,
    description: r.description ?? null,
    commands: parseBotCommands(r.commands),
    miniAppUrl: isValidMiniAppUrl(r.mini_app_url) ? r.mini_app_url : null,
    isPublic: !!r.is_public,
  };
}

// userId -> bot info (null = not a bot). Cleared on demand.
const cache = new Map<string, { bot: BotInfo | null; at: number }>();
const TTL_MS = 5 * 60_000;

class BotRepository {
  async listPublic(query = ''): Promise<BotInfo[]> {
    let q = supabase.from('bots').select(COLUMNS).eq('is_public', true).order('name').limit(50);
    const term = query.trim().replace(/[%_\\,()]/g, '');
    if (term.length >= 2) q = q.ilike('name', `%${term}%`);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []).map(toBot);
  }

  /** Bot info for a user, or null if they're not a bot (or not visible to us). */
  async getByUserId(userId: string, fresh = false): Promise<BotInfo | null> {
    const hit = cache.get(userId);
    if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.bot;
    const { data, error } = await supabase.from('bots').select(COLUMNS).eq('user_id', userId).maybeSingle();
    if (error) return hit?.bot ?? null;
    const bot = data ? toBot(data) : null;
    cache.set(userId, { bot, at: Date.now() });
    return bot;
  }

  async myBots(): Promise<MyBot[]> {
    const { data, error } = await supabase.rpc('my_bots');
    if (error) throw error;
    return (data ?? []).map((r: any) => ({ ...toBot(r), webhookUrl: r.webhook_url ?? null }));
  }

  async create(input: NewBotInput): Promise<{ botUserId: string; username: string; token: string }> {
    const { data, error } = await supabase.functions.invoke('bot-admin', {
      body: {
        action: 'create',
        username: input.username,
        name: input.name,
        description: input.description || undefined,
        commands: input.commands,
        miniAppUrl: input.miniAppUrl || undefined,
        isPublic: input.isPublic,
      },
    });
    if (error) throw new Error(await functionError(error, 'Could not create the bot'));
    return data;
  }

  async rotateToken(botUserId: string): Promise<string> {
    const { data, error } = await supabase.functions.invoke('bot-admin', { body: { action: 'rotate', botUserId } });
    if (error) throw new Error(await functionError(error, 'Could not rotate the token'));
    return data.token;
  }

  async remove(botUserId: string): Promise<void> {
    const { error } = await supabase.functions.invoke('bot-admin', { body: { action: 'delete', botUserId } });
    if (error) throw new Error(await functionError(error, 'Could not delete the bot'));
    cache.delete(botUserId);
  }

  async update(
    botUserId: string,
    patch: Partial<{ description: string | null; commands: BotCommand[]; miniAppUrl: string | null; webhookUrl: string | null; isPublic: boolean }>
  ): Promise<void> {
    const row: Record<string, unknown> = {};
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.commands !== undefined) row.commands = patch.commands;
    if (patch.miniAppUrl !== undefined) row.mini_app_url = patch.miniAppUrl;
    if (patch.webhookUrl !== undefined) row.webhook_url = patch.webhookUrl;
    if (patch.isPublic !== undefined) row.is_public = patch.isPublic;
    const { error } = await supabase.from('bots').update(row).eq('user_id', botUserId);
    if (error) throw error;
    cache.delete(botUserId);
  }
}

export const botRepository = new BotRepository();

/** Bot info for a chat partner (null while loading or if not a bot). */
export function useBotInfo(userId: string | undefined | null): BotInfo | null {
  const [bot, setBot] = useState<BotInfo | null>(() => (userId ? cache.get(userId)?.bot ?? null : null));
  useEffect(() => {
    if (!userId) {
      setBot(null);
      return;
    }
    let cancelled = false;
    botRepository
      .getByUserId(userId)
      .then((b) => !cancelled && setBot(b))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [userId]);
  return bot;
}
