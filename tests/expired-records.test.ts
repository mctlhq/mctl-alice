import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHttpServer } from "../src/server/http-server.js";
import { ExpiredRecordPruner } from "../src/services/expired-records.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";

const DAY = 24 * 60 * 60 * 1000;

function count(storage: OAuthStorage, table: string): number {
  const db = (storage as unknown as { db: DatabaseSync }).db;
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function saveToken(storage: OAuthStorage, name: string, expiresAt: number) {
  storage.saveToken({
    accessToken: `at-${name}`, refreshToken: `rt-${name}`, clientId: "c", userId: "u",
    yandexAccessToken: "y", scope: "iot:view", createdAt: expiresAt - DAY, expiresAt,
  });
}

describe("pruneExpired", () => {
  it("removes expired tokens and keeps live ones", () => {
    const storage = new OAuthStorage(":memory:");
    const now = Date.now();
    saveToken(storage, "live", now + DAY);
    saveToken(storage, "dead", now - 1000);

    storage.pruneExpired();

    expect(storage.getTokenByRefreshToken("rt-live")).toBeTruthy();
    expect(count(storage, "oauth_tokens")).toBe(1);
    storage.close();
  });

  it("removes expired sessions at once and leaves live ones", () => {
    const storage = new OAuthStorage(":memory:");
    const now = Date.now();
    storage.saveUser({ id: "u", yandexUid: "u", createdAt: now, updatedAt: now });
    storage.saveWebSession("old", "u", now - 1000);
    storage.saveWebSession("new", "u", now + DAY);

    storage.pruneExpired();

    expect(count(storage, "web_sessions")).toBe(1);
    expect(storage.getWebSession("new")).toBeTruthy();
    storage.close();
  });

  it("removes expired spent secrets, codes and pending records, and keeps live ones", () => {
    const storage = new OAuthStorage(":memory:");
    const db = (storage as unknown as { db: DatabaseSync }).db;
    const now = Date.now();
    for (const [name, expiresAt] of [["old", now - 1000], ["new", now + DAY]] as const) {
      storage.recordSpentSecret(`s-${name}`, { kind: "refresh", grantId: "g", clientId: "c", userId: "u", spentAt: now, expiresAt });
      db.prepare("INSERT INTO browser_transactions (key, payload, expires_at) VALUES (?, ?, ?)").run(`b-${name}`, "{}", expiresAt);
      for (const table of ["oauth_codes", "oauth_pending"]) {
        const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; pk: number }>);
        const row = columns.map((c) => (c.name === "expires_at" ? expiresAt : c.pk ? `${table}-${name}` : c.notnull ? "x" : null));
        db.prepare(`INSERT INTO ${table} (${columns.map((c) => c.name).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...row);
      }
    }

    storage.pruneExpired();

    for (const table of ["oauth_spent_secrets", "browser_transactions", "oauth_codes", "oauth_pending"]) {
      expect(count(storage, table), table).toBe(1);
    }
    storage.close();
  });
});

describe("ExpiredRecordPruner", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs a failed pass and runs again on the next one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pruneExpired = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(undefined);
    const pruner = new ExpiredRecordPruner({ pruneExpired });

    await pruner.runOnce();
    await pruner.runOnce();

    expect(error).toHaveBeenCalledWith(expect.stringContaining("db down"));
    expect(pruneExpired).toHaveBeenCalledTimes(2);
  });

  it("is wired into the server", async () => {
    const storage = new OAuthStorage(":memory:");
    saveToken(storage, "dead", Date.now() - 1000);
    const server: http.Server = createHttpServer(0, {
      publicBaseUrl: "http://localhost", authRequired: false, oauthStorage: storage,
      retention: false, expiredRecordPruning: { initialDelayMs: 1, intervalMs: 60000 },
    });
    try {
      await vi.waitFor(() => expect(count(storage, "oauth_tokens")).toBe(0), { timeout: 2000 });
    } finally {
      server.close();
      storage.close();
    }
  });
});
