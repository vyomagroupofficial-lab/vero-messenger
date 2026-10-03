/**
 * Hands a scanned QR payload to the next screen in memory, so secrets from
 * link/transfer codes never end up in route params (URLs / web history).
 */

import type { QrPayload } from './qrPayloads';

let pending: { payload: QrPayload; at: number } | null = null;

export function handOff(payload: QrPayload): void {
  pending = { payload, at: Date.now() };
}

/** Takes (and clears) the payload if it is of the expected kind and fresh. */
export function takeHandOff<K extends QrPayload['kind']>(kind: K): Extract<QrPayload, { kind: K }> | null {
  const p = pending;
  if (!p || p.payload.kind !== kind || Date.now() - p.at > 5 * 60_000) return null;
  pending = null;
  return p.payload as Extract<QrPayload, { kind: K }>;
}
