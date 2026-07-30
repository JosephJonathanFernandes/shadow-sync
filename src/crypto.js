import crypto from 'node:crypto';

/**
 * Derives a 256-bit key using PBKDF2 with SHA-256 (600k iterations).
 */
export function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(
    passphrase,
    salt,
    600000, // NIST recommended iteration count
    32,     // 256 bits
    'sha256'
  );
}

/**
 * Encrypts raw .env text using AES-256-GCM.
 * Returns payload string format: "iv:authTag:ciphertext"
 */
export function encryptEnv(plainText, key) {
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plainText, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag().toString('base64');

  return `${iv.toString('base64')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts an encrypted payload string using AES-256-GCM.
 * Validates integrity via Auth Tag before decrypting.
 */
export function decryptEnv(encryptedPayload, key) {
  try {
    const parts = encryptedPayload.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid payload format');
    }

    const [ivBase64, authTagBase64, ciphertext] = parts;

    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    throw new Error('Invalid passphrase or corrupted data');
  }
}