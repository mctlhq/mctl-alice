import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { encryptToken } from "../src/storage/crypto.js";
import { POSTGRES_TABLES, PostgresStorage } from "../src/storage/postgres-storage.js";
import { ROTATION_PAGE_SIZE } from "../src/storage/credential-rotation.js";
import { checkRestoredDatabase } from "../src/storage/restore-check.js";

afterEach(() => { vi.unstubAllEnvs(); });

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

interface Seed { missing?: string; unusable?: string; rows?: Record<string, Record<string, unknown>[]>; counts?: Record<string, number>; }

function mockPool(seed: Seed) {
  const queries: string[] = [];
  const client = {
    release: () => undefined,
    query: async (sql: string, params: unknown[] = []) => {
      queries.push(sql);
      if (sql.includes("current_schema()")) return { rows: [{ s: "public" }] };
      if (sql.includes("to_regclass($1) IS NOT NULL")) return { rows: [{ present: seed.missing !== params[0] }] };
      if (sql.includes("FROM pg_class")) return { rows: [{ usable: seed.unusable !== params[0] }] };
      const page = sql.match(/FROM (\w+) WHERE (\w+) > \$1/);
      if (page) return { rows: params[0] === "" ? seed.rows?.[page[1]] ?? [] : [] };
      const clear = sql.match(/FROM (\w+) WHERE (\w+) IS NOT NULL AND/);
      if (clear) return { rows: [{ n: (seed.rows?.[clear[1]] ?? []).filter(r => r[clear[2]] && !String(r[clear[2]]).startsWith("sha256:")).length }] };
      if (sql.startsWith("SELECT count(*)")) return { rows: [{ n: 3 }] };
      return { rows: [] };
    },
  };
  return { pool: { connect: async () => client } as never, queries };
}

describe("checkRestoredDatabase", () => {
  it("passes a healthy database and only reads", async () => {
    vi.stubEnv("ENCRYPTION_KEY", KEY_A);
    const env = encryptToken("yandex-secret-value", "u1");
    const { pool, queries } = mockPool({ rows: { user_credentials: [{ user_id: "u1", encrypted_yandex_access_token: env }] } });
    const report = await checkRestoredDatabase(pool);
    expect(report.ok).toBe(true);
    expect(report.tables).toHaveLength(POSTGRES_TABLES.length);
    expect(report.credentials).toEqual({ total: 1, notUnderActiveKey: 1, undecryptable: 0 });
    expect(report.clearTextCredentials).toBe(0);
    expect(report.schema).toBe("public");
    expect(queries.some(q => /^\s*(UPDATE|DELETE|INSERT)\b/i.test(q))).toBe(false);
    expect(queries[0]).toBe("BEGIN READ ONLY");
    expect(queries.at(-1)).toBe("ROLLBACK");
  });

  it("flags missing, unusable, clear-text and undecryptable data without leaking values", async () => {
    vi.stubEnv("ENCRYPTION_KEYS", `old:${KEY_B}`);
    vi.stubEnv("ENCRYPTION_KEY_ID", "old");
    const foreign = encryptToken("other-key-plaintext", "u1");
    // The restoring environment does not know the key the data was written under.
    vi.stubEnv("ENCRYPTION_KEYS", `new:${KEY_A}`);
    vi.stubEnv("ENCRYPTION_KEY_ID", "new");
    const { pool } = mockPool({
      missing: "users",
      unusable: "oauth_clients",
      rows: {
        user_credentials: [{ user_id: "u1", encrypted_yandex_access_token: foreign }],
        oauth_tokens: [{ access_token: "clear-bearer-token", user_id: "u1" }],
      },
    });
    const report = await checkRestoredDatabase(pool);
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual(expect.arrayContaining([
      "table-missing:users", "table-not-usable:oauth_clients", "credentials-undecryptable", "clear-text-secrets",
    ]));
    const text = JSON.stringify(report);
    for (const secret of ["clear-bearer-token", foreign, "other-key-plaintext"]) expect(text).not.toContain(secret);
  });
});

describe("checkRestoredDatabase credential edge cases", () => {
  it("fails on clear-text credentials and on v1 values without ENCRYPTION_KEY", async () => {
    vi.stubEnv("ENCRYPTION_KEY", KEY_A);
    const v1 = encryptToken("yandex-secret-value", "u1");
    vi.stubEnv("ENCRYPTION_KEY", "");
    vi.stubEnv("ENCRYPTION_KEYS", `new:${KEY_A}`);
    vi.stubEnv("ENCRYPTION_KEY_ID", "new");
    const { pool } = mockPool({
      rows: { user_credentials: [
        { user_id: "u1", encrypted_yandex_access_token: v1, encrypted_yandex_refresh_token: "plain-refresh" },
      ] },
    });
    const report = await checkRestoredDatabase(pool);
    expect(report.ok).toBe(false);
    expect(report.clearTextCredentials).toBe(1);
    expect(report.failures).toEqual(expect.arrayContaining(["clear-text-credentials", "v1-credentials-need-ENCRYPTION_KEY"]));
    expect(report.failures).not.toContain("credentials-undecryptable");
  });
});

const connectionString = process.env.TEST_POSTGRES_URL;
describe.skipIf(!connectionString)("checkRestoredDatabase against PostgreSQL", () => {
  let admin: pg.Pool;
  const cleanup: (() => Promise<void>)[] = [];
  beforeAll(() => { admin = new pg.Pool({ connectionString }); });
  afterAll(async () => {
    for (const step of cleanup.reverse()) await step();
    await admin.end();
  });

  async function fresh() {
    const schema = "alice_rc_" + randomUUID().replaceAll("-", "");
    const options = { connectionString, options: `-c search_path=${schema}` };
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool(options);
    const storage = new PostgresStorage({ pool: new pg.Pool(options) });
    cleanup.push(async () => { await storage.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); });
    await storage.ready();
    return { pool, schema };
  }

  it("evaluates the real SQL: schema, privileges, clear text, paging", async () => {
    vi.stubEnv("ENCRYPTION_KEY", KEY_A);
    const { pool, schema } = await fresh();
    const total = ROTATION_PAGE_SIZE + 5;
    for (let i = 0; i < total; i++) {
      await pool.query(
        "INSERT INTO oauth_codes (code, client_id, redirect_uri, user_id, yandex_access_token, scope, created_at, expires_at) VALUES ($1,'c','r','u1',$2,'s',0,0)",
        [`sha256:c${String(i).padStart(4, "0")}`, "plain-token"],
      );
    }
    const report = await checkRestoredDatabase(pool);
    expect(report.schema).toBe(schema);
    expect(report.tables.every(t => t.exists && t.usable)).toBe(true);
    // Every row (more than one page) is scanned: all hold a clear-text credential.
    expect(report.clearTextCredentials).toBe(total);
    expect(report.failures).toContain("clear-text-credentials");

    const role = "alice_ro_" + randomUUID().replaceAll("-", "").slice(0, 12);
    await admin.query(`CREATE ROLE ${role}`);
    cleanup.push(async () => { await admin.query(`DROP OWNED BY ${role}`); await admin.query(`DROP ROLE ${role}`); });
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    const ro = await checkRestoredDatabase(pool, { asRole: role });
    expect(ro.tables.every(t => !t.usable)).toBe(true);
    expect(ro.failures).toContain("table-not-usable:users");
  });
});

describe("restore-check CLI", () => {
  it("exits non-zero without an encryption key, before connecting", () => {
    const env = { ...process.env, DATABASE_URL: "postgres://invalid.invalid/db" };
    delete env.ENCRYPTION_KEY;
    delete env.ENCRYPTION_KEYS;
    const res = spawnSync(process.execPath, ["--import", "tsx", "src/restore-check.ts"], { env, encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("ENCRYPTION_KEY");
  });
});
