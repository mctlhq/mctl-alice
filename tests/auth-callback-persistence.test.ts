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

async function startServer(port: number, authRequired: boolean) {
  const server = createHttpServer(port, {
    publicBaseUrl: `http://localhost:${port}`,
    authRequired,
    clientId: "test_client_id",
    clientSecret: "test_client_secret",
    oauthStorage: new OAuthStorage(":memory:"),
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

  it("still persists the tokens locally when authRequired is false", async () => {
    const port = 8198;
    server = await startServer(port, false);

    const res = await realFetch(`http://localhost:${port}/auth/callback?code=abc`);

    expect(res.status).toBe(200);
    expect(tokenStorage.saveTokenToEnvFile).toHaveBeenCalledWith("y0_user_access");
    expect(tokenStorage.saveRefreshTokenToEnvFile).toHaveBeenCalledWith("user_refresh");
  });
});
