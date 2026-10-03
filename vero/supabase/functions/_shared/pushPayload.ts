// Builds Expo push messages for Vero. Pure (no Deno / Node APIs) so the app's
// unit tests can check it: tests/push.test.ts.
//
// Privacy rules:
//   * Never message content. The function only ever receives ids and the
//     metadata below from the database, and the body is a fixed string.
//   * The sender / caller / channel / group NAME is shown only when the
//     recipient turned on "notification previews" (user_settings), otherwise
//     the title is just "Vero".
//   * `data` carries ids only (used to open the right screen on tap).

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_BATCH_SIZE = 100;

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  sound?: "default" | null;
  channelId?: string;
  categoryId?: string;
  priority?: "default" | "normal" | "high";
  ttl?: number;
  threadId?: string;
  data: Record<string, string>;
}

/** One message plus the device it is for (so dead tokens can be removed). */
export interface PushItem {
  deviceId: string;
  token: string;
  message: ExpoPushMessage;
}

export interface MessagePushTarget {
  device_id: string;
  user_id: string;
  token: string;
  previews: boolean | null;
  sender_name: string | null;
  conversation_id: string;
  conversation_type: string;
  group_name: string | null;
}

export interface CallPushTarget {
  device_id: string;
  user_id: string;
  token: string;
  previews: boolean | null;
  caller_name: string | null;
  conversation_id: string;
  call_id: string;
  call_type: string;
}

export interface ChannelPostPushTarget {
  device_id: string;
  user_id: string;
  token: string;
  previews: boolean | null;
  channel_id: string;
  channel_name: string | null;
}

const NEUTRAL_TITLE = "Vero";
export const MESSAGE_BODY = "New message";
export const CHANNEL_POST_BODY = "New post";

const TOKEN_RE = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,200}\]$/;

/** Only well-formed Expo tokens are sent to Expo. */
export function isExpoPushToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

/** Display names are user-controlled: strip control characters and cap the length. */
export function cleanName(name: string | null | undefined, max = 48): string | null {
  if (typeof name !== "string") return null;
  // deno-lint-ignore no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function buildMessagePushes(targets: MessagePushTarget[]): PushItem[] {
  return targets
    .filter((t) => isExpoPushToken(t.token))
    .map((t) => {
      let title = NEUTRAL_TITLE;
      if (t.previews) {
        const sender = cleanName(t.sender_name);
        const group = t.conversation_type === "group" ? cleanName(t.group_name) : null;
        if (sender) title = group ? `${sender} · ${group}` : sender;
      }
      return {
        deviceId: t.device_id,
        token: t.token,
        message: {
          to: t.token,
          title,
          body: MESSAGE_BODY,
          sound: "default",
          channelId: "messages",
          priority: "high",
          threadId: t.conversation_id,
          data: { type: "message", conversationId: t.conversation_id },
        },
      };
    });
}

export function buildCallPushes(targets: CallPushTarget[]): PushItem[] {
  return targets
    .filter((t) => isExpoPushToken(t.token))
    .map((t) => {
      const callType = t.call_type === "video" ? "video" : "voice";
      const caller = t.previews ? cleanName(t.caller_name) : null;
      return {
        deviceId: t.device_id,
        token: t.token,
        message: {
          to: t.token,
          title: caller ?? NEUTRAL_TITLE,
          body: callType === "video" ? "Incoming video call" : "Incoming voice call",
          sound: "default",
          channelId: "calls",
          categoryId: "incoming_call",
          priority: "high",
          // A ring that arrives late is useless.
          ttl: 30,
          data: { type: "call", callId: t.call_id, conversationId: t.conversation_id, callType },
        },
      };
    });
}

export function buildChannelPostPushes(targets: ChannelPostPushTarget[]): PushItem[] {
  return targets
    .filter((t) => isExpoPushToken(t.token))
    .map((t) => {
      const channel = t.previews ? cleanName(t.channel_name) : null;
      return {
        deviceId: t.device_id,
        token: t.token,
        message: {
          to: t.token,
          title: channel ?? NEUTRAL_TITLE,
          body: CHANNEL_POST_BODY,
          sound: "default",
          channelId: "messages",
          priority: "normal",
          threadId: `channel:${t.channel_id}`,
          data: { type: "channel_post", channelId: t.channel_id },
        },
      };
    });
}

export function chunk<T>(items: T[], size = EXPO_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/** Items whose ticket says the token is dead (the app was uninstalled / token rotated). */
export function deadTokens(batch: PushItem[], tickets: unknown): PushItem[] {
  if (!Array.isArray(tickets)) return [];
  const dead: PushItem[] = [];
  tickets.forEach((ticket, i) => {
    const t = ticket as ExpoTicket | null;
    if (batch[i] && t && t.status === "error" && t.details?.error === "DeviceNotRegistered") dead.push(batch[i]);
  });
  return dead;
}
