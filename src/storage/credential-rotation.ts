import { decryptToken, encryptToken, getKeyring, isEncryptedEnvelope } from "./crypto.js";
import { CredentialDecryptionError } from "./storage-interface.js";

/**
 * Columns holding encryption envelopes, with the row key and the owner whose
 * id is the AAD. Browser transactions are left out: their AAD is the raw
 * transaction key, which is stored only as a digest, and they expire in
 * minutes anyway. Each `key` must be a NOT NULL single-column text primary
 * key: the rotation pass pages on it with `key > last ORDER BY key`.
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

/** Rows read per page by the rotation pass. */
export const ROTATION_PAGE_SIZE = 200;

/**
 * SELECT for one page of the rows of a table holding at least one envelope
 * not under the active key, ordered by row key after `param(3)`. Parameters:
 * the active prefix, its length and the last key of the previous page. The
 * prefix is compared with substr, not LIKE, because key ids may contain `_`.
 * Once rotation is done the scan returns nothing.
 */
export function staleRowsQuery({ table, key, columns }: EncryptedTable, param: (n: 1 | 2 | 3) => string): string {
  const selected = key === "user_id" ? [key, ...columns] : [key, "user_id", ...columns];
  const stale = columns.map(c => `(${c} LIKE 'v1:%' OR (${c} LIKE 'v2:%' AND substr(${c}, 1, ${param(2)}) <> ${param(1)}))`);
  return `SELECT ${selected.join(", ")} FROM ${table} WHERE ${key} > ${param(3)} AND (${stale.join(" OR ")}) ORDER BY ${key} LIMIT ${ROTATION_PAGE_SIZE}`;
}

/** Parameters for staleRowsQuery: the active envelope prefix, its length and the key to page after. */
export function staleRowsParams(activeId: string, after: string): [string, number, string] {
  const prefix = `v2:${activeId}:`;
  return [prefix, prefix.length, after];
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

/** Test seam: runs after a page of a table was scanned and before its rows are rewritten. */
export interface RotationHooks {
  afterScan?: (table: string) => void | Promise<void>;
}

export function logRotation(backend: string, counts: RotationCounts, rewrite: boolean, complete = true): void {
  const tag = `[${backend}]`;
  if (!complete) {
    // A pass that stopped part-way still reports what it already did.
    const done = rewrite ? `, ${counts.rewritten} re-encrypted` : "";
    console.error(`${tag} ${rewrite ? "Re-encryption" : "Key rotation report"} pass stopped part-way after ${counts.stale} stale${done} and ${counts.failed} undecryptable stored credentials; it runs again on the next start.`);
    return;
  }
  if (counts.failed > 0) console.error(`${tag} ${counts.failed} stored credentials cannot be decrypted with any configured key; they are left unchanged and still count as stale.`);
  if (rewrite) {
    console.log(`${tag} Re-encrypted ${counts.rewritten} of ${counts.stale} stored credentials under the active key; unset REENCRYPT_STORED_CREDENTIALS once the stale count equals the undecryptable count (normally 0).`);
  } else if (counts.stale > 0) {
    console.warn(`${tag} ${counts.stale} stored credentials are not under the active key; set REENCRYPT_STORED_CREDENTIALS=true to rewrite them before retiring old keys.`);
  }
}
