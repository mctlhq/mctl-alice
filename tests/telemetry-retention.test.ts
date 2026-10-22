import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { TelemetryStorage, ITelemetryStorage, TelemetrySample } from "../src/storage/telemetry-storage.js";
import { PostgresTelemetryStorage } from "../src/storage/postgres-storage.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { TelemetryRetention, retentionDaysFromEnv } from "../src/services/telemetry-retention.js";
import { StationService, HOSTED_HISTORY_UNAVAILABLE } from "../src/services/station-service.js";
import { handleToolCall } from "../src/tools/handlers.js";
import { createHttpServer } from "../src/server/http-server.js";

const DAY = 24 * 60 * 60 * 1000;
const OWNERS = [null, "alice", "bob"] as const;

function sample(timestamp: number, value: number): TelemetrySample {
  return { deviceId: "socket-1", deviceName: "Розетка", metric: "power", value, unit: "unit.watt", timestamp };
}

/** Five old and one recent sample per owner (the unbound local owner, alice, bob). */
async function seed(storage: ITelemetryStorage) {
  const now = Date.now();
  for (const owner of OWNERS) {
    const view = owner ? storage.forUser(owner) : storage;
    await view.saveSamples([
      ...[40, 39, 35, 32, 31].map((days, i) => sample(now - days * DAY, i)),
      sample(now - 2 * DAY, 99),
    ]);
  }
}

async function remaining(storage: ITelemetryStorage) {
  const counts: Record<string, number> = {};
  for (const owner of OWNERS) {
    const view = owner ? storage.forUser(owner) : storage;
    counts[owner ?? "local"] = (await view.getStats()).totalSamples;
  }
  return counts;
}

const quiet = () => { vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); };

describe("TelemetryRetention on SQLite", () => {
  let storage: TelemetryStorage | undefined;
  afterEach(() => { vi.restoreAllMocks(); storage?.close(); storage = undefined; });

  it("deletes old samples of every owner in batches until done and keeps recent ones", async () => {
    quiet();
    storage = new TelemetryStorage(":memory:");
    await seed(storage);
    const retention = new TelemetryRetention(storage, { retentionDays: 30, batchSize: 4, batchPauseMs: 0 });
    const result = await retention.runOnce();
    // 15 old rows in batches of 4: 4, 4, 4, 3.
    expect(result).toMatchObject({ deleted: 15, batches: 4 });
    expect(await remaining(storage)).toEqual({ local: 1, alice: 1, bob: 1 });
    expect(storage.forUser("alice").queryHistory({ deviceId: "socket-1", from: 0, to: Date.now() }).points.map(p => p.value)).toEqual([99]);
    // Idempotent: a second pass finds nothing.
    expect(await retention.runOnce()).toMatchObject({ deleted: 0, batches: 1 });
  });

  it("logs one summary line per run and nothing per row", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    storage = new TelemetryStorage(":memory:");
    await seed(storage);
    await new TelemetryRetention(storage, { retentionDays: 30, batchSize: 2, batchPauseMs: 0 }).runOnce();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/Deleted 15 samples older than 30 days in 8 batches \(\d+ ms\)/);
  });

  it("refuses to prune through an owner-bound view", () => {
    storage = new TelemetryStorage(":memory:");
    expect(() => storage.forUser("alice").pruneBatch(Date.now(), 10)).toThrow(/unbound store/);
  });

  it("reads TELEMETRY_RETENTION_DAYS and keeps 30 days for invalid values", () => {
    quiet();
    expect(retentionDaysFromEnv(undefined)).toBe(30);
    expect(retentionDaysFromEnv("7")).toBe(7);
    for (const bad of ["0", "-1", "abc", "1.5"]) expect(retentionDaysFromEnv(bad)).toBe(30);
  });

  it("stop() during the pause runs no further batch and logs no failure", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    // Full batches forever; a batch after stop() hits a closed store, as on shutdown.
    const store = { pruneBatch: vi.fn(() => { if (calls++ > 0) throw new Error("database is not open"); return 4; }) } as unknown as ITelemetryStorage;
    const retention = new TelemetryRetention(store, { retentionDays: 30, batchSize: 4, batchPauseMs: 100 });
    const run = retention.runOnce();
    setTimeout(() => retention.stop(), 20);
    await expect(run).resolves.toMatchObject({ deleted: 4, batches: 1 });
    expect(store.pruneBatch).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("a server built under the test runner does not start retention unless asked", async () => {
    const start = vi.spyOn(TelemetryRetention.prototype, "start");
    storage = new TelemetryStorage(":memory:");
    const oauth = new OAuthStorage(":memory:");
    for (const authRequired of [false, true]) {
      const server = createHttpServer(0, { publicBaseUrl: "http://localhost", authRequired, oauthStorage: oauth, storage, enableSampler: false });
      server.emit("close");
    }
    expect(start).not.toHaveBeenCalled();
    const server = createHttpServer(0, { publicBaseUrl: "http://localhost", authRequired: true, oauthStorage: oauth, storage, retention: { initialDelayMs: 60_000 } });
    expect(start).toHaveBeenCalledTimes(1);
    server.emit("close");
    oauth.close();
  });

  it("runs in hosted mode (AUTH_REQUIRED), where the sampler is off", async () => {
    quiet();
    storage = new TelemetryStorage(":memory:");
    await seed(storage);
    const oauth = new OAuthStorage(":memory:");
    const server: http.Server = createHttpServer(0, {
      publicBaseUrl: "http://localhost", authRequired: true, oauthStorage: oauth, storage,
      retention: { retentionDays: 30, initialDelayMs: 0, batchSize: 4, batchPauseMs: 0 },
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      await vi.waitFor(async () => expect(await remaining(storage)).toEqual({ local: 1, alice: 1, bob: 1 }), { timeout: 2000 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      oauth.close();
    }
  });
});

describe("alice_get_device_history in hosted mode", () => {
  it("says that history is not recorded instead of returning stored rows", async () => {
    const storage = new TelemetryStorage(":memory:");
    storage.forUser("alice").saveSamples([sample(Date.now() - DAY, 5)]);
    const service = new StationService(undefined, undefined, storage.forUser("alice"), "hosted");
    await expect(service.getDeviceHistory({ device: "socket-1" })).rejects.toThrow(HOSTED_HISTORY_UNAVAILABLE);
    const result = await handleToolCall("alice_get_device_history", { device: "socket-1" }, service, "iot:view");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not recorded in the hosted service");
    storage.close();
  });
});

// A dedicated disposable database only; never use DATABASE_URL from the application.
const connectionString = process.env.TEST_POSTGRES_URL;
describe.skipIf(!connectionString)("TelemetryRetention on PostgreSQL", () => {
  const schema = "alice_test_" + randomUUID().replaceAll("-", "");
  const poolOptions = { connectionString, options: `-c search_path=${schema}` };
  let admin: pg.Pool;
  const stores: PostgresTelemetryStorage[] = [];
  async function store() {
    const s = new PostgresTelemetryStorage({ pool: new pg.Pool(poolOptions) });
    await s.ready();
    stores.push(s);
    return s;
  }
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of stores.splice(0)) await s.close();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("deletes old samples of every owner in batches and keeps recent ones", async () => {
    quiet();
    admin = new pg.Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const storage = await store();
    await seed(storage);
    const result = await new TelemetryRetention(storage, { retentionDays: 30, batchSize: 4, batchPauseMs: 0 }).runOnce();
    expect(result).toMatchObject({ deleted: 15, batches: 4 });
    expect(await remaining(storage)).toEqual({ local: 1, alice: 1, bob: 1 });
  });

  it("refuses to prune through an owner-bound view", async () => {
    admin = new pg.Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const storage = await store();
    await expect(storage.forUser("alice").pruneBatch(Date.now(), 10)).rejects.toThrow(/unbound store/);
  });

  it("skips rows another transaction holds locked instead of waiting for them", async () => {
    quiet();
    admin = new pg.Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const storage = await store();
    await seed(storage);
    const cutoff = Date.now() - 30 * DAY;
    const holderPool = new pg.Pool({ ...poolOptions, max: 1 });
    const holder = await holderPool.connect();
    try {
      await holder.query("BEGIN");
      const locked = await holder.query("SELECT id FROM telemetry_samples WHERE timestamp < $1 ORDER BY id LIMIT 3 FOR UPDATE", [cutoff]);
      expect(locked.rowCount).toBe(3);
      const deleted = await Promise.race([
        storage.pruneBatch(cutoff, 5),
        new Promise((_, reject) => setTimeout(() => reject(new Error("pruneBatch blocked on locked rows")), 2000)),
      ]);
      // A full batch from the 12 unlocked old rows, without waiting for the lock.
      expect(deleted).toBe(5);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await holderPool.end();
    }
  });

  it("two overlapping instances (rolling update) delete each row once and finish cleanly", async () => {
    quiet();
    admin = new pg.Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const first = await store();
    const second = await store();
    for (let i = 0; i < 20; i++) await seed(first);
    const options = { retentionDays: 30, batchSize: 7, batchPauseMs: 1 };
    const results = await Promise.all([
      new TelemetryRetention(first, options).runOnce(),
      new TelemetryRetention(second, options).runOnce(),
    ]);
    expect(await remaining(first)).toEqual({ local: 20, alice: 20, bob: 20 });
    expect(results.reduce((sum, r) => sum + (r?.deleted ?? 0), 0)).toBe(300);
  });
});
