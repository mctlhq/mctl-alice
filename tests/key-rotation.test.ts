import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { encryptToken, decryptToken, decryptStoredToken, getKeyring } from "../src/storage/crypto.js";
import { CredentialDecryptionError, IStorage } from "../src/storage/storage-interface.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { PostgresStorage } from "../src/storage/postgres-storage.js";
import { ROTATION_PAGE_SIZE, type RotationHooks } from "../src/storage/credential-rotation.js";
import { createHttpServer } from "../src/server/http-server.js";

const KEY_A = "a".repeat(64);
const KEY_B = Buffer.alloc(32, 7).toString("base64");
const KEY_C = "c".repeat(64);
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

  it("refuses to open a v2 envelope with a custom key", () => {
    useKeys(`a:${KEY_A}`, "a");
    const underA = encryptToken("secret", "alice");
    expect(() => decryptToken(underA, "alice", Buffer.from(KEY_A, "hex"))).toThrow(CredentialDecryptionError);
  });

  it("refuses to start the HTTP server with an inconsistent keyring", () => {
    const storage = new OAuthStorage(":memory:");
    try {
      useKeys(`a:${KEY_A}`, "missing");
      expect(() => createHttpServer(0, { authRequired: false, oauthStorage: storage, enableSampler: false })).toThrow(/ENCRYPTION_KEY_ID/);
    } finally { storage.close(); }
  });
});

// Rotation: values written as v1 (production today) are rewritten under a
// named key, then under the next one, after which the old key can be removed
// without losing a credential.
type Rotate = (rewrite: boolean, hooks?: RotationHooks) => Promise<{ stale: number; rewritten: number; failed: number } | null>;
async function rotation(
  storage: IStorage,
  rotate: Rotate,
  run: (sql: string, params: unknown[]) => Promise<unknown>,
  read: (sql: string) => Promise<string[]>,
) {
  const now = Date.now();
  const all = "SELECT encrypted_yandex_access_token AS v FROM user_credentials UNION ALL SELECT yandex_access_token FROM oauth_tokens UNION ALL SELECT yandex_access_token FROM oauth_codes";
  await storage.saveUser({ id: "alice", yandexUid: "alice", createdAt: now, updatedAt: now });
  await storage.saveUserCredentials("alice", { yandexAccessToken: "upstream", yandexRefreshToken: "upstream-refresh", quasarCookie: "Session_id=alice" });
  await storage.saveToken({ accessToken: "at", refreshToken: "rt", userId: "alice", clientId: "client",
    yandexAccessToken: "upstream", yandexRefreshToken: "upstream-refresh", scope: "iot:view", createdAt: now, expiresAt: now + 3600000 });
  await storage.saveAuthCode({ code: "code", clientId: "client", redirectUri: "https://claude.ai/cb", userId: "alice",
    yandexAccessToken: "upstream", scope: "iot:view", createdAt: now, expiresAt: now + 60000 });
  expect((await read(all)).every(v => v.startsWith("v1:"))).toBe(true);

  // v1 -> v2:b. A value rewritten by a request between scan and update is kept.
  useKeys(`b:${KEY_B}`, "b");
  expect(await rotate(false)).toEqual({ stale: 6, rewritten: 0, failed: 0 });
  const concurrent = encryptToken("concurrent", "alice");
  expect(await rotate(true, { afterScan: table => table === "oauth_tokens" ? run("UPDATE oauth_tokens SET yandex_access_token = $1", [concurrent]) : undefined }))
    .toEqual({ stale: 6, rewritten: 5, failed: 0 });
  expect(await read("SELECT yandex_access_token AS v FROM oauth_tokens")).toEqual([concurrent]);
  expect(await rotate(false)).toEqual({ stale: 0, rewritten: 0, failed: 0 });
  expect((await read(all)).every(v => v.startsWith("v2:b:"))).toBe(true);

  // v2:b -> v2:c, then b is retired.
  useKeys(`b:${KEY_B},c:${KEY_C}`, "c");
  expect(await rotate(true)).toEqual({ stale: 6, rewritten: 6, failed: 0 });
  useKeys(`c:${KEY_C}`, "c");
  expect(await rotate(false)).toEqual({ stale: 0, rewritten: 0, failed: 0 });
  expect(await storage.getUserCredentials("alice")).toMatchObject({ yandexAccessToken: "upstream", yandexRefreshToken: "upstream-refresh", quasarCookie: "Session_id=alice" });
  expect((await storage.getToken("at"))).toMatchObject({ yandexAccessToken: "concurrent", yandexRefreshToken: "upstream-refresh" });
  expect((await storage.consumeAuthCode("code"))?.yandexAccessToken).toBe("upstream");

  // A value no configured key opens is reported before the flag is set, and left in place.
  useKeys(`b:${KEY_B}`, "b");
  const orphan = encryptToken("orphan", "alice");
  useKeys(`c:${KEY_C}`, "c");
  await run("UPDATE oauth_tokens SET yandex_access_token = $1", [orphan]);
  expect(await rotate(false)).toEqual({ stale: 1, rewritten: 0, failed: 1 });
  expect(await rotate(true)).toEqual({ stale: 1, rewritten: 0, failed: 1 });
  expect(await read("SELECT yandex_access_token AS v FROM oauth_tokens")).toEqual([orphan]);

  // Ids may contain `_`, a LIKE wildcard: a value under kX1 is stale once k_1 is active.
  useKeys(`c:${KEY_C},kX1:${KEY_B},k_1:${KEY_A}`, "kX1");
  await run("UPDATE oauth_tokens SET yandex_access_token = $1", [encryptToken("underscore", "alice")]);
  expect(await rotate(true)).toEqual({ stale: 4, rewritten: 4, failed: 0 });
  useKeys(`kX1:${KEY_B},k_1:${KEY_A}`, "k_1");
  expect(await rotate(true)).toEqual({ stale: 5, rewritten: 5, failed: 0 });
  expect((await read(all)).every(v => v.startsWith("v2:k_1:"))).toBe(true);
  expect((await storage.getToken("at"))?.yandexAccessToken).toBe("underscore");
}

// More rows than one page holds: a report-only pass must still end, and
// count every row once, since none of them leaves the stale set.
async function paging(storage: IStorage, rotate: Rotate) {
  const now = Date.now();
  const total = ROTATION_PAGE_SIZE * 2 + 3;
  await storage.saveUser({ id: "alice", yandexUid: "alice", createdAt: now, updatedAt: now });
  for (let i = 0; i < total; i++) {
    await storage.saveToken({ accessToken: `at-${i}`, refreshToken: `rt-${i}`, userId: "alice", clientId: "client",
      yandexAccessToken: "upstream", scope: "iot:view", createdAt: now, expiresAt: now + 3600000 });
  }
  useKeys(`b:${KEY_B}`, "b");
  expect(await rotate(false)).toEqual({ stale: total, rewritten: 0, failed: 0 });
  expect(await rotate(true)).toEqual({ stale: total, rewritten: total, failed: 0 });
  expect(await rotate(false)).toEqual({ stale: 0, rewritten: 0, failed: 0 });
}

describe("credential re-encryption", () => {
  it("SQLite", async () => {
    const storage = new OAuthStorage(":memory:");
    const sql = (storage as unknown as { db: DatabaseSync }).db;
    try {
      await rotation(storage,
        async (rewrite, hooks) => storage.rotateCredentials(rewrite, hooks),
        async (query, params) => sql.prepare(query.replace(/\$\d/g, "?")).run(...(params as string[])),
        async query => (sql.prepare(query).all() as { v: string }[]).map(r => r.v));
    } finally { storage.close(); }
  });

  it("SQLite keeps starting when the pass fails", () => {
    const failing = vi.spyOn(OAuthStorage.prototype, "rotateCredentials").mockImplementation(() => { throw new Error("disk"); });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      new OAuthStorage(":memory:").close();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("re-encryption pass failed"), expect.any(Error));
    } finally { failing.mockRestore(); logged.mockRestore(); }
  });

  it("logs the progress of a pass that stops part-way", async () => {
    const storage = new OAuthStorage(":memory:");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const now = Date.now();
      await storage.saveUser({ id: "alice", yandexUid: "alice", createdAt: now, updatedAt: now });
      await storage.saveUserCredentials("alice", { yandexAccessToken: "upstream", quasarCookie: "Session_id=alice" });
      useKeys(`b:${KEY_B}`, "b");
      expect(() => storage.rotateCredentials(true, { afterScan: table => { if (table === "oauth_tokens") throw new Error("connection lost"); } })).toThrow("connection lost");
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/Re-encryption pass stopped part-way after 2 stale, 2 re-encrypted and 0 undecryptable/));
      logged.mockClear();
      useKeys(`c:${KEY_C}`, "c");
      expect(() => storage.rotateCredentials(false, { afterScan: table => { if (table === "oauth_tokens") throw new Error("connection lost"); } })).toThrow("connection lost");
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/report pass stopped part-way after 2 stale and 2 undecryptable/));
    } finally { logged.mockRestore(); storage.close(); }
  });

  it("SQLite, more rows than a page", async () => {
    const storage = new OAuthStorage(":memory:");
    try {
      await paging(storage, async rewrite => storage.rotateCredentials(rewrite));
    } finally { storage.close(); }
  });

  const connectionString = process.env.TEST_POSTGRES_URL;
  describe.skipIf(!connectionString)("PostgreSQL", () => {
    let admin: pg.Pool;
    const cleanup: (() => Promise<void>)[] = [];
    beforeAll(() => { admin = new pg.Pool({ connectionString }); });
    afterAll(async () => {
      for (const step of cleanup.reverse()) await step();
      await admin.end();
    });
    // Each test gets its own schema, so row counts start from zero.
    async function freshStorage() {
      const schema = "alice_test_" + randomUUID().replaceAll("-", "");
      const options = { connectionString, options: `-c search_path=${schema}` };
      await admin.query(`CREATE SCHEMA ${schema}`);
      const pool = new pg.Pool(options);
      const storage = new PostgresStorage({ pool: new pg.Pool(options) });
      cleanup.push(async () => { await storage.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); });
      await storage.ready();
      return { pool, storage };
    }
    it("PostgreSQL", async () => {
      const { pool, storage } = await freshStorage();
      await rotation(storage,
        (rewrite, hooks) => storage.rotateCredentials(rewrite, hooks),
        (query, params) => pool.query(query, params),
        async query => (await pool.query(query)).rows.map(r => r.v));
    });
    it("PostgreSQL, more rows than a page", async () => {
      const { storage } = await freshStorage();
      await paging(storage, rewrite => storage.rotateCredentials(rewrite));
    });
  });
});
