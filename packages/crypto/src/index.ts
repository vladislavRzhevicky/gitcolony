import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// AES-256-GCM envelope for user PATs.
// Ciphertext format: base64( iv(12) || authTag(16) || ciphertext(..) )
// Key is supplied once at process start via ENCRYPTION_KEY (base64, 32 bytes).

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function loadKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). ` +
        `Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (!cachedKey) cachedKey = loadKey();
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptSecret(envelope: string): string {
  const buf = Buffer.from(envelope, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('encrypted envelope too short');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);

  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
