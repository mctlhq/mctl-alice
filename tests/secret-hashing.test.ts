import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { PostgresStorage } from "../src/storage/postgres-storage.js";
import { IStorage } from "../src/storage/storage-interface.js";
import { secretDigest } from "../src/storage/crypto.js";

const now = Date.now();
const secrets = { access: "mctl_at_secret_access", refresh: "mctl_rt_secret_refresh", code: "code_secret_value", session: "session-secret-id", tx: "login:secret-state" };

async function writeAll(storage: IStorage) {
  await storage.saveUser({ id: "alice", yandexUid: "alice", createdAt: now, updatedAt: now });
  await storage.saveToken({ accessToken: secrets.access, refreshToken: secrets.refresh, userId: "alice", clientId: "client", yandexAccessToken: "y", scope: "iot:view", createdAt: now, expiresAt: now + 3600000 });
  await storage.saveAuthCode({ code: secrets.code, clientId: "client", redirectUri: "http://localhost/cb", userId: "alice", yandexAccessToken: "y", scope: "iot:view", createdAt: now, expiresAt: now + 60000 });
  await storage.saveWebSession(secrets.session, "alice", now + 60000);
  await storage.saveBrowserTransaction(secrets.tx, "payload", now + 60000);
}

// Every behavior both backends must share.
function contract(name: string, open: () => Promise<{ storage: IStorage; dump: () => Promise<string>; rawInsert: (sql: string[]) => Promise<void>; reopen: (options?: { rehash?: boolean }) => Promise<IStorage> }>) {
  describe(name, () => {
    it("stores no bearer secret in clear text and still resolves each one", async () => {
      const { storage, dump } = await open();
      await writeAll(storage);
      const contents = await dump();
      for (const value of Object.values(secrets)) expect(contents, value).not.toContain(value);
      expect((await storage.getToken(secrets.access))?.accessToken).toBe(secrets.access);
      expect((await storage.getTokenByRefreshToken(secrets.refresh))?.refreshToken).toBe(secrets.refresh);
      expect((await storage.getWebSession(secrets.session))?.userId).toBe("alice");
      expect(await storage.getBrowserTransaction(secrets.tx)).toBe("payload");
      expect((await storage.consumeAuthCode(secrets.code))?.code).toBe(secrets.code);
      expect(await storage.consumeAuthCode(secrets.code)).toBeNull();
    });
    it("deleting a session or browser transaction invalidates it", async () => {
      const { storage } = await open();
      await writeAll(storage);
      await storage.deleteWebSession(secrets.session);
      expect(await storage.getWebSession(secrets.session)).toBeNull();
      await storage.deleteBrowserTransaction(secrets.tx);
      expect(await storage.getBrowserTransaction(secrets.tx)).toBeNull();
    });
    it("never accepts a stored digest as the secret", async () => {
      const { storage } = await open();
      await writeAll(storage);
      expect(await storage.getToken(secretDigest(secrets.access))).toBeNull();
      expect(await storage.getTokenByRefreshToken(secretDigest(secrets.refresh))).toBeNull();
      expect(await storage.getWebSession(secretDigest(secrets.session))).toBeNull();
      expect(await storage.consumeAuthCode(secretDigest(secrets.code))).toBeNull();
      expect(await storage.revokeToken(secretDigest(secrets.access))).toBe(false);
      expect(await storage.getToken(secrets.access)).not.toBeNull();
    });
    it("revokes by either token and saving a read record does not hash it twice", async () => {
      const { storage } = await open();
      await writeAll(storage);
      const record = (await storage.getTokenByRefreshToken(secrets.refresh))!;
      await storage.saveToken({ ...record, scope: "iot:view iot:control" });
      expect((await storage.getToken(secrets.access))?.scope).toBe("iot:view iot:control");
      expect(await storage.revokeToken(secrets.refresh)).toBe(true);
      expect(await storage.getToken(secrets.access)).toBeNull();
    });
    it("hashes rows written before hashing on startup and still finds rows an older pod writes later", async () => {
      const { rawInsert, reopen, dump } = await open();
      await rawInsert([
        `INSERT INTO oauth_tokens (access_token, refresh_token, client_id, user_id, yandex_access_token, scope, created_at, expires_at) VALUES ('old_at', 'old_rt', 'client', 'alice', '', 'iot:view', ${now}, ${now + 3600000})`,
        `INSERT INTO oauth_codes (code, client_id, redirect_uri, user_id, yandex_access_token, scope, created_at, expires_at) VALUES ('old_code', 'client', 'http://localhost/cb', 'alice', '', 'iot:view', ${now}, ${now + 60000})`,
      ]);
      const migrated = await reopen({ rehash: true });
      const contents = await dump();
      for (const value of ["old_at", "old_rt", "old_code"]) expect(contents, value).not.toContain(`'${value}'`);
      expect((await migrated.getToken("old_at"))?.userId).toBe("alice");
      expect((await migrated.getTokenByRefreshToken("old_rt"))?.userId).toBe("alice");
      expect((await migrated.consumeAuthCode("old_code"))?.userId).toBe("alice");
      await rawInsert([`INSERT INTO oauth_tokens (access_token, client_id, user_id, yandex_access_token, scope, created_at, expires_at) VALUES ('late_at', 'client', 'alice', '', 'iot:view', ${now}, ${now + 3600000})`]);
      expect((await migrated.getToken("late_at"))?.userId).toBe("alice");
      expect(await migrated.revokeToken("late_at")).toBe(true);
    });
  });
}

describe("bearer secrets at rest", () => {
  const dirs: string[] = [];
  const stores: OAuthStorage[] = [];
  afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const sqliteDump = (path: string) => async () => {
    const db = new DatabaseSync(path);
    try {
      return ["oauth_tokens", "oauth_codes", "web_sessions", "browser_transactions"]
        .map(t => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()).replaceAll('"', "'")).join("\n");
    } finally { db.close(); }
  };
  contract("SQLite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alice-secrets-")); dirs.push(dir);
    const path = join(dir, "oauth.db");
    const storage = new OAuthStorage(path); stores.push(storage);
    return {
      storage, dump: sqliteDump(path),
      rawInsert: async sql => { const db = new DatabaseSync(path); try { for (const q of sql) db.exec(q); } finally { db.close(); } },
      reopen: async () => { const s = new OAuthStorage(path); stores.push(s); return s; },
    };
  });

  const connectionString = process.env.TEST_POSTGRES_URL;
  describe.skipIf(!connectionString)("PostgreSQL", () => {
    let admin: pg.Pool;
    const pools: pg.Pool[] = [];
    const schemas: string[] = [];
    beforeAll(() => { admin = new pg.Pool({ connectionString }); });
    afterAll(async () => {
      for (const p of pools) await p.end().catch(() => {});
      for (const s of schemas) await admin.query(`DROP SCHEMA ${s} CASCADE`);
      await admin.end();
    });
    contract("backend", async () => {
      const schema = "alice_secrets_" + randomUUID().replaceAll("-", ""); schemas.push(schema);
      await admin.query(`CREATE SCHEMA ${schema}`);
      const options = { connectionString, options: `-c search_path=${schema}` };
      const make = async ({ rehash = false } = {}) => { const pool = new pg.Pool(options); pools.push(pool); const s = new PostgresStorage({ pool, rehashStoredSecrets: rehash }); await s.ready(); return s; };
      const storage = await make();
      const query = new pg.Pool(options); pools.push(query);
      return {
        storage,
        dump: async () => (await Promise.all(["oauth_tokens", "oauth_codes", "web_sessions", "browser_transactions"]
          .map(async t => JSON.stringify((await query.query(`SELECT * FROM ${t}`)).rows).replaceAll('"', "'")))).join("\n"),
        rawInsert: async sql => { for (const q of sql) await query.query(q); },
        reopen: make,
      };
    });
    it("leaves rows an older pod can read untouched until rehashing is enabled", async () => {
      vi.stubEnv("REHASH_STORED_SECRETS", "");
      const schema = "alice_secrets_" + randomUUID().replaceAll("-", ""); schemas.push(schema);
      await admin.query(`CREATE SCHEMA ${schema}`);
      const options = { connectionString, options: `-c search_path=${schema}` };
      const pool = new pg.Pool(options); pools.push(pool);
      await new PostgresStorage({ pool }).ready();
      await pool.query(`INSERT INTO web_sessions (session_hash, user_id, created_at, expires_at) VALUES ('old_session', 'alice', ${now}, ${now + 60000})`);
      await new PostgresStorage({ pool }).ready();
      // An older pod looks rows up by the raw value.
      expect((await pool.query("SELECT user_id FROM web_sessions WHERE session_hash = 'old_session'")).rowCount).toBe(1);
      await new PostgresStorage({ pool, rehashStoredSecrets: true }).ready();
      expect((await pool.query("SELECT user_id FROM web_sessions WHERE session_hash = 'old_session'")).rowCount).toBe(0);
      vi.unstubAllEnvs();
    });

    it("rehashing survives a secret stored both raw and hashed", async () => {
      const schema = "alice_secrets_" + randomUUID().replaceAll("-", ""); schemas.push(schema);
      await admin.query(`CREATE SCHEMA ${schema}`);
      const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` }); pools.push(pool);
      const storage = new PostgresStorage({ pool, rehashStoredSecrets: false });
      await storage.saveWebSession("dup_session", "alice", now + 60000);
      await pool.query(`INSERT INTO web_sessions (session_hash, user_id, created_at, expires_at) VALUES ('dup_session', 'alice', ${now}, ${now + 60000})`);
      await new PostgresStorage({ pool, rehashStoredSecrets: true }).ready();
      expect((await pool.query("SELECT session_hash FROM web_sessions")).rows).toEqual([{ session_hash: expect.stringMatching(/^sha256:/) }]);
    });
  });
});
