import { fetchYandexProfile } from "../src/auth/oauth-helper.js";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";

// The save* helpers write a .env file and the macOS Keychain. They are
// replaced so the test can observe whether the handlers call them without
// touching either.
vi.mock("../src/auth/token-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/token-storage.js")>();
  return {
    ...actual,
    saveTokenToEnvFile: vi.fn(),
    saveRefreshTokenToEnvFile: vi.fn(),
    saveTokenToKeychain: vi.fn(() => false),
  };
});

const tokenStorage = await import("../src/auth/token-storage.js");

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Outbound Yandex calls are answered locally; requests to the test server
// itself go through the real fetch.
function stubYandex() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://oauth.yandex.ru/token")) {
      return jsonResponse({
        access_token: "y0_user_access",
        refresh_token: "user_refresh",
        token_type: "bearer",
        expires_in: 3600,
      });
    }
    if (url.startsWith("https://api.iot.yandex.net/v1.0/user/info")) {
      return jsonResponse({ status: "ok", rooms: [], devices: [], scenarios: [], groups: [] });
    }
    if (url.startsWith("https://login.yandex.ru/info")) {
      return jsonResponse({ id: "42", login: "user", display_name: "User" });
    }
    return realFetch(input, init);
  });
}

async function startServer(port: number, authRequired: boolean, storage = new OAuthStorage(":memory:")) {
  const server = createHttpServer(port, {
    publicBaseUrl: `http://localhost:${port}`,
    authRequired,
    clientId: "test_client_id",
    clientSecret: "test_client_secret",
    oauthStorage: storage,
    enableSampler: false,
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}

describe("/auth/callback code exchange persistence", () => {
  let server: http.Server | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    stubYandex();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("does not write the user's tokens to .env or the Keychain when authRequired is true", async () => {
    const port = 8197;
    server = await startServer(port, true);

    const login = await realFetch(`http://localhost:${port}/auth/login`, { redirect: "manual" });
    const state = new URL(login.headers.get("location")!).searchParams.get("state");
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const res = await realFetch(`http://localhost:${port}/auth/callback?code=abc&state=${state}`, { redirect: "manual", headers: { Cookie: cookie } });

    expect(res.status).toBe(302);
    expect(tokenStorage.saveTokenToEnvFile).not.toHaveBeenCalled();
    expect(tokenStorage.saveRefreshTokenToEnvFile).not.toHaveBeenCalled();
    expect(tokenStorage.saveTokenToKeychain).not.toHaveBeenCalled();
  });

  it("recovers only the verified owner and survives a server restart during login", async () => {
    const storage = new OAuthStorage(":memory:");
    for (const id of ["usr_42", "other"]) {
      storage.saveUser({ id, yandexUid: id, createdAt: Date.now(), updatedAt: Date.now() });
      storage.saveUserCredentials(id, { yandexAccessToken: `old-${id}` });
    }
    (storage as unknown as { db: DatabaseSync }).db.exec("UPDATE user_credentials SET encrypted_yandex_access_token='corrupt' WHERE user_id='usr_42'");
    server = await startServer(8199, true, storage);
    const login = await realFetch("http://localhost:8199/auth/login", { redirect: "manual", headers: { Connection: "close" } });
    const state = new URL(login.headers.get("location")!).searchParams.get("state");
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = await startServer(8199, true, storage);
    const response = await realFetch(`http://localhost:8199/auth/callback?code=abc&state=${state}`, { redirect: "manual", headers: { Cookie: cookie, Connection: "close" } });
    expect(response.status).toBe(302);
    expect(storage.getUserCredentials("usr_42")?.yandexAccessToken).toBe("y0_user_access");
    expect(storage.getUserCredentials("other")?.yandexAccessToken).toBe("old-other");
    const replay = await realFetch(`http://localhost:8199/auth/callback?code=abc&state=${state}`, { redirect: "manual", headers: { Cookie: cookie, Connection: "close" } });
    expect(replay.status).toBe(400);
  });

  it("does not invent a hosted owner when the Yandex identity endpoint fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(fetchYandexProfile("unverified-token", true)).rejects.toThrow("profile verification failed");
  });

  it("still persists the tokens locally when authRequired is false", async () => {
    const port = 8198;
    server = await startServer(port, false);

    // A code the operator's browser did not ask for is refused: a page could
    // otherwise send that browser here with a code for its own account.
    const forged = await realFetch(`http://localhost:${port}/auth/callback?code=abc`, { headers: { Connection: "close" } });
    expect(forged.status).toBe(400);
    expect(tokenStorage.saveTokenToEnvFile).not.toHaveBeenCalled();

    const login = await realFetch(`http://localhost:${port}/auth/login`, { redirect: "manual", headers: { Connection: "close" } });
    const state = new URL(login.headers.get("location")!).searchParams.get("state");
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const res = await realFetch(`http://localhost:${port}/auth/callback?code=abc&state=${state}`, { headers: { Cookie: cookie, Connection: "close" } });

    expect(res.status).toBe(200);
    expect(tokenStorage.saveTokenToEnvFile).toHaveBeenCalledWith("y0_user_access");
    expect(tokenStorage.saveRefreshTokenToEnvFile).toHaveBeenCalledWith("user_refresh");
  });
});
