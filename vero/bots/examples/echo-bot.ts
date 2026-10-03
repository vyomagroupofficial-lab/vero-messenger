/**
 * Echo bot: repeats text back, end-to-end encrypted.
 *
 *   VERO_SUPABASE_URL=https://<project>.supabase.co \
 *   VERO_SUPABASE_ANON_KEY=<anon key> \
 *   VERO_BOT_TOKEN=vbot_... \
 *   npx tsx bots/examples/echo-bot.ts
 */

import { botFromEnv } from '../sdk';

const bot = botFromEnv();

bot.command('start', (ctx) =>
  ctx.reply('Hi! I’m an echo bot. Send me anything and I’ll send it back - encrypted end to end. Try /help.')
);

bot.command('help', (ctx) => ctx.reply('/start - introduction\n/help - this message\nAnything else is echoed back.'));

bot.onMessage(async (ctx) => {
  const p = ctx.message.payload;
  if (p.t === 'text') await ctx.reply(p.body);
  else if (p.t === 'sticker') await ctx.reply(`Nice sticker ${p.emoji ?? ''}`.trim());
  else if (p.t === 'gif') await ctx.reply('Nice GIF!');
  else if (p.t === 'media') await ctx.reply(`Got your ${p.kind}. (I can’t look at files, but it arrived encrypted.)`);
  else if (p.t === 'payment') await ctx.reply('I’m a bot - please don’t send me money.');
});

bot.onData((ctx) => ctx.reply(`Mini-app sent: ${JSON.stringify(ctx.message.data)}`));

async function main() {
  await bot.start();
  await bot
    .setProfile({
      commands: [
        { command: 'start', description: 'Introduction' },
        { command: 'help', description: 'What I can do' },
      ],
    })
    .catch((e) => console.warn('could not update the command menu:', e.message));

  process.on('SIGINT', () => void bot.stop().then(() => process.exit(0)));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
