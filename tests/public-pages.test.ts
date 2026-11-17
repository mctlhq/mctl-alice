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

  it("should serve /about page with contacts and license", async () => {
    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("О сервисе mctl-alice");
    expect(html).toContain("support@mctl.ai");
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

  it("should serve /setup page with client configurators and meta descriptions", async () => {
    const res = await fetch(`${baseUrl}/setup`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="description"');
    expect(html).toContain('data-page-description-key="setup_page_description"');
    expect(html).toContain("claude mcp add --transport http alice");
    expect(html).toContain(".cursor/mcp.json");
    expect(html).toContain("Zed Editor");
  });

  it("should render meta description and description key on /about and /security", async () => {
    const aboutRes = await fetch(`${baseUrl}/about`);
    const aboutHtml = await aboutRes.text();
    expect(aboutHtml).toContain('data-page-description-key="about_page_description"');

    const secRes = await fetch(`${baseUrl}/security`);
    const secHtml = await secRes.text();
    expect(secHtml).toContain('data-page-description-key="security_page_description"');
  });

  it("should maintain i18n description and title key parity between RU and EN dictionaries", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const siteJs = fs.readFileSync(path.resolve("public/assets/site.js"), "utf-8");
    const keys = [
      "setup_page_description",
      "about_page_description",
      "security_page_description",
      "setup_page_title",
      "setup_page_h1",
      "setup_page_lead",
      "setup_tested_list",
    ];
    for (const key of keys) {
      const occurrences = (siteJs.match(new RegExp(`${key}:`, "g")) || []).length;
      expect(occurrences).toBe(2);
    }
  });

  it("keeps the English /setup copy to the same verified clients as the Russian one", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const siteJs = fs.readFileSync(path.resolve("public/assets/site.js"), "utf-8");
    const en = siteJs.match(/en:\s*\{([\s\S]*?)\n\s*\}\s*\};/)![1];
    const value = (key: string) => {
      const literal = en.match(new RegExp(`^\\s{6}${key}: ("(?:[^"\\\\]|\\\\.)*"),?$`, "m"));
      expect(literal, key).not.toBeNull();
      return JSON.parse(literal![1]) as string;
    };
    expect(value("setup_page_title")).toBe("How to connect Yandex Alice to ChatGPT and Claude via MCP | mctl-alice");
    expect(value("setup_page_h1")).toBe("How to connect Alice and Yandex Station to ChatGPT or Claude");
    expect(value("setup_page_lead")).toMatch(/^mctl-alice is an independent MCP server/);
    expect(value("setup_page_description")).not.toMatch(/Cursor/);
    expect(value("setup_tested_list")).toContain("chatgpt.com/plugins");
    expect(value("setup_tested_list")).not.toMatch(/Cursor|Claude Code|limited/);
    expect(value("setup_voice_faq_desc")).not.toContain("Cursor");
    expect(value("setup_other_desc")).toContain("have not tested");
    for (const key of ["setup_page_title", "setup_page_description", "setup_page_h1", "setup_page_lead"]) {
      expect(value(key), key).not.toMatch(/official/i);
    }
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
        Origin: baseUrl,
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
