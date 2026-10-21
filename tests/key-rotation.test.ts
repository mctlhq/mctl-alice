import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { encryptToken, decryptToken, decryptStoredToken, getKeyring } from "../src/storage/crypto.js";
import { CredentialDecryptionError, IStorage } from "../src/storage/storage-interface.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { PostgresStorage } from "../src/storage/postgres-storage.js";
import { createHttpServer } from "../src/server/http-server.js";

const KEY_A = "a".repeat(64);
const KEY_B = Buffer.alloc(32, 7).toString("base64");
const useKeys = (keys: string, active: string) => { vi.stubEnv("ENCRYPTION_KEYS", keys); vi.stubEnv("ENCRYPTION_KEY_ID", active); };

afterEach(() => { vi.unstubAllEnvs(); });

describe("encryption keyring", () => {
  it("writes v1 while no key id is active, and listed keys still decrypt", () => {
    expect(encryptToken("secret", "alice")).toMatch(/^v1:/);
    useKeys(`a:${KEY_A}`, "a");
    const underA = encryptToken("secret", "alice");
    useKeys(`a:${KEY_A}`, "");
    expect(encryptToken("secret", "alice")).toMatch(/^v1:/);
    expect(decryptToken(underA, "alice")).toBe("secret");
  });

  it("encrypts under the active key id and decrypts mixed versions", () => {
    const legacy = encryptToken("old", "alice");
    useKeys(`a:${KEY_A}`, "a");
    const underA = encryptToken("new", "alice");
    expect(underA).toMatch(/^v2:a:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    useKeys(`a:${KEY_A},b:${KEY_B}`, "b");
    expect(encryptToken("newer", "alice")).toMatch(/^v2:b:/);
    expect(decryptToken(legacy, "alice")).toBe("old");
    expect(decryptToken(underA, "alice")).toBe("new");
    expect(() => decryptToken(underA, "mallory")).toThrow(CredentialDecryptionError);
  });

  it("fails closed on an unknown key id, also for token rows", () => {
    useKeys(`a:${KEY_A}`, "a");
    const underA = encryptToken("token", "alice");
    useKeys(`b:${KEY_B}`, "b");
    expect(() => decryptToken(underA, "alice")).toThrow(CredentialDecryptionError);
    // A v2 value is an envelope, never legacy plaintext to hand on as a token.
    expect(() => decryptStoredToken(underA, "alice")).toThrow(CredentialDecryptionError);
    expect(decryptStoredToken("legacy-plaintext", "alice")).toBe("legacy-plaintext");
  });

  it("rejects an inconsistent keyring", () => {
    for (const [keys, active] of [
      [`a:${KEY_A}`, "b"],
      ["", "a"],
      [`a:${KEY_A},a:${KEY_B}`, "a"],
      [`a:short`, "a"],
      [`bad id:${KEY_A}`, "bad id"],
      [KEY_A, "a"],
    ]) {
      useKeys(keys, active);
      expect(() => getKeyring(), `${keys.slice(0, 12)} / ${active}`).toThrow();
    }
  });

  it("refuses to start the HTTP server with an inconsistent keyring", () => {
    const storage = new OAuthStorage(":memory:");
    try {
      useKeys(`a:${KEY_A}`, "missing");
      expect(() => createHttpServer(0, { authRequired: false, oauthStorage: storage, enableSampler: false })).toThrow(/ENCRYPTION_KEY_ID/);
    } finally { storage.close(); }
  });
});

// Rotation: rows written under one key are rewritten under the next, after
// which the old key can be removed without losing a credential.
async function rotation(
  storage: IStorage,
  rotate: (rewrite: boolean) => Promise<{ stale: number; rewritten: number; failed: number } | null>,
  run: (sql: string, params: unknown[]) => Promise<unknown>,
  read: (sql: string) => Promise<string[]>,
) {
  const now = Date.now();
  useKeys(`a:${KEY_A}`, "a");
  await storage.saveUser({ id: "alice", yandexUid: "alice", createdAt: now, updatedAt: now });
  await storage.saveUserCredentials("alice", { yandexAccessToken: "upstream", yandexRefreshToken: "upstream-refresh", quasarCookie: "Session_id=alice" });
  await storage.saveToken({ accessToken: "at", refreshToken: "rt", userId: "alice", clientId: "client",
    yandexAccessToken: "upstream", yandexRefreshToken: "upstream-refresh", scope: "iot:view", createdAt: now, expiresAt: now + 3600000 });
  await storage.saveAuthCode({ code: "code", clientId: "client", redirectUri: "https://claude.ai/cb", userId: "alice",
    yandexAccessToken: "upstream", scope: "iot:view", createdAt: now, expiresAt: now + 60000 });

  useKeys(`a:${KEY_A},b:${KEY_B}`, "b");
  expect(await rotate(false)).toEqual({ stale: 6, rewritten: 0, failed: 0 });
  expect(await rotate(true)).toEqual({ stale: 6, rewritten: 6, failed: 0 });
  expect(await rotate(false)).toEqual({ stale: 0, rewritten: 0, failed: 0 });
  const stored = await read("SELECT encrypted_yandex_access_token AS v FROM user_credentials UNION ALL SELECT yandex_access_token FROM oauth_tokens UNION ALL SELECT yandex_access_token FROM oauth_codes");
  expect(stored.every(v => v.startsWith("v2:b:"))).toBe(true);

  useKeys(`b:${KEY_B}`, "b");
  expect(await storage.getUserCredentials("alice")).toMatchObject({ yandexAccessToken: "upstream", yandexRefreshToken: "upstream-refresh", quasarCookie: "Session_id=alice" });
  expect((await storage.getToken("at"))?.yandexRefreshToken).toBe("upstream-refresh");
  expect((await storage.consumeAuthCode("code"))?.yandexAccessToken).toBe("upstream");

  // A value no configured key opens is counted, reported and left in place.
  useKeys(`a:${KEY_A}`, "a");
  const orphan = encryptToken("orphan", "alice");
  useKeys(`b:${KEY_B}`, "b");
  await run("UPDATE oauth_tokens SET yandex_access_token = $1", [orphan]);
  expect(await rotate(true)).toEqual({ stale: 1, rewritten: 0, failed: 1 });
  expect(await read("SELECT yandex_access_token AS v FROM oauth_tokens")).toEqual([orphan]);
}

describe("credential re-encryption", () => {
  it("SQLite", async () => {
    const storage = new OAuthStorage(":memory:");
    const sql = (storage as unknown as { db: DatabaseSync }).db;
    try {
      await rotation(storage,
        async rewrite => storage.rotateCredentials(rewrite),
        async (query, params) => sql.prepare(query.replace(/\$\d/g, "?")).run(...(params as string[])),
        async query => (sql.prepare(query).all() as { v: string }[]).map(r => r.v));
    } finally { storage.close(); }
  });

  const connectionString = process.env.TEST_POSTGRES_URL;
  describe.skipIf(!connectionString)("PostgreSQL", () => {
    const schema = "alice_test_" + randomUUID().replaceAll("-", "");
    const options = { connectionString, options: `-c search_path=${schema}` };
    let admin: pg.Pool, pool: pg.Pool, storage: PostgresStorage;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool(options);
    });
    afterAll(async () => {
      await storage.close();
      await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    });
    it("PostgreSQL", async () => {
      storage = new PostgresStorage({ pool: new pg.Pool(options) });
      await storage.ready();
      await rotation(storage,
        rewrite => storage.rotateCredentials(rewrite),
        (query, params) => pool.query(query, params),
        async query => (await pool.query(query)).rows.map(r => r.v));
    });
  });
});
