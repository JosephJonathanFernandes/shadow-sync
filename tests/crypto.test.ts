import { describe, expect, it } from 'vitest';
import {
  DecryptionError,
  decryptEnv,
  decryptEnvelope,
  deriveKey,
  encryptEnv,
  encryptEnvelope,
  generateRoomId,
} from '../src/crypto.js';

describe('crypto', () => {
  describe('generateRoomId', () => {
    it('generates formatted 12-char unambiguous room IDs', () => {
      const id = generateRoomId();
      expect(id).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    });

    it('generates unique room IDs across calls', () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateRoomId()));
      expect(ids.size).toBe(50);
    });
  });

  describe('deriveKey', () => {
    it('derives deterministic 32-byte keys for identical inputs', () => {
      const k1 = deriveKey('super-secret', 'ROOM-1234');
      const k2 = deriveKey('super-secret', 'ROOM-1234');
      expect(k1.length).toBe(32);
      expect(k1.equals(k2)).toBe(true);
    });

    it('derives different keys for different rooms or passphrases', () => {
      const k1 = deriveKey('super-secret', 'ROOM-1');
      const k2 = deriveKey('super-secret', 'ROOM-2');
      const k3 = deriveKey('other-secret', 'ROOM-1');
      expect(k1.equals(k2)).toBe(false);
      expect(k1.equals(k3)).toBe(false);
    });

    it('rejects empty passphrase or roomId', () => {
      expect(() => deriveKey('', 'ROOM-1')).toThrow();
      expect(() => deriveKey('secret', '')).toThrow();
    });
  });

  describe('encryptEnv / decryptEnv', () => {
    const key = deriveKey('test-passphrase', 'TEST-ROOM');

    it('round-trips plaintext including unicode and multiline .env content', () => {
      const env = 'API_KEY="sk-12345"\nDB_URL=postgres://user:p@ss/db\n# Comment 🔐\n';
      const encrypted = encryptEnv(env, key);
      expect(encrypted).not.toContain('sk-12345');
      expect(decryptEnv(encrypted, key)).toBe(env);
    });

    it('produces unique ciphertexts for identical plaintext due to random IV', () => {
      const a = encryptEnv('FOO=bar', key);
      const b = encryptEnv('FOO=bar', key);
      expect(a).not.toBe(b);
    });

    it('throws DecryptionError with wrong key', () => {
      const wrongKey = deriveKey('wrong-passphrase', 'TEST-ROOM');
      const encrypted = encryptEnv('SECRET=1', key);
      expect(() => decryptEnv(encrypted, wrongKey)).toThrow(DecryptionError);
    });

    it('throws DecryptionError when ciphertext is tampered with', () => {
      const encrypted = encryptEnv('SECRET=1', key);
      const parts = encrypted.split(':');
      parts[2] = Buffer.from('tampered').toString('base64');
      expect(() => decryptEnv(parts.join(':'), key)).toThrow(DecryptionError);
    });

    it('throws DecryptionError on malformed payload', () => {
      expect(() => decryptEnv('not-valid', key)).toThrow(DecryptionError);
      expect(() => decryptEnv('a:b:c', key)).toThrow(DecryptionError);
    });
  });

  describe('encryptEnvelope / decryptEnvelope', () => {
    const key = deriveKey('envelope-pass', 'ROOM-A');

    it('authenticates content, timestamp, and roomId via AAD', () => {
      const ts = 1700000000000;
      const encrypted = encryptEnvelope('PORT=3000\n', ts, key, 'ROOM-A');
      const decoded = decryptEnvelope(encrypted, key, 'ROOM-A');
      expect(decoded).toEqual({
        v: 1,
        content: 'PORT=3000\n',
        timestamp: ts,
      });
    });

    it('rejects cross-room replay even with the same key', () => {
      const encrypted = encryptEnvelope('PORT=3000', 12345, key, 'ROOM-A');
      expect(() => decryptEnvelope(encrypted, key, 'ROOM-B')).toThrow(DecryptionError);
    });
  });
});
