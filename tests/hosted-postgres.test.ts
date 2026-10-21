import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { PostgresStorage, PostgresTelemetryStorage } from "../src/storage/postgres-storage.js";
import { TelemetryStorage, ITelemetryStorage } from "../src/storage/telemetry-storage.js";
import { authenticateRequest } from "../src/server/http-server.js";
import http from "node:http";

// A dedicated disposable database only; never use DATABASE_URL from the application.
const connectionString = process.env.TEST_POSTGRES_URL;
describe.skipIf(!connectionString)("hosted isolation with real PostgreSQL", () => {
  let storage: PostgresStorage;
  let history: PostgresTelemetryStorage;
  let pool: pg.Pool;
  let admin: pg.Pool;
  const schema = "alice_test_" + randomUUID().replaceAll("-", "");
  const poolOptions = { connectionString, options: `-c search_path=${schema}` };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool(poolOptions);
    storage = new PostgresStorage({ pool: new pg.Pool(poolOptions) }); history = new PostgresTelemetryStorage({ pool: new pg.Pool(poolOptions) });
    await storage.ready(); await history.ready();
  });
  afterAll(async () => { await storage.close(); await history.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  it("validates owners, grants, decryption failures, disconnect and revocation", async () => {
    for (const id of ["alice", "bob"]) {
      await storage.saveUser({ id, yandexUid: id, createdAt: Date.now(), updatedAt: Date.now() });
      await storage.saveUserCredentials(id, { yandexAccessToken: id, quasarCookie: `Session_id=${id}` });
      await storage.saveToken({ accessToken: id, refreshToken: `rt-${id}`, userId: id, clientId: "client", yandexAccessToken: "stale", scope: "iot:view quasar", createdAt: Date.now(), expiresAt: Date.now() + 3600000 });
    }
    const auth = (token: string) => authenticateRequest({ headers: { authorization: `Bearer ${token}` } } as http.IncomingMessage, undefined, undefined, storage, history, true);
    expect(await auth("alice")).toMatchObject({ authenticated: true, userId: "alice" });
    expect(await auth("random")).toMatchObject({ authenticated: false, status: 401 });
    await storage.saveUserCredentials("alice", { yandexAccessToken: "alice", quasarCookie: undefined });
    expect((await storage.getUserCredentials("alice"))?.quasarCookie).toBeUndefined();
    await pool.query("UPDATE user_credentials SET encrypted_yandex_access_token = 'corrupt' WHERE user_id = 'alice'");
    expect(await auth("alice")).toMatchObject({ authenticated: false, status: 503 });
    expect(await auth("bob")).toMatchObject({ authenticated: true, userId: "bob" });
    await storage.revokeUserGrant("bob", "client");
    expect(await auth("bob")).toMatchObject({ authenticated: false, status: 401 });
    expect(await storage.getTokenByRefreshToken("rt-bob")).toBeNull();
  });
  it("rejects expired, unowned, missing-owner and empty-scope grants without upstream calls", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      for (const [index, change] of [
        { expiresAt: Date.now() - 1 }, { userId: undefined }, { userId: "missing-owner" },
        { userId: "legacy_user" }, { userId: "usr_local" }, { scope: "" }, { scope: "*" },
      ].entries()) {
        const accessToken = `negative-${index}`;
        await storage.saveToken({ accessToken, clientId: "client", userId: "bob", yandexAccessToken: "stale", scope: "iot:view", createdAt: Date.now(), expiresAt: Date.now() + 60000, ...change });
        const result = await authenticateRequest({ headers: { authorization: `Bearer ${accessToken}` } } as http.IncomingMessage, undefined, undefined, storage, history, true);
        expect(result).toMatchObject({ authenticated: false, status: 401 });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });
  it("returns storage unavailable for a real SQL failure", async () => {
    await pool.query("ALTER TABLE oauth_tokens RENAME TO unavailable_tokens");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const result = await authenticateRequest({ headers: { authorization: "Bearer bob" } } as http.IncomingMessage, undefined, undefined, storage, history, true);
      expect(result).toMatchObject({ authenticated: false, status: 503 }); expect(fetchMock).not.toHaveBeenCalled();
    } finally { await pool.query("ALTER TABLE unavailable_tokens RENAME TO oauth_tokens"); fetchMock.mockRestore(); }
  });
  it("migrates and isolates all history resolutions, stats and pruning", async () => {
    await verifyHistory(history);
    const second = new PostgresTelemetryStorage({ pool: new pg.Pool(poolOptions) }); await second.ready(); await second.close();
    expect((await history.getStats()).totalSamples).toBe(2);
  });
});

async function verifyHistory(history: ITelemetryStorage) {
  const alice = history.forUser("alice"), bob = history.forUser("bob");
  for (const [store, value] of [[history, 900], [alice, 10], [bob, 20]] as const) {
    await store.saveSamples([0, 60000].map(timestamp => ({ deviceId: "same", deviceName: "same", metric: "power", value, timestamp })));
  }
  for (const resolution of ["max", "1m", "5m", "15m", "1h"] as const) {
    for (const metric of ["power", "all"]) {
      for (const [store, value] of [[history, 900], [alice, 10], [bob, 20]] as const) {
        const result = await store.queryHistory({ deviceId: "same", metric, from: 0, to: 100000, resolution });
        expect(result.points.length).toBeGreaterThan(0); expect(result.points.every(p => p.value === value)).toBe(true);
      }
    }
  }
  expect((await alice.getStats()).totalSamples).toBe(2);
  expect(await alice.pruneOld(1)).toBe(2);
  expect((await bob.getStats()).totalSamples).toBe(2); expect((await history.getStats()).totalSamples).toBe(2);
}
describe("SQLite history ownership", () => {
  it("isolates historical legacy rows, writes, aggregates, stats and pruning", async () => {
    const history = new TelemetryStorage(":memory:"); try { await verifyHistory(history); } finally { history.close(); }
  });
});
