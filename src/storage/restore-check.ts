import pg from "pg";
import { POSTGRES_TABLES, SECRET_COLUMNS } from "./postgres-storage.js";
import { ENCRYPTED_COLUMNS, ROTATION_PAGE_SIZE } from "./credential-rotation.js";
import { decryptToken, isEncryptedEnvelope, getKeyring, SECRET_DIGEST_PREFIX } from "./crypto.js";
import { CredentialDecryptionError } from "./storage-interface.js";

export interface TableReport {
  table: string;
  exists: boolean;
  rows: number;
  /** The connecting role owns the table or holds SELECT, INSERT, UPDATE and DELETE on it. */
  usable: boolean;
}

export interface RestoreCheckReport {
  ok: boolean;
  tables: TableReport[];
  credentials: { total: number; notUnderActiveKey: number; undecryptable: number };
  clearTextSecrets: number;
  /** Values in credential columns that are not encryption envelopes. */
  clearTextCredentials: number;
  /** Schema the unqualified table names resolved to, as the app sees it. */
  schema: string | null;
  /** Names of failed checks; never contains row data. */
  failures: string[];
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Read-only verification of a restored database. Everything runs in a
 * READ ONLY transaction that is rolled back; the report holds counts only.
 */
export async function checkRestoredDatabase(pool: pg.Pool, opts: { asRole?: string } = {}): Promise<RestoreCheckReport> {
  const client = await pool.connect();
  const failures: string[] = [];
  try {
    await client.query("BEGIN READ ONLY");
    if (opts.asRole) await client.query(`SET LOCAL ROLE ${quoteIdent(opts.asRole)}`);

    const schema = ((await client.query("SELECT current_schema() AS s")).rows[0]?.s as string | undefined) ?? null;
    const tables: TableReport[] = [];
    for (const table of POSTGRES_TABLES) {
      const found = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [table]);
      if (!found.rows[0]?.present) {
        tables.push({ table, exists: false, rows: 0, usable: false });
        failures.push(`table-missing:${table}`);
        continue;
      }
      const access = await client.query(
        `SELECT (pg_get_userbyid(c.relowner) = current_user OR has_table_privilege(current_user, c.oid, 'SELECT')
                AND has_table_privilege(current_user, c.oid, 'INSERT')
                AND has_table_privilege(current_user, c.oid, 'UPDATE')
                AND has_table_privilege(current_user, c.oid, 'DELETE')) AS usable
           FROM pg_class c WHERE c.oid = to_regclass($1)`,
        [table],
      );
      const usable = Boolean(access.rows[0]?.usable);
      let rows = 0;
      if (usable) rows = Number((await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
      else failures.push(`table-not-usable:${table}`);
      tables.push({ table, exists: true, rows, usable });
    }
    const present = (t: string) => tables.some(x => x.table === t && x.exists && x.usable);

    const activeId = getKeyring().activeId;
    const prefix = activeId ? `v2:${activeId}:` : "";
    const credentials = { total: 0, notUnderActiveKey: 0, undecryptable: 0 };
    let clearTextCredentials = 0;
    let v1MissingKey = false;
    for (const spec of ENCRYPTED_COLUMNS) {
      if (!present(spec.table)) continue;
      const selected = spec.key === "user_id" ? [spec.key, ...spec.columns] : [spec.key, "user_id", ...spec.columns];
      let after = "";
      for (;;) {
        const page = await client.query(
          `SELECT ${selected.join(", ")} FROM ${spec.table} WHERE ${spec.key} > $1 ORDER BY ${spec.key} LIMIT ${ROTATION_PAGE_SIZE}`,
          [after],
        );
        for (const row of page.rows as Record<string, unknown>[]) {
          const owner = String(row.user_id || "legacy_user");
          for (const column of spec.columns) {
            const value = row[column];
            if (typeof value !== "string" || value === "") continue;
            if (!isEncryptedEnvelope(value)) { clearTextCredentials++; continue; }
            credentials.total++;
            // v1 envelopes open with ENCRYPTION_KEY only; never let the dev fallback key decide.
            if (value.startsWith("v1:") && !process.env.ENCRYPTION_KEY) { v1MissingKey = true; continue; }
            if (!prefix || !value.startsWith(prefix)) credentials.notUnderActiveKey++;
            try {
              decryptToken(value, owner);
            } catch (error) {
              if (!(error instanceof CredentialDecryptionError)) throw error;
              credentials.undecryptable++;
            }
          }
        }
        if (page.rows.length < ROTATION_PAGE_SIZE) break;
        after = String(page.rows[page.rows.length - 1][spec.key]);
      }
    }
    if (v1MissingKey) failures.push("v1-credentials-need-ENCRYPTION_KEY");
    if (clearTextCredentials > 0) failures.push("clear-text-credentials");
    if (credentials.undecryptable > 0) failures.push("credentials-undecryptable");

    let clearTextSecrets = 0;
    for (const [table, column] of SECRET_COLUMNS) {
      if (!present(table)) continue;
      const res = await client.query(`SELECT count(*) AS n FROM ${table} WHERE ${column} IS NOT NULL AND ${column} NOT LIKE '${SECRET_DIGEST_PREFIX}%'`);
      clearTextSecrets += Number(res.rows[0].n);
    }
    if (clearTextSecrets > 0) failures.push("clear-text-secrets");

    await client.query("ROLLBACK");
    return { ok: failures.length === 0, tables, credentials, clearTextSecrets, clearTextCredentials, schema, failures };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
