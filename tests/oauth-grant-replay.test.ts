import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthController } from "../src/auth/oauth-controller.js";
import { createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
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

describe("hosted grant replay and rotation", () => {
  let db: OAuthStorage;
  let storage: IStorage;
  let controller: OAuthController;

  beforeEach(async () => {
    db = new OAuthStorage(":memory:");
    storage = asynchronous(db);
    controller = new OAuthController({ baseUrl, yandexClientId: "app", storage, authRequired: true });
    await storage.saveUser({ id: "alice", yandexUid: "alice", createdAt: Date.now(), updatedAt: Date.now() });
    await storage.saveUserCredentials("alice", { yandexAccessToken: "upstream-alice", yandexRefreshToken: "upstream-refresh" });
    await storage.saveClient({ clientId: "web", clientSecret: "", clientName: "Web", redirectUris: [redirectUri], createdAt: Date.now() });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    db.close();
  });

  async function issueCode(): Promise<string> {
    const consent = await controller.handleAuthorize({ client_id: "web", redirect_uri: redirectUri, userId: "alice", scope: "iot:view", code_challenge: challenge, code_challenge_method: "S256" });
    if (!("sessionId" in consent)) throw new Error("Expected consent");
    const { redirectUrl } = await controller.approveAuthorization(consent.sessionId, "alice");
    return new URL(redirectUrl).searchParams.get("code")!;
  }
  const exchange = (code: string) => controller.handleToken({ grant_type: "authorization_code", client_id: "web", redirect_uri: redirectUri, code, code_verifier: verifier });
  const refresh = (refreshToken: string) => controller.handleToken({ grant_type: "refresh_token", client_id: "web", refresh_token: refreshToken });

  describe("authorization code", () => {
    it("is single use: a second exchange of the same code fails", async () => {
      const code = await issueCode();
      const first = await exchange(code);
      expect(await storage.getToken(first.access_token)).toMatchObject({ userId: "alice", clientId: "web" });
      await expect(exchange(code)).rejects.toThrow("Invalid or expired authorization code");
    });

    it("two simultaneous exchanges of one code yield exactly one token pair", async () => {
      const code = await issueCode();
      const results = await Promise.allSettled([exchange(code), exchange(code)]);
      const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof exchange>>> => r.status === "fulfilled");
      expect(won).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(await storage.listUserGrants("alice")).toHaveLength(1);
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

    it("two simultaneous refreshes with one token: at most one succeeds and one pair survives", async () => {
      const first = await exchange(await issueCode());
      const results = await Promise.allSettled([refresh(first.refresh_token!), refresh(first.refresh_token!)]);
      const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof refresh>>> => r.status === "fulfilled");
      expect(won).toHaveLength(1);
      expect(await storage.getTokenByRefreshToken(first.refresh_token!)).toBeNull();
      expect(await storage.getToken(won[0].value.access_token)).toMatchObject({ userId: "alice" });
      expect(await storage.listUserGrants("alice")).toHaveLength(1);
      const live = (db as any).db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE user_id = ?").get("alice") as { n: number };
      expect(Number(live.n)).toBe(1);
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
      expect(await storage.getUserCredentials("alice")).toMatchObject({ yandexAccessToken: "upstream-1", yandexRefreshToken: "upstream-refresh-1" });
      const live = (db as any).db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE user_id = ?").get("alice") as { n: number };
      expect(Number(live.n)).toBe(1);
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
      const tokens = await first.json() as { refresh_token: string };
      const replayedCode = await post(codeBody);
      expect(replayedCode.status).toBe(400);
      expect(await replayedCode.json()).toMatchObject({ error: "invalid_grant" });

      const refreshBody = { grant_type: "refresh_token", client_id: "web", refresh_token: tokens.refresh_token };
      expect((await post(refreshBody)).status).toBe(200);
      const replayedRefresh = await post(refreshBody);
      expect(replayedRefresh.status).toBe(400);
      expect(await replayedRefresh.json()).toMatchObject({ error: "invalid_grant" });
    });
  });
});
