import { decryptToken, encryptToken, getKeyring, isEncryptedEnvelope } from "./crypto.js";
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

export type EncryptedTable = typeof ENCRYPTED_COLUMNS[number];

/**
 * SELECT for the rows of one table holding at least one envelope not under
 * the active key. Takes two parameters, the active prefix and its length,
 * written by `param(1)` and `param(2)`; the prefix is compared with substr,
 * not LIKE, because key ids may contain `_`. Once rotation is done the scan
 * returns nothing, so a start with an active key id costs one indexed-free
 * but empty pass rather than a read of every credential.
 */
export function staleRowsQuery({ table, key, columns }: EncryptedTable, param: (n: 1 | 2) => string): string {
  const selected = key === "user_id" ? [key, ...columns] : [key, "user_id", ...columns];
  const stale = columns.map(c => `(${c} LIKE 'v1:%' OR (${c} LIKE 'v2:%' AND substr(${c}, 1, ${param(2)}) <> ${param(1)}))`);
  return `SELECT ${selected.join(", ")} FROM ${table} WHERE ${stale.join(" OR ")}`;
}

/** Parameters for staleRowsQuery: the active envelope prefix and its length. */
export function staleRowsParams(activeId: string): [string, number] {
  const prefix = `v2:${activeId}:`;
  return [prefix, prefix.length];
}

/**
 * Counts one row's envelopes that are not under the active key, tries to
 * decrypt each (so a report-only start already shows what no configured key
 * opens) and, when rewrite is set, returns their replacements. Undecryptable
 * values are counted as failed and never replaced.
 */
export function rotateRow(row: Record<string, unknown>, columns: readonly string[], activeId: string, rewrite: boolean, counts: RotationCounts): Map<string, { from: string; to: string }> {
  const owner = String(row.user_id || "legacy_user");
  const prefix = `v2:${activeId}:`;
  const changes = new Map<string, { from: string; to: string }>();
  for (const column of columns) {
    const value = row[column];
    if (typeof value !== "string" || !isEncryptedEnvelope(value) || value.startsWith(prefix)) continue;
    counts.stale++;
    let plaintext: string;
    try {
      plaintext = decryptToken(value, owner);
    } catch (error) {
      if (!(error instanceof CredentialDecryptionError)) throw error;
      counts.failed++;
      continue;
    }
    if (!rewrite) continue;
    const next = encryptToken(plaintext, owner);
    // The keyring is read again per value; skip rather than write under another key.
    if (next.startsWith(prefix)) changes.set(column, { from: value, to: next });
  }
  return changes;
}

/** Test seam: runs after a table was scanned and before its rows are rewritten. */
export interface RotationHooks {
  afterScan?: (table: string) => void | Promise<void>;
}

export function logRotation(backend: string, counts: RotationCounts, rewrite: boolean): void {
  const tag = `[${backend}]`;
  if (counts.failed > 0) console.error(`${tag} ${counts.failed} stored credentials cannot be decrypted with any configured key; they are left unchanged and still count as stale.`);
  if (rewrite) {
    console.log(`${tag} Re-encrypted ${counts.rewritten} of ${counts.stale} stored credentials under the active key; unset REENCRYPT_STORED_CREDENTIALS once the stale count equals the undecryptable count (normally 0).`);
  } else if (counts.stale > 0) {
    console.warn(`${tag} ${counts.stale} stored credentials are not under the active key; set REENCRYPT_STORED_CREDENTIALS=true to rewrite them before retiring old keys.`);
  }
}
