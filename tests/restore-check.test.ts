import { describe, it, expect, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { encryptToken } from "../src/storage/crypto.js";
import { POSTGRES_TABLES } from "../src/storage/postgres-storage.js";
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
      if (sql.includes("to_regclass($1) IS NOT NULL")) return { rows: [{ present: `public.${seed.missing}` !== params[0] }] };
      if (sql.includes("FROM pg_class")) return { rows: [{ usable: `public.${seed.unusable}` !== params[0] }] };
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
