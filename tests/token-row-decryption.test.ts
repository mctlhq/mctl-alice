import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { PostgresStorage } from "../src/storage/postgres-storage.js";
import { encryptToken } from "../src/storage/crypto.js";
import { CredentialDecryptionError, IStorage } from "../src/storage/storage-interface.js";

// Upstream Yandex tokens copied onto code and token rows must decrypt for the
// row's owner. Anything else is an error, never the stored string handed on as
// a token. Only a value that was never encrypted passes as legacy plaintext.
async function exercise(storage: IStorage, run: (sql: string, params: unknown[]) => Promise<unknown>) {
  const now = Date.now();
  await storage.saveUser({ id: "alice", yandexUid: "alice", createdAt: now, updatedAt: now });
  await storage.saveToken({ accessToken: "at-alice", refreshToken: "rt-alice", userId: "alice", clientId: "client",
    yandexAccessToken: "upstream-access", yandexRefreshToken: "upstream-refresh", scope: "iot:view", createdAt: now, expiresAt: now + 3600000 });
  await storage.saveAuthCode({ code: "code-alice", clientId: "client", redirectUri: "https://claude.ai/cb", userId: "alice",
    yandexAccessToken: "upstream-access", scope: "iot:view", createdAt: now, expiresAt: now + 60000 });
  expect((await storage.getToken("at-alice"))?.yandexAccessToken).toBe("upstream-access");

  const foreign = encryptToken("mallory-upstream", "mallory");
  await run("UPDATE oauth_tokens SET yandex_access_token = $1", [foreign]);
  await expect(Promise.resolve().then(() => storage.getToken("at-alice"))).rejects.toBeInstanceOf(CredentialDecryptionError);
  await expect(Promise.resolve().then(() => storage.getTokenByRefreshToken("rt-alice"))).rejects.toBeInstanceOf(CredentialDecryptionError);
  await run("UPDATE oauth_codes SET yandex_access_token = $1", [foreign]);
  await expect(Promise.resolve().then(() => storage.consumeAuthCode("code-alice"))).rejects.toBeInstanceOf(CredentialDecryptionError);

  await run("UPDATE oauth_tokens SET yandex_access_token = $1", ["legacy-plaintext"]);
  expect((await storage.getToken("at-alice"))?.yandexAccessToken).toBe("legacy-plaintext");
}

describe("token row decryption fails closed", () => {
  it("SQLite", async () => {
    const storage = new OAuthStorage(":memory:");
    const sql = (storage as unknown as { db: DatabaseSync }).db;
    try {
      await exercise(storage, async (query, params) => sql.prepare(query.replace(/\$\d/g, "?")).run(...(params as string[])));
    } finally { storage.close(); }
  });

  const connectionString = process.env.TEST_POSTGRES_URL;
  describe.skipIf(!connectionString)("PostgreSQL", () => {
    const schema = "alice_test_" + randomUUID().replaceAll("-", "");
    let admin: pg.Pool, pool: pg.Pool, storage: PostgresStorage;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const options = { connectionString, options: `-c search_path=${schema}` };
      pool = new pg.Pool(options);
      storage = new PostgresStorage({ pool: new pg.Pool(options) });
      await storage.ready();
    });
    afterAll(async () => { await storage.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
    it("PostgreSQL", async () => { await exercise(storage, (query, params) => pool.query(query, params)); });
  });
});
