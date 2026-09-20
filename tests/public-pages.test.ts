import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";

describe("Public Informational Pages and Account Dashboard", () => {
  let server: http.Server;
  let storage: OAuthStorage;
  const PORT = 8192;
  const baseUrl = `http://localhost:${PORT}`;

  beforeAll(async () => {
    storage = new OAuthStorage(":memory:");
    server = createHttpServer(PORT, {
      publicBaseUrl: baseUrl,
      authRequired: false,
      enableSampler: false,
      oauthStorage: storage,
    });
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
  });

  it("should serve /about page with operator info and license", async () => {
    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("О сервисе mctl-alice");
    expect(html).toContain("Дмитрий Машков");
    expect(html).toContain("Apache 2.0");
  });

  it("should serve /privacy page with threat model and Quasar disclosures", async () => {
    const res = await fetch(`${baseUrl}/privacy`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Политика конфиденциальности");
    expect(html).toContain("AES-256-GCM");
    expect(html).toContain("Yandex Quasar");
  });

  it("should serve /terms page with physical safety warnings", async () => {
    const res = await fetch(`${baseUrl}/terms`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Условия использования");
    expect(html).toContain("Ответственность за физические устройства");
  });

  it("should serve /security page with vulnerability disclosure policy", async () => {
    const res = await fetch(`${baseUrl}/security`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Политика безопасности");
    expect(html).toContain("security@mctl.ai");
  });

  it("should serve /account dashboard for unauthenticated user", async () => {
    const res = await fetch(`${baseUrl}/account`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Личный кабинет");
    expect(html).toContain("Войти через Яндекс ID");
  });

  it("should serve /account dashboard with user details and handle data deletion", async () => {
    const userId = "usr_test_account_1";
    storage.saveUser({
      id: userId,
      yandexUid: "998877",
      displayName: "Тестовый Пользователь",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    storage.saveUserCredentials(userId, {
      yandexAccessToken: "test_token",
      quasarCookie: "Session_id=test_cookie",
    });

    const sessionId = "sess_account_test";
    storage.saveWebSession(sessionId, userId, Date.now() + 3600000);

    const res = await fetch(`${baseUrl}/account`, {
      headers: {
        Cookie: `mctl_session=${sessionId}`,
      },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Тестовый Пользователь");
    expect(html).toContain("Подключено");

    // Perform account deletion
    const delRes = await fetch(`${baseUrl}/account/delete`, {
      method: "POST",
      headers: {
        Cookie: `mctl_session=${sessionId}`,
      },
      redirect: "manual",
    });
    expect(delRes.status).toBe(302);
    expect(delRes.headers.get("Location")).toContain("/?deleted=true");

    // Assert user wiped from database
    expect(storage.getUser(userId)).toBeNull();
    expect(storage.getUserCredentials(userId)).toBeNull();
  });
});
