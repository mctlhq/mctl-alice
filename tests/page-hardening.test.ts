import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHttpServer, contentSecurityPolicy, formActionSourceFor, isCorsPath } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";

const assetsDir = path.resolve(__dirname, "../public/assets");
const readAsset = (name: string) => fs.readFileSync(path.join(assetsDir, name), "utf8");

describe("CSP, CORS and HTML hardening", () => {
  let server: http.Server;
  let storage: OAuthStorage;
  let base: string;
  const htmlPages = new Map<string, { headers: Headers; body: string }>();

  beforeAll(async () => {
    storage = new OAuthStorage(":memory:");
    server = createHttpServer(0, { publicBaseUrl: "http://localhost", authRequired: false, oauthStorage: storage, enableSampler: false });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;

    const registration = await fetch(base + "/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "probe", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" }),
    });
    const { client_id } = await registration.json() as { client_id: string };
    const consent = "/oauth/authorize?" + new URLSearchParams({
      client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", response_type: "code", state: "s",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
    });
    for (const page of ["/", "/about", "/privacy", "/terms", "/security", "/account", "/auth/cookie", "/auth/callback", consent]) {
      const res = await fetch(base + page, { headers: { Accept: "text/html" } });
      expect(res.status, page).toBe(200);
      expect(res.headers.get("content-type"), page).toContain("text/html");
      htmlPages.set(page.startsWith("/oauth/authorize") ? "consent" : page, { headers: res.headers, body: await res.text() });
    }

    const now = Date.now();
    storage.saveUser({ id: "alice", yandexUid: "alice", createdAt: now, updatedAt: now });
    storage.saveUserCredentials("alice", { yandexAccessToken: "alice", quasarCookie: "Session_id=alice" });
    storage.saveWebSession("browser-a", "alice", now + 60000);
    const account = await fetch(base + "/account", { headers: { Cookie: "mctl_session=browser-a" } });
    expect(account.status).toBe(200);
    htmlPages.set("/account (signed in)", { headers: account.headers, body: await account.text() });
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close();
  });

  it("sends a CSP without unsafe-inline and frame protection on every HTML page", () => {
    expect(htmlPages.size).toBe(10);
    for (const [page, { headers }] of htmlPages) {
      const csp = headers.get("content-security-policy") || "";
      expect(csp, page).toContain("script-src 'self';");
      expect(csp, page).toContain("style-src-attr 'none'");
      expect(csp, page).toContain("frame-ancestors 'none'");
      expect(csp, page).not.toContain("unsafe-inline");
      expect(headers.get("x-frame-options"), page).toBe("DENY");
      expect(headers.get("x-content-type-options"), page).toBe("nosniff");
    }
  });

  it("lets the consent form redirect only to the client's own origin", () => {
    const csp = htmlPages.get("consent")!.headers.get("content-security-policy");
    expect(csp).toMatch(/form-action 'self' https:\/\/claude\.ai$/);
    expect(htmlPages.get("/about")!.headers.get("content-security-policy")).toMatch(/form-action 'self'$/);
  });

  it("serves HTML without inline scripts, event handlers or style attributes", () => {
    for (const [page, { body }] of htmlPages) {
      expect(body.match(/<script(?![^>]*\ssrc=)[^>]*>/gi), page).toBeNull();
      expect(body.match(/<[^>]+\son[a-z]+\s*=/gi), page).toBeNull();
      expect(body.match(/<[^>]+\sstyle\s*=/gi), page).toBeNull();
    }
  });

  it("asks for confirmation through data-confirm on destructive account forms", () => {
    const body = htmlPages.get("/account (signed in)")!.body;
    expect(body).toMatch(/<form[^>]*action="\/account\/delete"[^>]*data-confirm="/);
    expect(body).toMatch(/<form[^>]*action="\/account\/disconnect-quasar"[^>]*data-confirm="/);
    expect(readAsset("site.js")).toContain('form.getAttribute("data-confirm")');
  });

  it("defines every page style class the markup and translations use", () => {
    const css = readAsset("pages.css");
    const sources = [...[...htmlPages.values()].map(p => p.body), readAsset("site.js")];
    const used = new Set(sources.flatMap(source => source.match(/\bs-[0-9a-f]{6}\b/g) || []));
    expect(used.size).toBeGreaterThan(20);
    for (const cls of used) expect(css, cls).toContain(`.${cls}.${cls} {`);
    expect(readAsset("site.js")).not.toMatch(/style=\\?"/);
  });

  it("keeps server and user data out of innerHTML in page scripts", () => {
    for (const name of ["auth-callback.js", "auth-cookie.js", "theme-init.js"]) {
      expect(readAsset(name), name).not.toContain("innerHTML");
    }
    // The only innerHTML in site.js renders the built-in translation table.
    expect(readAsset("site.js").match(/innerHTML/g)).toHaveLength(1);
    expect(readAsset("auth-cookie.js")).toContain('"data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg)');
  });

  it("answers CORS preflight with explicit headers on MCP endpoints only", async () => {
    const preflight = await fetch(base + "/mcp", { method: "OPTIONS", headers: { Origin: "https://example.com" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Mcp-Session-Id");
    expect(preflight.headers.get("access-control-allow-headers")).not.toContain("*");
    expect(preflight.headers.get("access-control-expose-headers")).not.toContain("*");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();

    for (const page of ["/account", "/auth/cookie", "/auth/callback", "consent"]) {
      expect(htmlPages.get(page)!.headers.get("access-control-allow-origin"), page).toBeNull();
    }
    const accountPreflight = await fetch(base + "/account/delete", { method: "OPTIONS", headers: { Origin: "https://example.com" } });
    expect(accountPreflight.status).toBe(405);
    expect(accountPreflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("classifies CORS paths", () => {
    for (const p of ["/mcp", "/sse", "/messages", "/mcp/messages", "/oauth/token", "/oauth/register", "/.well-known/oauth-authorization-server", "/api/devices"]) {
      expect(isCorsPath(p), p).toBe(true);
    }
    for (const p of ["/account", "/account/delete", "/auth/save-token", "/auth/cookie", "/oauth/authorize", "/about"]) {
      expect(isCorsPath(p), p).toBe(false);
    }
  });

  it("derives a form-action source only from a plain origin or safe scheme", () => {
    expect(formActionSourceFor("https://claude.ai/api/mcp/auth_callback")).toBe("https://claude.ai");
    expect(formActionSourceFor("http://localhost:6274/oauth/callback")).toBe("http://localhost:6274");
    expect(formActionSourceFor("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe("cursor:");
    for (const unsafe of ["javascript:alert(1)", "data:text/html,x", "not a url", ""]) {
      expect(formActionSourceFor(unsafe), unsafe).toBeUndefined();
    }
    expect(contentSecurityPolicy(formActionSourceFor("javascript:alert(1)"))).toMatch(/form-action 'self'$/);
  });
});
