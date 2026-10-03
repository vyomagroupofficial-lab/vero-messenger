/**
 * Payload pieces for edits and forwarding. Kept apart from payload.ts so the
 * parsers can be tested and extended without touching the core union.
 */

/** Encrypted control payload: the sender changed the text/caption of `targetId`. */
export interface EditPayload {
  t: 'edit';
  targetId: string;
  newText: string;
  /** Sender's clock; informational. Receivers use the server time of the row. */
  editedAt: string;
}

/** Upper bound for a hop count we are willing to store / display. */
export const MAX_FORWARD_HOPS = 1000;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Returns a valid hop count (1..MAX_FORWARD_HOPS) or undefined. */
export function parseForwardHops(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_FORWARD_HOPS ? v : undefined;
}

export function parseEditPayload(p: any, maxTextLength: number): EditPayload | null {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.targetId !== 'string' || p.targetId.length === 0 || p.targetId.length > 64) return null;
  if (typeof p.newText !== 'string' || p.newText.length > maxTextLength) return null;
  if (typeof p.editedAt !== 'string' || !ISO_RE.test(p.editedAt)) return null;
  return { t: 'edit', targetId: p.targetId, newText: p.newText, editedAt: p.editedAt };
}
