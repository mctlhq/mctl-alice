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
  it("revokes both access and refresh tokens only for the selected user/client", async () => {
    for (const [userId, clientId] of [["erin", "one"], ["erin", "two"], ["frank", "one"]]) {
      const key = `${userId}-${clientId}`;
      await storage.saveToken({ accessToken: key, refreshToken: `rt-${key}`, userId, clientId, scope: "iot:view", yandexAccessToken: "user-token", createdAt: Date.now(), expiresAt: Date.now() + 60000 });
    }
    expect(await storage.listUserGrants("erin")).toHaveLength(2);
    expect(await storage.revokeUserGrant("erin", "one")).toBe(true);
    expect(await storage.getToken("erin-one")).toBeNull();
    expect(await storage.getTokenByRefreshToken("rt-erin-one")).toBeNull();
    expect(await storage.getToken("erin-two")).not.toBeNull();
    expect(await storage.getToken("frank-one")).not.toBeNull();
  });
  it("deleteUser removes every owner-keyed row and leaves other users intact", async () => {
    const t = Date.now();
    for (const id of ["carol", "dave"]) {
      await storage.saveUser({ id, yandexUid: id, createdAt: t, updatedAt: t });
      await storage.saveUserCredentials(id, { yandexAccessToken: id });
      await storage.saveToken({ accessToken: `at-${id}`, refreshToken: `rt2-${id}`, userId: id, clientId: "client", yandexAccessToken: "x", scope: "iot:view", createdAt: t, expiresAt: t + 3600000 });
      await storage.saveAuthCode({ code: `code-${id}`, clientId: "client", redirectUri: "http://localhost/cb", userId: id, yandexAccessToken: "x", scope: "iot:view", createdAt: t, expiresAt: t + 60000 });
      await storage.savePendingAuth({ state: `state-${id}`, clientId: "client", redirectUri: "http://localhost/cb", clientState: "s", scope: "iot:view", userId: id, createdAt: t, expiresAt: t + 60000 });
      await storage.saveWebSession(`session-${id}`, id, t + 60000);
      await storage.saveQuasarScenario(id, "speaker", `scn-${id}`);
      await history.forUser(id).saveSamples([{ deviceId: "d", deviceName: "d", metric: "power", value: 1, timestamp: t }]);
    }
    await history.forUser("carol").deleteOwnerSamples();
    await storage.deleteUser("carol");
    const tables = ["users", "user_credentials", "oauth_tokens", "oauth_codes", "oauth_pending", "web_sessions", "quasar_proxy_scenarios", "telemetry_samples"];
    for (const table of tables) {
      const column = table === "users" ? "id" : "user_id";
      const count = async (id: string) => Number((await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = $1`, [id])).rows[0].n);
      expect(await count("carol"), table).toBe(0);
      expect(await count("dave"), table).toBeGreaterThan(0);
    }
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
  it("shares encrypted expiring browser transactions between storage instances", async () => {
    const second = new PostgresStorage({ pool: new pg.Pool(poolOptions) });
    try {
      await storage.saveBrowserTransaction("login:pending", "browser-secret", Date.now() + 60000);
      expect(await second.getBrowserTransaction("login:pending")).toBe("browser-secret");
      const row = await pool.query("SELECT payload FROM browser_transactions WHERE key='login:pending'");
      expect(row.rows[0].payload).not.toContain("browser-secret");
      await second.deleteBrowserTransaction("login:pending");
      expect(await storage.getBrowserTransaction("login:pending")).toBeNull();
      await storage.saveBrowserTransaction("qr:expired", "secret", Date.now() - 1);
      expect(await second.getBrowserTransaction("qr:expired")).toBeNull();
    } finally { await second.close(); }
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
