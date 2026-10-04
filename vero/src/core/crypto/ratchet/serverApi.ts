/**
 * PreKeyServer over Supabase RPCs (supabase/migrations/003_ratchet.sql).
 * Takes any client with `rpc()`, so the app and the bot SDK share it.
 */

import type { PreKeyBundle } from './keys';
import type { PreKeyServer, PreKeyStatus } from './SessionManager';

export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what} failed: ${error.message}`);
}

export function bundleFromRow(r: any): PreKeyBundle | null {
  if (!r || typeof r.device_id !== 'string' || typeof r.identity_public_key !== 'string') return null;
  if (typeof r.signing_public_key !== 'string' || typeof r.signed_prekey !== 'string') return null;
  return {
    deviceId: r.device_id,
    userId: r.user_id,
    identityKey: r.identity_public_key,
    signingKey: r.signing_public_key,
    identitySignature: r.identity_signature,
    signedPreKeyId: r.signed_prekey_id,
    signedPreKey: r.signed_prekey,
    signedPreKeySignature: r.signed_prekey_signature,
    oneTimePreKeyId: r.one_time_prekey_id ?? null,
    oneTimePreKey: r.one_time_prekey ?? null,
  };
}

export function createPreKeyServer(client: RpcClient): PreKeyServer {
  return {
    async claimBundles(deviceIds) {
      if (deviceIds.length === 0) return [];
      const { data, error } = await client.rpc('claim_prekey_bundle', { p_device_ids: deviceIds });
      if (error) fail('claim_prekey_bundle', error);
      return ((data as any[]) ?? []).map(bundleFromRow).filter((b): b is PreKeyBundle => b !== null);
    },
    async publishSigningKey(deviceId, signingKey, identitySignature) {
      const { error } = await client.rpc('publish_device_signing_key', {
        p_device_id: deviceId,
        p_signing_key: signingKey,
        p_identity_signature: identitySignature,
      });
      if (error) fail('publish_device_signing_key', error);
    },
    async uploadPreKeys(deviceId, signedPreKey, oneTimePreKeys) {
      let count = 0;
      // The server takes at most 100 one-time prekeys per call.
      for (let i = 0; i === 0 || i < oneTimePreKeys.length; i += 100) {
        const { data, error } = await client.rpc('upload_prekeys', {
          p_device_id: deviceId,
          p_signed_prekey:
            i === 0 && signedPreKey
              ? { id: signedPreKey.id, public_key: signedPreKey.publicKey, signature: signedPreKey.signature }
              : null,
          p_one_time_prekeys: oneTimePreKeys.slice(i, i + 100).map((o) => ({ id: o.id, public_key: o.publicKey })),
        });
        if (error) fail('upload_prekeys', error);
        count = typeof data === 'number' ? data : count;
      }
      return count;
    },
    async preKeyStatus(deviceId): Promise<PreKeyStatus> {
      const { data, error } = await client.rpc('get_prekey_status', { p_device_id: deviceId });
      if (error) fail('get_prekey_status', error);
      const row = Array.isArray(data) ? data[0] : data;
      return {
        oneTime: typeof row?.one_time_count === 'number' ? row.one_time_count : 0,
        signedPreKeyId: typeof row?.signed_prekey_id === 'number' ? row.signed_prekey_id : null,
      };
    },
  };
}
