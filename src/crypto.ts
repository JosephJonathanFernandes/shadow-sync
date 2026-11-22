import crypto from 'node:crypto';

const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const SALT_PREFIX = 'shadow-sync:v1:';
const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excludes ambiguous 0/O/1/I

export interface SyncEnvelope {
  v: 1;
  content: string;
  timestamp: number;
}

export class DecryptionError extends Error {
  constructor(message = 'Invalid passphrase or corrupted payload') {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * Generates a cryptographically secure, human-readable Room ID (e.g. "A7K9-M2P4-X8Q3").
 * Uses 12 characters from an unambiguous 32-char alphabet (60 bits of entropy).
 */
export function generateRoomId(): string {
  const bytes = crypto.randomBytes(12);
  let raw = '';
  for (let i = 0; i < 12; i++) {
    raw += ROOM_ID_ALPHABET[bytes[i]! % ROOM_ID_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

/**
 * Derives a 256-bit key using PBKDF2 with SHA-256 (600,000 iterations, NIST recommended).
 */
export function deriveKey(passphrase: string, roomId: string): Buffer {
  if (!passphrase) {
    throw new Error('Passphrase must not be empty');
  }
  if (!roomId) {
    throw new Error('Room ID must not be empty');
  }
  return crypto.pbkdf2Sync(
    passphrase,
    `${SALT_PREFIX}${roomId}`,
    PBKDF2_ITERATIONS,
    KEY_LENGTH_BYTES,
    'sha256',
  );
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Returns payload string format: "iv:authTag:ciphertext" (base64 encoded).
 * Optionally binds Additional Authenticated Data (AAD) such as the roomId.
 */
export function encryptEnv(plainText: string, key: Buffer, aad?: string): string {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`Invalid key length: expected ${KEY_LENGTH_BYTES} bytes`);
  }

  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  if (aad !== undefined) {
    cipher.setAAD(Buffer.from(aad, 'utf8'));
  }

  const encrypted = Buffer.concat([
    cipher.update(plainText, 'utf8'),
    cipher.final(),
  ]).toString('base64');

  const authTag = cipher.getAuthTag().toString('base64');

  return `${iv.toString('base64')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM payload string ("iv:authTag:ciphertext").
 * Validates integrity via the authentication tag before returning plaintext.
 */
export function decryptEnv(encryptedPayload: string, key: Buffer, aad?: string): string {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new DecryptionError('Invalid key length');
  }

  try {
    const parts = encryptedPayload.split(':');
    if (parts.length !== 3) {
      throw new DecryptionError('Invalid payload format');
    }

    const [ivBase64, authTagBase64, ciphertext] = parts as [string, string, string];
    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');

    if (iv.length !== IV_LENGTH_BYTES || authTag.length !== AUTH_TAG_LENGTH_BYTES) {
      throw new DecryptionError('Invalid IV or auth tag length');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    if (aad !== undefined) {
      decipher.setAAD(Buffer.from(aad, 'utf8'));
    }
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    return decrypted;
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw error;
    }
    throw new DecryptionError();
  }
}

/**
 * Encrypts a versioned SyncEnvelope containing both the .env content and its
 * authoritative LWW timestamp, authenticated with roomId as AAD so the relay
 * server cannot inspect, forge, or cross-room-replay updates.
 */
export function encryptEnvelope(
  content: string,
  timestamp: number,
  key: Buffer,
  roomId: string,
): string {
  const envelope: SyncEnvelope = {
    v: 1,
    content,
    timestamp,
  };
  return encryptEnv(JSON.stringify(envelope), key, roomId);
}

/**
 * Decrypts and validates a SyncEnvelope.
 */
export function decryptEnvelope(
  encryptedPayload: string,
  key: Buffer,
  roomId: string,
): SyncEnvelope {
  const raw = decryptEnv(encryptedPayload, key, roomId);
  try {
    const parsed = JSON.parse(raw) as Partial<SyncEnvelope>;
    if (
      parsed.v !== 1 ||
      typeof parsed.content !== 'string' ||
      typeof parsed.timestamp !== 'number' ||
      !Number.isFinite(parsed.timestamp)
    ) {
      throw new DecryptionError('Malformed sync envelope');
    }
    return {
      v: 1,
      content: parsed.content,
      timestamp: parsed.timestamp,
    };
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw error;
    }
    throw new DecryptionError('Malformed sync envelope');
  }
}
