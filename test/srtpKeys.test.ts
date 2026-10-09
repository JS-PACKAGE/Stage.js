import assert from 'node:assert/strict';
import { KeyObject } from 'node:crypto';
import { it } from 'node:test';
import { ProtectionProfileAeadAes128Gcm, ProtectionProfileAes128CmHmacSha1_80, RtpHeader, SrtpSession } from 'werift';
import { installSrtpKeyObjects } from '../src/transport/srtpKeys.ts';

const a = { key: Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'), salt: Buffer.from('f0f1f2f3f4f5f6f7f8f9fafbfcfd', 'hex') };
const b = { key: Buffer.from('101112131415161718191a1b1c1d1e1f', 'hex'), salt: Buffer.from('e0e1e2e3e4e5e6e7e8e9eaebeced', 'hex') };
const session = (profile: number, local: typeof a, remote: typeof a) =>
  new SrtpSession({ profile, keys: { localMasterKey: local.key, localMasterSalt: local.salt, remoteMasterKey: remote.key, remoteMasterSalt: remote.salt } });
const payload = Buffer.from(Array.from({ length: 150 }, (_, i) => i));
const header = () => new RtpHeader({ payloadType: 111, sequenceNumber: 4242, timestamp: 960_000, ssrc: 0x12345678, marker: true });
const profiles = [ProtectionProfileAes128CmHmacSha1_80, ProtectionProfileAeadAes128Gcm];

it('SRTP ciphers built after install hold KeyObjects and still produce werift\'s exact packets', () => {
  // Reference ciphertext from werift as shipped; this test file runs in its own process.
  const reference = profiles.map((p) => session(p, a, b).encrypt(payload, header()));
  installSrtpKeyObjects();
  installSrtpKeyObjects(); // idempotent
  profiles.forEach((profile, i) => {
    const sender = session(profile, a, b);
    assert.ok(sender.localContext.cipher.srtpSessionKey instanceof KeyObject, `profile ${profile}: key converted (werift layout changed?)`);
    const packet = sender.encrypt(payload, header());
    assert.deepEqual(packet, reference[i], `profile ${profile}: ciphertext unchanged`);
    const plain = session(profile, b, a).decrypt(packet);
    assert.deepEqual(plain.subarray(plain.length - payload.length), payload);
  });
});
