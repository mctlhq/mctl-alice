import { getKeyring, isEncryptedEnvelope, reencryptedEnvelope } from "./crypto.js";
import { CredentialDecryptionError } from "./storage-interface.js";

/**
 * Columns holding encryption envelopes, with the row key and the owner whose
 * id is the AAD. Browser transactions are left out: their AAD is the raw
 * transaction key, which is stored only as a digest, and they expire in
 * minutes anyway.
 */
export const ENCRYPTED_COLUMNS = [
  { table: "user_credentials", key: "user_id", columns: ["encrypted_yandex_access_token", "encrypted_yandex_refresh_token", "encrypted_quasar_cookie"] },
  { table: "oauth_tokens", key: "access_token", columns: ["yandex_access_token", "yandex_refresh_token"] },
  { table: "oauth_codes", key: "code", columns: ["yandex_access_token", "yandex_refresh_token"] },
] as const;

export interface RotationCounts {
  /** Envelopes not under the active key when the pass started. */
  stale: number;
  /** Envelopes rewritten under the active key. */
  rewritten: number;
  /** Envelopes no configured key could decrypt; left as they are. */
  failed: number;
}

/** True when REENCRYPT_STORED_CREDENTIALS asks for the startup rewrite. */
export function reencryptRequested(): boolean {
  return process.env.REENCRYPT_STORED_CREDENTIALS === "true";
}

/** The active key id, or undefined when values are still written as v1. */
export function activeKeyId(): string | undefined {
  return getKeyring().activeId;
}

/**
 * Counts one row's envelopes that are not under the active key and, when
 * rewrite is set, returns their replacements. Undecryptable ones are counted
 * as failed and left out, never replaced.
 */
export function rotateRow(row: Record<string, unknown>, columns: readonly string[], activeId: string, rewrite: boolean, counts: RotationCounts): Map<string, { from: string; to: string }> {
  const owner = String(row.user_id || "legacy_user");
  const changes = new Map<string, { from: string; to: string }>();
  for (const column of columns) {
    const value = row[column];
    if (typeof value !== "string" || !isEncryptedEnvelope(value) || value.startsWith(`v2:${activeId}:`)) continue;
    counts.stale++;
    if (!rewrite) continue;
    try {
      changes.set(column, { from: value, to: reencryptedEnvelope(value, owner)! });
    } catch (error) {
      if (!(error instanceof CredentialDecryptionError)) throw error;
      counts.failed++;
    }
  }
  return changes;
}

export function logRotation(backend: string, counts: RotationCounts, rewrite: boolean): void {
  const tag = `[${backend}]`;
  if (counts.failed > 0) console.error(`${tag} ${counts.failed} stored credentials cannot be decrypted with any configured key; they were left unchanged.`);
  if (rewrite) {
    console.log(`${tag} Re-encrypted ${counts.rewritten} of ${counts.stale} stored credentials under the active key; unset REENCRYPT_STORED_CREDENTIALS once this reports 0 stale.`);
  } else if (counts.stale > 0) {
    console.warn(`${tag} ${counts.stale} stored credentials are not under the active key; set REENCRYPT_STORED_CREDENTIALS=true to rewrite them before retiring old keys.`);
  }
}
