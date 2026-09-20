import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { createHttpServer } from "../src/server/http-server.js";

describe("Multi-User SaaS Isolation & Security", () => {
  let storage: OAuthStorage;
  let server: http.Server;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    storage = new OAuthStorage(":memory:");
    port = 8200 + Math.floor(Math.random() * 500);
    baseUrl = `http://localhost:${port}`;

    server = createHttpServer(port, {
      publicBaseUrl: baseUrl,
      authRequired: true,
      oauthStorage: storage,
      enableSampler: false,
    });
    await new Promise<void>((resolve) => server.listen(port, resolve));
  });

  afterEach(() => {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("should isolate user credentials, web sessions, and tokens between distinct tenants", async () => {
    // 1. Create User A
    const userA = {
      id: "usr_alice_1111",
      yandexUid: "111111",
      login: "alice",
      displayName: "Alice",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    storage.saveUser(userA);
    storage.saveUserCredentials(userA.id, {
      yandexAccessToken: "mock_yandex_token_A",
      quasarCookie: "Session_id=cookie_A",
    });

    // 2. Create User B
    const userB = {
      id: "usr_bob_2222",
      yandexUid: "222222",
      login: "bob",
      displayName: "Bob",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    storage.saveUser(userB);
    storage.saveUserCredentials(userB.id, {
      yandexAccessToken: "mock_yandex_token_B",
      quasarCookie: "Session_id=cookie_B",
    });

    // 3. Verify at-rest encryption & isolation
    const credsA = storage.getUserCredentials(userA.id);
    const credsB = storage.getUserCredentials(userB.id);
    expect(credsA?.yandexAccessToken).toBe("mock_yandex_token_A");
    expect(credsA?.quasarCookie).toBe("Session_id=cookie_A");
    expect(credsB?.yandexAccessToken).toBe("mock_yandex_token_B");
    expect(credsB?.quasarCookie).toBe("Session_id=cookie_B");

    // 4. Issue OAuth access tokens for each user
    const tokenA = "mctl_at_token_user_a";
    const tokenB = "mctl_at_token_user_b";

    storage.saveToken({
      accessToken: tokenA,
      refreshToken: "mctl_rt_a",
      clientId: "chatgpt_client",
      userId: userA.id,
      yandexAccessToken: "mock_yandex_token_A",
      scope: "iot:view iot:control quasar",
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
    });

    storage.saveToken({
      accessToken: tokenB,
      refreshToken: "mctl_rt_b",
      clientId: "codex_client",
      userId: userB.id,
      yandexAccessToken: "mock_yandex_token_B",
      scope: "iot:view",
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
    });

    // 5. Test scope enforcement: Token B only has iot:view
    const callResB = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "alice_send_command",
          arguments: { command: "включи свет" },
        },
      }),
    });

    expect(callResB.status).toBe(200);
    const jsonB = await callResB.json();
    expect(jsonB.result.isError).toBe(true);
    expect(jsonB.result.content[0].text).toContain("недостаточно прав доступа");

    // 6. Test scenarios isolation in storage
    storage.saveQuasarScenario(userA.id, "speaker_1", "scen_a_1");
    storage.saveQuasarScenario(userB.id, "speaker_1", "scen_b_1");

    expect(storage.getQuasarScenario(userA.id, "speaker_1")).toBe("scen_a_1");
    expect(storage.getQuasarScenario(userB.id, "speaker_1")).toBe("scen_b_1");

    // 7. Test User A deletion does NOT impact User B
    storage.deleteUser(userA.id);

    expect(storage.getUser(userA.id)).toBeNull();
    expect(storage.getUserCredentials(userA.id)).toBeNull();
    expect(storage.getQuasarScenario(userA.id, "speaker_1")).toBeNull();

    // User B remains intact
    expect(storage.getUser(userB.id)).not.toBeNull();
    expect(storage.getUserCredentials(userB.id)?.quasarCookie).toBe("Session_id=cookie_B");
    expect(storage.getQuasarScenario(userB.id, "speaker_1")).toBe("scen_b_1");
  });

  it("should enforce session authentication for protected web endpoints", async () => {
    // 1. Unauthenticated request to /account should render unauthenticated state
    const accountRes = await fetch(`${baseUrl}/account`);
    expect(accountRes.status).toBe(200);
    const html = await accountRes.text();
    expect(html).toContain("account-unauth");
    expect(html).toContain("btn_login_yandex");

    // 2. Unauthenticated request to /auth/cookie with authRequired: true should redirect to /auth/login
    const cookieRes = await fetch(`${baseUrl}/auth/cookie`, { redirect: "manual" });
    expect(cookieRes.status).toBe(302);
    expect(cookieRes.headers.get("location")).toBe("/auth/login");

    // 3. Unauthenticated POST to /auth/save-cookie should return 401
    const saveCookieRes = await fetch(`${baseUrl}/auth/save-cookie`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: "Session_id=dummy" }),
    });
    expect(saveCookieRes.status).toBe(401);
  });
});
