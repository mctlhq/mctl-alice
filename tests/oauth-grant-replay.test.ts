import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthController, REFRESH_REUSE_GRACE_MS } from "../src/auth/oauth-controller.js";
import { createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { PostgresStorage } from "../src/storage/postgres-storage.js";
import { IStorage } from "../src/storage/storage-interface.js";

const baseUrl = "https://alice.mctl.ai";
const redirectUri = "https://client.example/cb";
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const realFetch = globalThis.fetch;

// Every method returns a Promise, like the production PostgreSQL backend, so
// concurrent requests really interleave between storage calls.
function asynchronous(storage: OAuthStorage): IStorage {
  return new Proxy(storage, { get(target, prop) {
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? async (...args: unknown[]) => value.apply(target, args) : value;
  } });
}

interface Backend {
  storage: IStorage;
  /** Runs a read-only query written with $n placeholders. */
  rows(sql: string, params: unknown[]): Promise<any[]>;
  close(): Promise<void>;
}

function sqliteBackend(): Promise<Backend> {
  const db = new OAuthStorage(":memory:");
  return Promise.resolve({
    storage: asynchronous(db),
    rows: async (sql, params) => (db as any).db.prepare(sql.replace(/\$\d+/g, "?")).all(...params),
    close: async () => db.close(),
  });
}

// A dedicated disposable database only; never use DATABASE_URL from the application.
const postgresUrl = process.env.TEST_POSTGRES_URL;
async function postgresBackend(): Promise<Backend> {
  const schema = "alice_replay_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Pool({ connectionString: postgresUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: postgresUrl, options: `-c search_path=${schema}` });
  const storage = new PostgresStorage({ pool });
  await storage.ready();
  return {
    storage,
    rows: async (sql, params) => (await pool.query(sql, params)).rows,
    close: async () => { await storage.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); },
  };
}

const backends: Array<[string, () => Promise<Backend>]> = [["SQLite", sqliteBackend]];
if (postgresUrl) backends.push(["PostgreSQL", postgresBackend]);

describe.each(backends)("hosted grant replay and rotation (%s)", (_name, makeBackend) => {
  let backend: Backend;
  let storage: IStorage;
  let controller: OAuthController;

  beforeEach(async () => {
    backend = await makeBackend();
    storage = backend.storage;
    controller = new OAuthController({ baseUrl, yandexClientId: "app", storage, authRequired: true });
    await storage.saveUser({ id: "alice", yandexUid: "alice", createdAt: Date.now(), updatedAt: Date.now() });
    await storage.saveUserCredentials("alice", { yandexAccessToken: "upstream-alice", yandexRefreshToken: "upstream-refresh" });
    await storage.saveClient({ clientId: "web", clientSecret: "", clientName: "Web", redirectUris: [redirectUri], createdAt: Date.now() });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await backend.close();
  });

  async function issueCode(): Promise<string> {
    const consent = await controller.handleAuthorize({ client_id: "web", redirect_uri: redirectUri, userId: "alice", scope: "iot:view", code_challenge: challenge, code_challenge_method: "S256" });
    if (!("sessionId" in consent)) throw new Error("Expected consent");
    const { redirectUrl } = await controller.approveAuthorization(consent.sessionId, "alice");
    return new URL(redirectUrl).searchParams.get("code")!;
  }
  const exchange = (code: string) => controller.handleToken({ grant_type: "authorization_code", client_id: "web", redirect_uri: redirectUri, code, code_verifier: verifier });
  const refresh = (refreshToken: string) => controller.handleToken({ grant_type: "refresh_token", client_id: "web", refresh_token: refreshToken });
  const liveTokens = async () => Number((await backend.rows("SELECT COUNT(*) AS n FROM oauth_tokens WHERE user_id = $1", ["alice"]))[0].n);
  // Moves the clock seen by the controller and the storage.
  const advance = (ms: number) => { const now = Date.now() + ms; vi.spyOn(Date, "now").mockReturnValue(now); };

  describe("authorization code", () => {
    it("is single use: a second exchange of the same code fails", async () => {
      const code = await issueCode();
      const first = await exchange(code);
      expect(await storage.getToken(first.access_token)).toMatchObject({ userId: "alice", clientId: "web" });
      await expect(exchange(code)).rejects.toThrow("Invalid or expired authorization code");
    });

    it("a replayed code revokes the tokens it issued, including their rotated successors", async () => {
      const code = await issueCode();
      const first = await exchange(code);
      const rotated = await refresh(first.refresh_token!);
      await expect(exchange(code)).rejects.toThrow("Invalid or expired authorization code");
      expect(await storage.getToken(rotated.access_token)).toBeNull();
      expect(await storage.getTokenByRefreshToken(rotated.refresh_token!)).toBeNull();
      expect(await liveTokens()).toBe(0);
    });

    it("a replayed code leaves other grants of the same user and client alone", async () => {
      const code = await issueCode();
      await exchange(code);
      const other = await exchange(await issueCode());
      await expect(exchange(code)).rejects.toThrow();
      expect(await storage.getToken(other.access_token)).toMatchObject({ userId: "alice", clientId: "web" });
      expect(await liveTokens()).toBe(1);
    });

    it("two simultaneous exchanges of one code leave no live tokens", async () => {
      const code = await issueCode();
      const results = await Promise.allSettled([exchange(code), exchange(code)]);
      expect(results.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(1);
      expect(await liveTokens()).toBe(0);
    });

    it("a redeemed code presented for another client does not revoke the grant", async () => {
      await storage.saveClient({ clientId: "other", clientSecret: "", clientName: "Other", redirectUris: [redirectUri], createdAt: Date.now() });
      const code = await issueCode();
      const first = await exchange(code);
      await expect(controller.handleToken({ grant_type: "authorization_code", client_id: "other", redirect_uri: redirectUri, code, code_verifier: verifier }))
        .rejects.toThrow("Invalid or expired authorization code");
      expect(await storage.getToken(first.access_token)).toMatchObject({ userId: "alice" });
    });

    it("a code replayed for another client while its first exchange is still saving does not revoke it", async () => {
      await storage.saveClient({ clientId: "other", clientSecret: "", clientName: "Other", redirectUris: [redirectUri], createdAt: Date.now() });
      const code = await issueCode();
      const save = storage.saveToken.bind(storage);
      vi.spyOn(storage, "saveToken").mockImplementationOnce(async (token) => {
        await expect(controller.handleToken({ grant_type: "authorization_code", client_id: "other", redirect_uri: redirectUri, code, code_verifier: verifier }))
          .rejects.toThrow("Invalid or expired authorization code");
        return save(token);
      });
      const first = await exchange(code);
      expect(await storage.getToken(first.access_token)).toMatchObject({ userId: "alice", clientId: "web" });
    });

    it("without auth, a replay that omits client_id still revokes the grant", async () => {
      const local = new OAuthController({ baseUrl, yandexClientId: "app", storage, authRequired: false });
      const code = await issueCode();
      const first = await exchange(code);
      await expect(local.handleToken({ grant_type: "authorization_code", code, code_verifier: verifier })).rejects.toThrow("Invalid or expired authorization code");
      expect(await storage.getToken(first.access_token)).toBeNull();
    });

    it("a code replayed while its first exchange is still saving revokes the new tokens", async () => {
      const code = await issueCode();
      const save = storage.saveToken.bind(storage);
      vi.spyOn(storage, "saveToken").mockImplementationOnce(async (token) => {
        await expect(exchange(code)).rejects.toThrow("Invalid or expired authorization code");
        return save(token);
      });
      await expect(exchange(code)).rejects.toThrow("Authorization code was reused");
      expect(await liveTokens()).toBe(0);
    });

    it("remembers a redeemed code and a rotated refresh token only as digests", async () => {
      const code = await issueCode();
      const first = await exchange(code);
      await refresh(first.refresh_token!);
      const rows = await backend.rows("SELECT secret, kind FROM oauth_spent_secrets ORDER BY kind", []) as Array<{ secret: string; kind: string }>;
      expect(rows.map((r) => r.kind)).toEqual(["code", "refresh"]);
      for (const row of rows) expect(row.secret).toMatch(/^sha256:/);
      expect(rows[0].secret).not.toContain(code);
      expect(rows[1].secret).not.toContain(first.refresh_token!);
    });

    it("an unknown code revokes nothing", async () => {
      const first = await exchange(await issueCode());
      await expect(exchange("code_never_issued")).rejects.toThrow();
      expect(await storage.getToken(first.access_token)).not.toBeNull();
    });
  });

  describe("refresh token", () => {
    it("rotates on use: the old refresh and access tokens stop working", async () => {
      const first = await exchange(await issueCode());
      const second = await refresh(first.refresh_token!);
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect(second.access_token).not.toBe(first.access_token);
      expect(await storage.getToken(first.access_token)).toBeNull();
      expect(await storage.getTokenByRefreshToken(first.refresh_token!)).toBeNull();
      expect(await storage.getToken(second.access_token)).toMatchObject({ userId: "alice" });
    });

    it("a rotated refresh token cannot be replayed", async () => {
      const first = await exchange(await issueCode());
      await refresh(first.refresh_token!);
      await expect(refresh(first.refresh_token!)).rejects.toThrow("Invalid refresh_token");
    });

    it("reuse of a rotated refresh token after the grace window revokes the whole family", async () => {
      const first = await exchange(await issueCode());
      const second = await refresh(first.refresh_token!);
      const third = await refresh(second.refresh_token!);
      const other = await exchange(await issueCode());
      advance(REFRESH_REUSE_GRACE_MS + 1);
      await expect(refresh(first.refresh_token!)).rejects.toThrow("Invalid refresh_token");
      expect(await storage.getToken(third.access_token)).toBeNull();
      expect(await storage.getTokenByRefreshToken(third.refresh_token!)).toBeNull();
      // Another grant of the same user and client is a different family.
      expect(await storage.getToken(other.access_token)).toMatchObject({ userId: "alice" });
    });

    it("reuse within the grace window is refused but keeps the current pair", async () => {
      const first = await exchange(await issueCode());
      const second = await refresh(first.refresh_token!);
      advance(REFRESH_REUSE_GRACE_MS - 1000);
      await expect(refresh(first.refresh_token!)).rejects.toThrow("Invalid refresh_token");
      expect(await storage.getToken(second.access_token)).toMatchObject({ userId: "alice" });
      expect(await refresh(second.refresh_token!)).toMatchObject({ token_type: "Bearer" });
    });

    it("reuse of a token rotated moments before its own expiry still revokes the family", async () => {
      await storage.saveToken({ accessToken: "mctl_at_short", refreshToken: "mctl_rt_short", clientId: "web", userId: "alice", yandexAccessToken: "",
        scope: "iot:view", createdAt: Date.now(), expiresAt: Date.now() + 2000, grantId: randomUUID() });
      const rotated = await refresh("mctl_rt_short");
      advance(REFRESH_REUSE_GRACE_MS + 1);
      await expect(refresh("mctl_rt_short")).rejects.toThrow("Invalid refresh_token");
      expect(await storage.getToken(rotated.access_token)).toBeNull();
    });

    it("an expired refresh token cannot be rotated", async () => {
      await storage.saveToken({ accessToken: "mctl_at_expired", refreshToken: "mctl_rt_expired", clientId: "web", userId: "alice", yandexAccessToken: "",
        scope: "iot:view", createdAt: Date.now() - 7200000, expiresAt: Date.now() - 1000, grantId: randomUUID() });
      expect(await storage.getTokenByRefreshToken("mctl_rt_expired")).toBeNull();
      await expect(refresh("mctl_rt_expired")).rejects.toThrow("Invalid refresh_token");
    });

    it("an empty grant id is never a family", async () => {
      await storage.saveToken({ accessToken: "mctl_at_blank", refreshToken: "mctl_rt_blank", clientId: "web", userId: "alice", yandexAccessToken: "",
        scope: "iot:view", createdAt: Date.now(), expiresAt: Date.now() + 3600000, grantId: "" });
      expect((await storage.getToken("mctl_at_blank"))?.grantId).toBeUndefined();
      expect(await storage.revokeGrantFamily("")).toBe(false);
      expect(await storage.getToken("mctl_at_blank")).toMatchObject({ userId: "alice" });
    });

    it("a refresh that loses the rotation race revokes nothing", async () => {
      const first = await exchange(await issueCode());
      const stale = await storage.getTokenByRefreshToken(first.refresh_token!);
      const winner = await refresh(first.refresh_token!);
      // The loser looked the token up (and re-checked it) before the winner rotated it.
      vi.spyOn(storage, "getTokenByRefreshToken").mockResolvedValueOnce(stale).mockResolvedValueOnce(stale);
      advance(REFRESH_REUSE_GRACE_MS + 1);
      await expect(refresh(first.refresh_token!)).rejects.toThrow("Grant already revoked or rotated");
      expect(await storage.getToken(winner.access_token)).toMatchObject({ userId: "alice" });
    });

    it("a token issued before grant tracking joins a family on its first rotation", async () => {
      await storage.saveToken({ accessToken: "mctl_at_legacy", refreshToken: "mctl_rt_legacy", clientId: "web", userId: "alice", yandexAccessToken: "",
        scope: "iot:view", createdAt: Date.now(), expiresAt: Date.now() + 3600000 });
      const rotated = await refresh("mctl_rt_legacy");
      expect((await storage.getToken(rotated.access_token))?.grantId).toBeTruthy();
      advance(REFRESH_REUSE_GRACE_MS + 1);
      await expect(refresh("mctl_rt_legacy")).rejects.toThrow();
      expect(await storage.getToken(rotated.access_token)).toBeNull();
    });

    it("two simultaneous refreshes with one token: at most one succeeds and one pair survives", async () => {
      const first = await exchange(await issueCode());
      const results = await Promise.allSettled([refresh(first.refresh_token!), refresh(first.refresh_token!)]);
      const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof refresh>>> => r.status === "fulfilled");
      expect(won).toHaveLength(1);
      expect(await storage.getTokenByRefreshToken(first.refresh_token!)).toBeNull();
      expect(await storage.getToken(won[0].value.access_token)).toMatchObject({ userId: "alice" });
      expect(await storage.listUserGrants("alice")).toHaveLength(1);
      expect(await liveTokens()).toBe(1);
    });

    it("simultaneous refreshes that both reach Yandex still leave one winner and one upstream credential", async () => {
      const controllerWithYandex = new OAuthController({ baseUrl, yandexClientId: "app", yandexClientSecret: "secret", storage, authRequired: true });
      let issued = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (!String(input).startsWith("https://oauth.yandex.ru/")) throw new Error(`unexpected upstream call ${String(input)}`);
        const n = ++issued;
        await new Promise((resolve) => setTimeout(resolve, 10 * n));
        return Response.json({ access_token: `upstream-${n}`, refresh_token: `upstream-refresh-${n}`, expires_in: 3600 });
      });
      const first = await exchange(await issueCode());
      const call = () => controllerWithYandex.handleToken({ grant_type: "refresh_token", client_id: "web", refresh_token: first.refresh_token! });
      const results = await Promise.allSettled([call(), call()]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      // Either upstream refresh may land last under real database latency; what
      // matters is that the stored pair is one Yandex actually issued, intact.
      const creds = await storage.getUserCredentials("alice");
      expect(["upstream-1", "upstream-2"]).toContain(creds?.yandexAccessToken);
      expect(creds?.yandexRefreshToken).toBe(creds?.yandexAccessToken.replace("upstream-", "upstream-refresh-"));
      expect(await liveTokens()).toBe(1);
    });
  });

  describe("token endpoint", () => {
    let server: http.Server | undefined;
    afterEach(async () => {
      if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
      server = undefined;
    });

    it("answers code and refresh replays with 400 invalid_grant", async () => {
      // The server may find a Yandex client secret on this machine: answer its upstream refresh here.
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => String(input).startsWith("https://oauth.yandex.ru/")
        ? Response.json({ access_token: "upstream-new", refresh_token: "upstream-refresh-new", expires_in: 3600 })
        : realFetch(input, init));
      server = createHttpServer(0, { publicBaseUrl: baseUrl, authRequired: true, oauthStorage: storage, enableSampler: false });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth/token`;
      const post = (body: Record<string, string>) => realFetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });

      const code = await issueCode();
      const codeBody = { grant_type: "authorization_code", client_id: "web", redirect_uri: redirectUri, code, code_verifier: verifier };
      const first = await post(codeBody);
      expect(first.status).toBe(200);
      const replayedCode = await post(codeBody);
      expect(replayedCode.status).toBe(400);
      expect(await replayedCode.json()).toMatchObject({ error: "invalid_grant" });

      const fresh = await post({ ...codeBody, code: await issueCode() });
      const refreshBody = { grant_type: "refresh_token", client_id: "web", refresh_token: (await fresh.json() as { refresh_token: string }).refresh_token };
      expect((await post(refreshBody)).status).toBe(200);
      const replayedRefresh = await post(refreshBody);
      expect(replayedRefresh.status).toBe(400);
      expect(await replayedRefresh.json()).toMatchObject({ error: "invalid_grant" });
    });
  });
});

describe("schema migration for grant tracking", () => {
  const legacyTokens = `CREATE TABLE oauth_tokens (
    access_token VARCHAR(255) PRIMARY KEY, refresh_token VARCHAR(255) UNIQUE, client_id VARCHAR(255) NOT NULL, user_id VARCHAR(255),
    yandex_access_token TEXT NOT NULL, yandex_refresh_token TEXT, yandex_expires_at BIGINT, scope TEXT NOT NULL,
    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL)`;
  const legacyRow = `INSERT INTO oauth_tokens (access_token, refresh_token, client_id, user_id, yandex_access_token, scope, created_at, expires_at)
    VALUES ('old-at', 'old-rt', 'web', 'alice', '', 'iot:view', 1, 9999999999999)`;

  it("adds grant tracking to an existing SQLite database and keeps its tokens", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alice-grant-"));
    try {
      const file = path.join(dir, "oauth.db");
      const legacy = new DatabaseSync(file);
      legacy.exec(legacyTokens);
      legacy.exec(legacyRow);
      legacy.close();
      const storage = new OAuthStorage(file);
      expect(storage.getTokenByRefreshToken("old-rt")).toMatchObject({ clientId: "web", grantId: undefined });
      storage.saveToken({ accessToken: "at", refreshToken: "rt", clientId: "web", userId: "alice", yandexAccessToken: "", scope: "iot:view", createdAt: 1, expiresAt: Date.now() + 60000, grantId: "g1" });
      expect(storage.getToken("at")?.grantId).toBe("g1");
      expect(storage.revokeGrantFamily("g1")).toBe(true);
      expect(storage.getToken("at")).toBeNull();
      storage.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!postgresUrl)("adds grant tracking to an existing PostgreSQL schema and keeps its tokens", async () => {
    const schema = "alice_migrate_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString: postgresUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path = ${schema}; ${legacyTokens}; ${legacyRow}`);
    const storage = new PostgresStorage({ pool: new pg.Pool({ connectionString: postgresUrl, options: `-c search_path=${schema}` }) });
    try {
      await storage.ready();
      expect(await storage.getTokenByRefreshToken("old-rt")).toMatchObject({ clientId: "web", grantId: undefined });
      await storage.saveToken({ accessToken: "at", refreshToken: "rt", clientId: "web", userId: "alice", yandexAccessToken: "", scope: "iot:view", createdAt: 1, expiresAt: Date.now() + 60000, grantId: "g1" });
      expect((await storage.getToken("at"))?.grantId).toBe("g1");
      expect(await storage.revokeGrantFamily("g1")).toBe(true);
      expect(await storage.getTokenByRefreshToken("old-rt")).not.toBeNull();
    } finally {
      await storage.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
