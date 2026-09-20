import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

let cachedKey: Buffer | null = null;

/**
 * Resolves the 32-byte master encryption key from environment or fallback.
 */
export function getEncryptionKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }

  const rawKey = process.env.ENCRYPTION_KEY;
  if (rawKey) {
    if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
      cachedKey = Buffer.from(rawKey, "hex");
    } else if (rawKey.length === 44 && /^[A-Za-z0-9+/=]+$/.test(rawKey)) {
      cachedKey = Buffer.from(rawKey, "base64");
    } else {
      cachedKey = crypto.createHash("sha256").update(rawKey).digest();
    }
    return cachedKey;
  }

  if (process.env.NODE_ENV === "production" && process.env.AUTH_REQUIRED === "true") {
    throw new Error(
      "ENCRYPTION_KEY must be configured in production multi-user mode. Storing plaintext credentials is prohibited."
    );
  }

  // Development/testing fallback derived deterministically
  const devSeed = process.env.YANDEX_CLIENT_SECRET || "mctl-alice-dev-secret-key-salt";
  cachedKey = crypto.createHash("sha256").update(devSeed).digest();
  return cachedKey;
}

/**
 * Encrypts sensitive credentials (OAuth tokens, cookies) with AES-256-GCM.
 * AAD (Associated Authenticated Data) is bound to userId to prevent cross-user ciphertext swapping.
 */
export function encryptToken(plaintext: string, userId: string, customKey?: Buffer): string {
  if (!plaintext) {
    return "";
  }
  const key = customKey || getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  cipher.setAAD(Buffer.from(userId, "utf8"));
  
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts sensitive credentials with AES-256-GCM and verifies userId binding.
 */
export function decryptToken(envelope: string, userId: string, customKey?: Buffer): string {
  if (!envelope) {
    return "";
  }
  
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid encryption envelope format");
  }

  const [, ivHex, tagHex, cipherHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(cipherHex, "hex");

  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error("Corrupted encryption envelope parameters");
  }

  const key = customKey || getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(userId, "utf8"));
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Computes a constant SHA-256 hex hash for indexing opaque tokens and session IDs.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
