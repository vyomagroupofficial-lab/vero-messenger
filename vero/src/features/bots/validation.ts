/**
 * Bot rules shared by the create-bot screen, the command menu and the
 * mini-app sheet (pure, unit-tested). The database and bot-admin enforce
 * the same rules server-side.
 */

export interface BotCommand {
  command: string;
  description: string;
}

export const BOT_USERNAME_RE = /^[a-z0-9_]{3,30}$/;
const COMMAND_RE = /^[a-z0-9_]{1,32}$/;
const HTTPS_URL_RE = /^https:\/\/([a-z0-9-]+\.)+[a-z]{2,63}(:[0-9]{2,5})?(\/\S*)?$/;

export function validateBotUsername(u: string): string | null {
  if (!BOT_USERNAME_RE.test(u)) return 'Use 3–30 characters: a–z, 0–9 and _.';
  if (!u.endsWith('bot')) return 'Bot usernames must end in “bot” (e.g. weather_bot).';
  return null;
}

/** Commands from the bots table (untrusted JSON): keeps only well-formed entries. */
export function parseBotCommands(raw: unknown): BotCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: BotCommand[] = [];
  for (const c of raw.slice(0, 50)) {
    const command = typeof c?.command === 'string' ? c.command : '';
    if (!COMMAND_RE.test(command) || out.some((o) => o.command === command)) continue;
    out.push({ command, description: typeof c?.description === 'string' ? c.description.slice(0, 128) : '' });
  }
  return out;
}

/** "start - Say hello" lines (as typed in the create-bot form) -> commands. */
export function parseCommandLines(text: string): { commands: BotCommand[]; error: string | null } {
  const commands: BotCommand[] = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^\/?([a-zA-Z0-9_]{1,32})\s*(?:[-–—:]\s*(.*))?$/.exec(line);
    if (!m) return { commands, error: `Can't read “${line.slice(0, 40)}”. Use: command - description` };
    const command = m[1].toLowerCase();
    if (commands.some((c) => c.command === command)) return { commands, error: `/${command} is listed twice` };
    commands.push({ command, description: (m[2] ?? '').trim().slice(0, 128) });
  }
  if (commands.length > 50) return { commands, error: 'At most 50 commands' };
  return { commands, error: null };
}

/** `/` suggestions for the composer: only while typing the first word. */
export function matchCommands(input: string, commands: BotCommand[]): BotCommand[] {
  const m = /^\/([a-z0-9_]*)$/i.exec(input);
  if (!m) return [];
  const prefix = m[1].toLowerCase();
  return commands.filter((c) => c.command.startsWith(prefix)).slice(0, 8);
}

export function isValidMiniAppUrl(u: unknown): u is string {
  return typeof u === 'string' && u.length <= 512 && HTTPS_URL_RE.test(u);
}
