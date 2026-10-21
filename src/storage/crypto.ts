import { CredentialDecryptionError } from "./storage-interface.js";
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

let cachedKey: Buffer | null = null;

/** Parses a configured key: 64 hex chars or 44 base64 chars; anything else is hashed as a passphrase. */
function parseKey(rawKey: string): Buffer {
  if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) return Buffer.from(rawKey, "hex");
  if (rawKey.length === 44 && /^[A-Za-z0-9+/=]+$/.test(rawKey)) return Buffer.from(rawKey, "base64");
  return crypto.createHash("sha256").update(rawKey).digest();
}

/**
 * Resolves the 32-byte key of the unversioned v1 envelope (ENCRYPTION_KEY,
 * or a development fallback).
 */
export function getEncryptionKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }

  const rawKey = process.env.ENCRYPTION_KEY;
  if (rawKey) {
    cachedKey = parseKey(rawKey);
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

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export interface Keyring {
  /** Key id new values are encrypted under; undefined keeps writing v1 with ENCRYPTION_KEY. */
  activeId?: string;
  keys: Map<string, Buffer>;
}

let cachedKeyring: { source: string; keyring: Keyring } | null = null;

/**
 * Reads the named keys for the v2 envelope from ENCRYPTION_KEYS
 * ("id:key,id:key", each key 64 hex or 44 base64 chars) and the active one
 * from ENCRYPTION_KEY_ID. Keys listed without an active id only decrypt, so
 * a new key can reach every replica before any of them writes under it. Any
 * inconsistency throws: the server must not start with a key it cannot use.
 */
export function getKeyring(): Keyring {
  const rawKeys = process.env.ENCRYPTION_KEYS || "";
  const activeId = process.env.ENCRYPTION_KEY_ID || undefined;
  const source = `${rawKeys}\n${activeId ?? ""}`;
  if (cachedKeyring?.source === source) return cachedKeyring.keyring;

  const keys = new Map<string, Buffer>();
  for (const entry of rawKeys.split(",").map(e => e.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    const id = entry.slice(0, separator);
    const rawKey = entry.slice(separator + 1);
    if (separator < 1 || !KEY_ID.test(id)) throw new Error("ENCRYPTION_KEYS: every entry must be <id>:<key> with an id of [A-Za-z0-9_-]{1,32}");
    if (keys.has(id)) throw new Error(`ENCRYPTION_KEYS: key id ${id} is listed twice`);
    const isHex = /^[0-9a-fA-F]{64}$/.test(rawKey);
    const isBase64 = /^[A-Za-z0-9+/]{43}=$/.test(rawKey);
    if (!isHex && !isBase64) throw new Error(`ENCRYPTION_KEYS: key ${id} must be 32 bytes as 64 hex or 44 base64 characters`);
    keys.set(id, Buffer.from(rawKey, isHex ? "hex" : "base64"));
  }
  if (activeId && !keys.has(activeId)) throw new Error(`ENCRYPTION_KEY_ID ${activeId} is not in ENCRYPTION_KEYS`);

  const keyring = { activeId, keys };
  cachedKeyring = { source, keyring };
  return keyring;
}

function seal(plaintext: string, aad: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
}

function open(ivHex: string, tagHex: string, cipherHex: string, aad: string, key: Buffer): string {
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error("Corrupted encryption envelope parameters");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(cipherHex, "hex")), decipher.final()]).toString("utf8");
}

/**
 * Encrypts sensitive credentials (OAuth tokens, cookies) with AES-256-GCM.
 * AAD (Associated Authenticated Data) is bound to userId to prevent cross-user ciphertext swapping.
 * With an active key id the result is `v2:<id>:iv:tag:ct`; otherwise (or with
 * an explicit customKey) it is the unversioned `v1:iv:tag:ct`.
 */
export function encryptToken(plaintext: string, userId: string, customKey?: Buffer): string {
  if (!plaintext) {
    return "";
  }
  const { activeId, keys } = getKeyring();
  if (!customKey && activeId) {
    return `v2:${activeId}:${seal(plaintext, userId, keys.get(activeId)!)}`;
  }
  return `v1:${seal(plaintext, userId, customKey || getEncryptionKey())}`;
}

/**
 * Decrypts sensitive credentials with AES-256-GCM and verifies userId binding.
 * A v2 envelope decrypts only with the key its id names; an id that is not
 * configured fails like any other undecryptable value.
 */
export function decryptToken(envelope: string, userId: string, customKey?: Buffer): string {
  if (!envelope) {
    return "";
  }

  try {
    const parts = envelope.split(":");
    if (parts.length === 4 && parts[0] === "v1") {
      return open(parts[1], parts[2], parts[3], userId, customKey || getEncryptionKey());
    }
    if (parts.length === 5 && parts[0] === "v2") {
      const key = getKeyring().keys.get(parts[1]);
      if (!key) throw new Error("Unknown encryption key id");
      return open(parts[2], parts[3], parts[4], userId, key);
    }
    throw new Error("Invalid encryption envelope format");
  } catch { throw new CredentialDecryptionError(); }
}

/** True when a stored value is an encryption envelope rather than legacy plaintext. */
export function isEncryptedEnvelope(value: string): boolean {
  return value.startsWith("v1:") || value.startsWith("v2:");
}

/**
 * Reads an upstream token copied onto an auth code or access token row. A
 * value in an encryption envelope must decrypt; if it does not (wrong key,
 * unknown key id, wrong user, corruption) this throws
 * CredentialDecryptionError instead of handing the ciphertext on as if it
 * were a token. Only a value that was never encrypted (rows written before
 * encryption existed) is returned as is.
 */
export function decryptStoredToken(value: string, userId: string): string {
  return isEncryptedEnvelope(value) ? decryptToken(value, userId) : value;
}

/**
 * The value re-encrypted under the active key, or null when it already is
 * (or no key id is active, or it is empty or legacy plaintext). Throws
 * CredentialDecryptionError when the value cannot be decrypted.
 */
export function reencryptedEnvelope(value: string | null | undefined, userId: string): string | null {
  const { activeId } = getKeyring();
  if (!activeId || !value || !isEncryptedEnvelope(value) || value.startsWith(`v2:${activeId}:`)) return null;
  return encryptToken(decryptToken(value, userId), userId);
}

/**
 * Computes a constant SHA-256 hex hash for indexing opaque tokens and session IDs.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Prefix that marks a stored value as a digest rather than a bearer secret. */
export const SECRET_DIGEST_PREFIX = "sha256:";

/**
 * Stored form of a bearer secret (MCP access/refresh token, auth code, session
 * ID, browser transaction key): a database dump must not yield usable secrets.
 */
export function secretDigest(secret: string): string {
  return SECRET_DIGEST_PREFIX + hashToken(secret);
}

/**
 * Stored form for a token record field that may already be a stored handle
 * (a record read back and saved again must not be hashed twice).
 */
export function storedSecret(secretOrHandle: string): string {
  return secretOrHandle.startsWith(SECRET_DIGEST_PREFIX) ? secretOrHandle : secretDigest(secretOrHandle);
}

/**
 * Keys to look a presented secret up by: its digest, plus the raw value for
 * rows written before hashing (e.g. by an older pod during a rollout). A
 * presented value that already looks like a digest never matches raw, so a
 * leaked digest cannot be replayed as a credential.
 */
export function secretLookupKeys(secret: string): [string, string] {
  const digest = secretDigest(secret);
  return [digest, secret.startsWith(SECRET_DIGEST_PREFIX) ? digest : secret];
}
