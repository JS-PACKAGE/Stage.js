import { createSecretKey } from 'node:crypto';
import { ProtectionProfileAeadAes128Gcm, ProtectionProfileAes128CmHmacSha1_80, SrtpSession } from 'werift';

/** The session keys werift's SRTP ciphers pass to createCipheriv / createDecipheriv / createHmac. */
const KEY_FIELDS = ['srtpSessionKey', 'srtcpSessionKey', 'srtpSessionAuthTag', 'srtcpSessionAuthTag'] as const;

/**
 * werift (0.25) hands its SRTP session keys to node:crypto as raw Buffers on every packet, and
 * Node re-imports a secret key per call: at 300 listeners that was about a quarter of each media
 * worker's CPU. Accessors on the cipher prototypes turn every key into a KeyObject once, when the
 * cipher is built; each packet's cipher/HMAC setup is then 5–6× cheaper with identical output.
 * Affects ciphers constructed afterwards; call once per thread before peers connect.
 */
export function installSrtpKeyObjects(): void {
  for (const profile of [ProtectionProfileAes128CmHmacSha1_80, ProtectionProfileAeadAes128Gcm]) {
    const keys = { localMasterKey: Buffer.alloc(16), localMasterSalt: Buffer.alloc(14), remoteMasterKey: Buffer.alloc(16), remoteMasterSalt: Buffer.alloc(14) };
    const proto: object = Object.getPrototypeOf(new SrtpSession({ keys, profile }).localContext.cipher);
    for (const field of KEY_FIELDS) {
      if (Object.getOwnPropertyDescriptor(proto, field)) continue;
      const slot = Symbol(field);
      Object.defineProperty(proto, field, {
        configurable: true,
        get(this: Record<symbol, unknown>) { return this[slot]; },
        set(this: Record<symbol, unknown>, value: unknown) { this[slot] = Buffer.isBuffer(value) ? createSecretKey(value) : value; },
      });
    }
  }
}
