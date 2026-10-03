/**
 * Reminder + poll bot.
 *
 *   /remind 10m stretch      -> reminds you in 10 minutes (s, m, h, d)
 *   /reminders               -> lists pending reminders
 *   /poll Lunch? | Pizza | Dosa | Salad
 *                            -> numbered poll; reply "/vote 2" to vote
 *   /results                 -> current poll results
 *
 * Reminders are kept in a local JSON file so they survive restarts. The bot
 * only ever sees the decrypted text on this machine.
 *
 *   VERO_SUPABASE_URL=... VERO_SUPABASE_ANON_KEY=... VERO_BOT_TOKEN=vbot_... \
 *   npx tsx bots/examples/reminder-bot.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { botFromEnv } from '../sdk';

interface Reminder {
  id: string;
  conversationId: string;
  dueAt: number;
  text: string;
}

interface Poll {
  question: string;
  options: string[];
  votes: Record<string, number>; // userId -> option index
}

const FILE = process.env.REMINDER_FILE ?? '.reminder-bot.json';
const MAX_DELAY_MS = 30 * 86400_000;
const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 };

const store: { reminders: Reminder[]; polls: Record<string, Poll> } = existsSync(FILE)
  ? JSON.parse(readFileSync(FILE, 'utf8'))
  : { reminders: [], polls: {} };
const save = () => writeFileSync(FILE, JSON.stringify(store, null, 2), { mode: 0o600 });

export function parseDelay(s: string): number | null {
  const m = /^(\d{1,5})([smhd])$/.exec(s);
  if (!m) return null;
  const ms = parseInt(m[1], 10) * UNITS[m[2]];
  return ms > 0 && ms <= MAX_DELAY_MS ? ms : null;
}

const bot = botFromEnv();

bot.command('start', (ctx) =>
  ctx.reply('I set reminders and run polls.\n/remind 10m stretch\n/reminders\n/poll Question? | option 1 | option 2\n/vote 1\n/results')
);

bot.command('remind', async (ctx) => {
  const [when, ...rest] = (ctx.message.command?.args ?? '').split(/\s+/);
  const delay = when ? parseDelay(when) : null;
  const text = rest.join(' ').trim();
  if (!delay || !text) return ctx.reply('Usage: /remind 10m drink water   (units: s, m, h, d; up to 30d)');
  const pending = store.reminders.filter((r) => r.conversationId === ctx.message.conversationId);
  if (pending.length >= 20) return ctx.reply('You already have 20 reminders here.');
  store.reminders.push({
    id: ctx.message.id,
    conversationId: ctx.message.conversationId,
    dueAt: Date.now() + delay,
    text: text.slice(0, 500),
  });
  save();
  await ctx.reply(`OK, I’ll remind you at ${new Date(Date.now() + delay).toLocaleString('en-IN')}.`);
});

bot.command('reminders', (ctx) => {
  const mine = store.reminders.filter((r) => r.conversationId === ctx.message.conversationId);
  return ctx.reply(
    mine.length
      ? mine.map((r) => `• ${new Date(r.dueAt).toLocaleString('en-IN')} - ${r.text}`).join('\n')
      : 'No pending reminders.'
  );
});

bot.command('poll', (ctx) => {
  const parts = (ctx.message.command?.args ?? '').split('|').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3 || parts.length > 11) return ctx.reply('Usage: /poll Question? | option 1 | option 2 (2-10 options)');
  const [question, ...options] = parts;
  store.polls[ctx.message.conversationId] = { question, options, votes: {} };
  save();
  return ctx.reply(`📊 ${question}\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\nReply /vote <number>`);
});

bot.command('vote', (ctx) => {
  const poll = store.polls[ctx.message.conversationId];
  const n = parseInt(ctx.message.command?.args ?? '', 10);
  if (!poll) return ctx.reply('There’s no poll here. Start one with /poll.');
  if (!(n >= 1 && n <= poll.options.length)) return ctx.reply(`Vote with a number from 1 to ${poll.options.length}.`);
  poll.votes[ctx.message.senderUserId] = n - 1;
  save();
  return ctx.reply(`Vote recorded for “${poll.options[n - 1]}”.`);
});

bot.command('results', (ctx) => {
  const poll = store.polls[ctx.message.conversationId];
  if (!poll) return ctx.reply('There’s no poll here.');
  const counts = poll.options.map((_, i) => Object.values(poll.votes).filter((v) => v === i).length);
  const total = counts.reduce((a, b) => a + b, 0);
  return ctx.reply(
    `📊 ${poll.question}\n` +
      poll.options.map((o, i) => `${o}: ${counts[i]}${total ? ` (${Math.round((counts[i] / total) * 100)}%)` : ''}`).join('\n')
  );
});

async function tick() {
  const now = Date.now();
  const due = store.reminders.filter((r) => r.dueAt <= now);
  if (!due.length) return;
  store.reminders = store.reminders.filter((r) => r.dueAt > now);
  save();
  for (const r of due) {
    try {
      await bot.sendText(r.conversationId, `⏰ Reminder: ${r.text}`, r.id);
    } catch (e) {
      console.warn('reminder failed:', (e as Error).message);
    }
  }
}

async function main() {
  await bot.start();
  await bot
    .setProfile({
      commands: [
        { command: 'remind', description: 'Remind me later: /remind 10m text' },
        { command: 'reminders', description: 'List my reminders' },
        { command: 'poll', description: 'Start a poll: /poll Q? | A | B' },
        { command: 'vote', description: 'Vote in the poll: /vote 1' },
        { command: 'results', description: 'Show poll results' },
      ],
    })
    .catch((e) => console.warn('could not update the command menu:', e.message));

  const timer = setInterval(() => void tick(), 5000);
  process.on('SIGINT', () => {
    clearInterval(timer);
    void bot.stop().then(() => process.exit(0));
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
