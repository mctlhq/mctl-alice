import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { TelemetryStorage } from "../src/storage/telemetry-storage.js";

const challenge = createHash("sha256").update("a".repeat(43)).digest("base64url");

describe("hosted sign-in pages", () => {
  let storage: OAuthStorage, history: TelemetryStorage, server: http.Server, base: string;
  beforeEach(async () => {
    storage = new OAuthStorage(":memory:"); history = new TelemetryStorage(":memory:");
    const now = Date.now();
    storage.saveUser({ id: "alice", yandexUid: "1001", login: "alice.home", displayName: "Alice <b>Home</b>", createdAt: now, updatedAt: now });
    storage.saveUser({ id: "bob", yandexUid: "1002", createdAt: now, updatedAt: now });
    for (const id of ["alice", "bob"]) storage.saveWebSession(id, id, now + 60000);
    storage.saveClient({ clientId: "client", clientSecret: "", clientName: "Test client", redirectUris: ["http://localhost/callback"], createdAt: now });
    server = createHttpServer(0, { publicBaseUrl: "http://localhost", authRequired: true, oauthStorage: storage, storage: history, enableSampler: false });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); storage.close(); history.close(); });

  const consent = async (session: string, scope = "iot:view iot:control quasar") => {
    const query = new URLSearchParams({ client_id: "client", redirect_uri: "http://localhost/callback", scope, code_challenge_method: "S256", code_challenge: challenge });
    const res = await fetch(`${base}/oauth/authorize?${query}`, { headers: { Cookie: `mctl_session=${session}` } });
    expect(res.status).toBe(200);
    return res.text();
  };

  it("names the verified Yandex account the grant is for, escaped", async () => {
    const html = await consent("alice");
    expect(html).toContain('data-i18n="oauth_account_label"');
    expect(html).toContain("Alice &lt;b&gt;Home&lt;/b&gt;");
    expect(html).not.toContain("Alice <b>Home</b>");
    expect(html).toContain("alice.home");
    // A user Yandex returned no name or login for is still identified.
    expect(await consent("bob")).toContain("Yandex ID 1002");
  });

  it("explains each permission, the whole-home scope and retention, with policy links", async () => {
    const html = await consent("alice");
    for (const key of ["oauth_scope_view", "oauth_scope_control", "oauth_scope_quasar", "oauth_whole_home", "oauth_retention_tokens", "oauth_retention_yandex", "oauth_retention_revoke"]) {
      expect(html, key).toContain(`data-i18n="${key}"`);
    }
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    // Only the requested scopes are offered.
    const viewOnly = await consent("alice", "iot:view");
    expect(viewOnly).toContain('name="scope_iot:view"');
    expect(viewOnly).not.toContain('name="scope_iot:control"');
    expect(viewOnly).not.toContain('data-i18n="oauth_scope_quasar"');
  });

  it("shows the QR sign-in behind a button that explains the broader session", async () => {
    const res = await fetch(`${base}/auth/cookie`, { headers: { Cookie: "mctl_session=alice" } });
    const html = await res.text();
    expect(html).toContain('id="qr-start-btn"');
    expect(html).toContain('data-i18n="cookie_qr_scope_desc"');
    expect(html).toMatch(/id="qr-frame"[^>]*\shidden/);
  });
});

// Runs public/assets/auth-cookie.js against a minimal DOM and records fetches.
function runCookieScript() {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) {
      const listeners: Record<string, Array<() => unknown>> = {};
      elements.set(id, {
        id, hidden: false, style: {}, textContent: "", href: "",
        classList: { add() {}, remove() {} },
        replaceChildren() {},
        addEventListener(type: string, fn: () => unknown) { (listeners[type] ||= []).push(fn); },
        click: () => Promise.all((listeners.click || []).map(fn => fn())),
      });
    }
    return elements.get(id);
  };
  const fetches: string[] = [];
  const context = {
    document: {
      getElementById: (id: string) => (["cookieForm", "cookieInput", "status", "saveBtn"].includes(id) ? null : element(id)),
      createElement: () => ({ className: "", textContent: "" }),
      documentElement: { getAttribute: () => "en" },
    },
    window: {},
    fetch: async (url: string) => { fetches.push(url); return { json: async () => ({ status: "error", message: "stub" }) }; },
    setInterval: () => 0, clearInterval: () => {}, encodeURIComponent, URL,
  };
  const source = fs.readFileSync(path.resolve(__dirname, "../public/assets/auth-cookie.js"), "utf8");
  vm.runInNewContext(source, context);
  return { fetches, element };
}

describe("auth-cookie.js QR opt-in", () => {
  it("does not start a Yandex QR session until the user asks for one", async () => {
    const { fetches, element } = runCookieScript();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetches).toEqual([]);
    await element("qr-start-btn").click();
    expect(fetches).toEqual(["/auth/qr-code"]);
    expect(element("qr-start-btn").hidden).toBe(true);
    expect(element("qr-frame").hidden).toBe(false);
  });
});
