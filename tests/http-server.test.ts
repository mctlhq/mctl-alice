import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { createHttpServer } from "../src/server/http-server.js";
import { getOpenApiSpec } from "../src/server/openapi.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";

describe("HTTP Server & ChatGPT REST API", () => {
  let server: http.Server;
  const PORT = 8189;
  const baseUrl = `http://localhost:${PORT}`;

  beforeAll(async () => {
    server = createHttpServer(PORT, {
      publicBaseUrl: baseUrl,
    });
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should serve OpenAPI 3.1 specification at /openapi.json", async () => {
    const res = await fetch(`${baseUrl}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toContain("Alice");
    expect(spec.paths["/api/say"]).toBeDefined();
    expect(spec.paths["/api/command"]).toBeDefined();
    expect(spec.paths["/api/volume"]).toBeDefined();
    expect(spec.paths["/api/media"]).toBeDefined();
    expect(spec.paths["/api/devices"]).toBeDefined();
    expect(spec.paths["/api/scenarios/trigger"]).toBeDefined();
  });

  it("should serve health check at /healthz", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  it("should validate required fields in /api/say", async () => {
    const res = await fetch(`${baseUrl}/api/say`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toContain("phrase");
  });

  it("should validate required fields in /api/command", async () => {
    const res = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toContain("command");
  });

  it("should validate level range in /api/volume", async () => {
    const res = await fetch(`${baseUrl}/api/volume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: 15 }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toContain("between 1 and 10");
  });

  it("should validate action in /api/media", async () => {
    const res = await fetch(`${baseUrl}/api/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invalid_action" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toContain("action");
  });

  it("should handle MCP SSE connection and send endpoint event", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/sse`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    const { value } = await reader!.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: endpoint");
    expect(text).toContain("data: /messages?sessionId=");

    // Extract sessionId
    const match = text.match(/sessionId=([a-zA-Z0-9_-]+)/);
    expect(match).toBeDefined();
    const sessionId = match![1];

    // POST valid message with session
    const postRes = await fetch(`${baseUrl}/messages?sessionId=${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "chatgpt", version: "1.0.0" },
        },
      }),
    });
    expect(postRes.status).toBe(202);

    controller.abort();
  });

  it("should handle modern ChatGPT Streamable HTTP initialize and tools/list", async () => {
    // 1. initialize
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "chatgpt", version: "1.0.0" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeDefined();

    // 2. notifications/initialized
    const notifRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    });
    expect(notifRes.status).toBe(202);

    // 3. tools/list
    const toolsRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    expect(toolsRes.status).toBe(200);
    const toolsBody = await toolsRes.text();
    expect(toolsBody).toContain("alice_say_phrase");
    expect(toolsBody).toContain("alice_send_command");
  });

  it("should handle pure stateless tools/list without prior session or initialize", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "stateless-1",
        method: "tools/list",
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("stateless-1");
    expect(data.result.tools).toBeDefined();
    expect(data.result.tools.some((t: any) => t.name === "alice_list_devices")).toBe(true);
  });

  it("should handle pure stateless requests on /sse endpoint with POST", async () => {
    const res = await fetch(`${baseUrl}/sse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "stateless-sse",
        method: "ping",
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("stateless-sse");
    expect(data.result).toEqual({});
  });

  it("should handle pure stateless MCP JSON-RPC requests on root / endpoint with POST", async () => {
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "stateless-root",
        method: "ping",
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("stateless-root");
    expect(data.result).toEqual({});
  });

  it("should handle SSE connection on /mcp as well", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/mcp`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  });

  it("should serve landing page HTML at GET / with i18n and clean navigation", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("mctl-alice");
    expect(text).toContain("BETA");
    expect(text).toContain("alice_send_command");
    expect(text).toContain('id="lang-switcher"');
    expect(text).toContain('data-lang="ru"');
    expect(text).toContain('data-lang="en"');
    expect(text).toContain("data-i18n=");
    expect(text).toContain("/assets/site.js?v=1.9.2");
    // Should NOT contain openapi link in navigation or hero GitHub CTA button
    expect(text).not.toContain('<a href="/openapi.json">OpenAPI</a>');
    expect(text).not.toContain('>Репозиторий на GitHub</a>');
  });

  it("should serve JSON info at GET / when Accept is explicitly application/json", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.service).toBe("mctl-alice");
  });

  it("should serve static CSS assets at /assets/components.css and /assets/tokens.css", async () => {
    const resCss = await fetch(`${baseUrl}/assets/components.css`);
    expect(resCss.status).toBe(200);
    expect(resCss.headers.get("content-type")).toContain("text/css");
    const cssText = await resCss.text();
    expect(cssText).toContain("chip-beta");

    const resTokens = await fetch(`${baseUrl}/assets/tokens.css`);
    expect(resTokens.status).toBe(200);
    expect(resTokens.headers.get("content-type")).toContain("text/css");
  });

  it("should serve favicon.svg with correct MIME type", async () => {
    const res = await fetch(`${baseUrl}/favicon.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("should return 404 for non-existent assets", async () => {
    const res = await fetch(`${baseUrl}/assets/non-existent.css`);
    expect(res.status).toBe(404);
  });

  it("should block directory traversal on /assets", async () => {
    const res = await fetch(`${baseUrl}/assets/%2e%2e/%2e%2e/package.json`);
    expect([403, 404]).toContain(res.status);
  });

  it("should return 404 for unknown session on /messages", async () => {
    const res = await fetch(`${baseUrl}/messages?sessionId=non-existent-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("should serve Quasar cookie configuration page at /auth/cookie with unified styling, QR code card, and i18n", async () => {
    const res = await fetch(`${baseUrl}/auth/cookie`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("mctl-alice — Настройка Quasar");
    expect(html).toContain("Session_id");
    expect(html).toContain("/assets/tokens.css");
    expect(html).toContain("/assets/components.css");
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('id="lang-switcher"');
    expect(html).toContain('data-i18n="cookie_title"');
    expect(html).toContain('class="qr-card"');
    expect(html).toContain('data-i18n="cookie_qr_title"');
  });

  it("should serve unified styled page on /auth/callback without code with i18n", async () => {
    const res = await fetch(`${baseUrl}/auth/callback`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("mctl-alice — Авторизация");
    expect(html).toContain("/assets/tokens.css");
    expect(html).toContain("/assets/components.css");
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('id="lang-switcher"');
    expect(html).toContain('data-i18n="callback_success_title"');
  });

  it("should validate sessionId parameter on /auth/qr-status", async () => {
    const res = await fetch(`${baseUrl}/auth/qr-status`);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toContain("sessionId missing");
  });

  it("should handle /auth/qr-status for non-existent session", async () => {
    const res = await fetch(`${baseUrl}/auth/qr-status?sessionId=non_existent_123`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("expired");
  });

  it("should validate missing cookie on /auth/save-cookie", async () => {
    const res = await fetch(`${baseUrl}/auth/save-cookie`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toContain("Cookie missing");
  });

  it("should serve RFC 9728 Protected Resource Metadata at /.well-known/oauth-protected-resource", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.resource).toBe(`${baseUrl}/mcp`);
    expect(data.authorization_servers).toEqual([baseUrl]);
    expect(data.scopes_supported).toContain("iot:view");
  });

  it("should serve RFC 8414 Authorization Server Metadata at /.well-known/oauth-authorization-server", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.issuer).toBe(baseUrl);
    expect(data.authorization_endpoint).toBe(`${baseUrl}/oauth/authorize`);
    expect(data.token_endpoint).toBe(`${baseUrl}/oauth/token`);
    expect(data.revocation_endpoint).toBe(`${baseUrl}/oauth/revoke`);
    expect(data.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("should handle RFC 7591 Dynamic Client Registration at /oauth/register", async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT OpenAI Test",
        redirect_uris: ["https://chatgpt.com/aip/g-123/oauth/callback"],
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.client_id).toBeDefined();
    expect(data.client_name).toBe("ChatGPT OpenAI Test");
  });

  it("should serve consent page on GET /oauth/authorize and approve via POST", async () => {
    // 1. GET /oauth/authorize renders consent screen
    const res = await fetch(
      `${baseUrl}/oauth/authorize?client_id=test_client&redirect_uri=https://chatgpt.com/callback&response_type=code&state=xyz`
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Авторизация приложения");
    expect(html).toContain("test_client");
    expect(html).toContain('name="session_id"');
    expect(html).toContain('value="approve"');

    // Extract session_id
    const sessionMatch = html.match(/name="session_id"\s+value="([^"]+)"/);
    expect(sessionMatch).not.toBeNull();
    const sessionId = sessionMatch![1];

    // 2. POST /oauth/authorize with approve action
    const approveRes = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `session_id=${encodeURIComponent(sessionId)}&action=approve`,
      redirect: "manual",
    });

    expect(approveRes.status).toBe(302);
    const redirectLocation = approveRes.headers.get("location");
    expect(redirectLocation).toBeDefined();
    const redirectUrl = new URL(redirectLocation!);
    expect(redirectUrl.origin).toBe("https://chatgpt.com");
    expect(redirectUrl.pathname).toBe("/callback");
    expect(redirectUrl.searchParams.get("code")).toMatch(/^code_/);
    expect(redirectUrl.searchParams.get("state")).toBe("xyz");
    expect(redirectUrl.searchParams.get("iss")).toBe(baseUrl);
  });

  it("should handle token revocation at /oauth/revoke", async () => {
    const res = await fetch(`${baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=dummy_token_to_revoke",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  it("should handle denial on POST /oauth/authorize", async () => {
    // 1. Initiate authorization to create pending session
    const authRes = await fetch(
      `${baseUrl}/oauth/authorize?client_id=test_client&redirect_uri=https://chatgpt.com/callback&response_type=code&state=client_state_val`
    );
    expect(authRes.status).toBe(200);
    const html = await authRes.text();
    const sessionMatch = html.match(/name="session_id"\s+value="([^"]+)"/);
    const sessionId = sessionMatch![1];

    // 2. Deny authorization
    const denyRes = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `session_id=${encodeURIComponent(sessionId)}&action=deny`,
      redirect: "manual",
    });

    expect(denyRes.status).toBe(302);
    const clientRedirect = new URL(denyRes.headers.get("location")!);
    expect(clientRedirect.origin).toBe("https://chatgpt.com");
    expect(clientRedirect.pathname).toBe("/callback");
    expect(clientRedirect.searchParams.get("error")).toBe("access_denied");
    expect(clientRedirect.searchParams.get("state")).toBe("client_state_val");
    expect(clientRedirect.searchParams.get("iss")).toBe(baseUrl);
  });

  it("should handle auto_approve: true directly on /oauth/authorize", async () => {
    const res = await fetch(
      `${baseUrl}/oauth/authorize?response_type=code&client_id=https%3A%2F%2Fclaude.ai%2Foauth%2Fmcp-oauth-client-metadata&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=test&code_challenge_method=S256&state=claude_state_test&auto_approve=true`,
      { redirect: "manual" }
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("https://claude.ai/api/mcp/auth_callback");
    expect(location).toContain("code=code_");
    expect(location).toContain("iss=");
  });
});

describe("HTTP Server with authRequired: true (OAuth & RFC 9728 discovery)", () => {
  let authServer: http.Server;
  const AUTH_PORT = 8191;
  const authBaseUrl = `http://localhost:${AUTH_PORT}`;
  let oauthStorage: OAuthStorage;
  const validBearerToken = "valid_mcp_access_token_xyz";

  beforeAll(async () => {
    oauthStorage = new OAuthStorage(":memory:");
    oauthStorage.saveToken({
      accessToken: validBearerToken,
      clientId: "test_client",
      yandexAccessToken: "mock_yandex_token",
      scope: "iot:view iot:control",
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
    });

    authServer = createHttpServer(AUTH_PORT, {
      publicBaseUrl: authBaseUrl,
      authRequired: true,
      oauthStorage,
      enableSampler: false,
    });
    await new Promise<void>((resolve) => authServer.listen(AUTH_PORT, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => authServer.close(() => resolve()));
  });

  it("should return 401 with WWW-Authenticate header on unauthenticated GET /mcp (RFC 9728 probe)", async () => {
    const res = await fetch(`${authBaseUrl}/mcp`, {
      method: "GET",
      headers: { Accept: "*/*" },
    });
    expect(res.status).toBe(401);
    const authHeader = res.headers.get("www-authenticate");
    expect(authHeader).toBeDefined();
    expect(authHeader).toContain(`Bearer realm="mctl-alice"`);
    expect(authHeader).toContain(`resource_metadata="${authBaseUrl}/.well-known/oauth-protected-resource/mcp"`);
    const data = await res.json();
    expect(data.error).toBe("authentication required");
  });

  it("should return 401 with WWW-Authenticate header on unauthenticated POST /mcp", async () => {
    const res = await fetch(`${authBaseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      }),
    });
    expect(res.status).toBe(401);
    const authHeader = res.headers.get("www-authenticate");
    expect(authHeader).toBeDefined();
    expect(authHeader).toContain(`Bearer realm="mctl-alice"`);
    expect(authHeader).toContain(`resource_metadata="${authBaseUrl}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("should return 401 with WWW-Authenticate on unauthenticated GET /sse", async () => {
    const res = await fetch(`${authBaseUrl}/sse`, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(401);
    const authHeader = res.headers.get("www-authenticate");
    expect(authHeader).toContain(`Bearer realm="mctl-alice"`);
  });

  it("should return 401 with error=invalid_token on invalid Bearer token", async () => {
    const res = await fetch(`${authBaseUrl}/mcp`, {
      method: "GET",
      headers: { Authorization: "Bearer bad_invalid_token" },
    });
    expect(res.status).toBe(401);
    const authHeader = res.headers.get("www-authenticate");
    expect(authHeader).toContain(`error="invalid_token"`);
  });

  it("should return 200 JSON on GET /mcp with valid Bearer token and Accept: application/json (not hang in SSE)", async () => {
    const res = await fetch(`${authBaseUrl}/mcp`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${validBearerToken}`,
        Accept: "application/json",
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.service).toBe("mctl-alice");
    expect(data.endpoint).toBe("/mcp");
    expect(data.status).toBe("ready");
  });

  it("should succeed with POST /mcp using valid Bearer token", async () => {
    const res = await fetch(`${authBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${validBearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/list",
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(42);
    expect(data.result.tools).toBeDefined();
  });

  it("should return 401 on unauthenticated /api/devices when authRequired: true", async () => {
    const res = await fetch(`${authBaseUrl}/api/devices`);
    expect(res.status).toBe(401);
  });

  it("should keep /api/info, /.well-known/*, and / public even when authRequired: true", async () => {
    const infoRes = await fetch(`${authBaseUrl}/api/info`);
    expect(infoRes.status).toBe(200);

    const prmRes = await fetch(`${authBaseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(prmRes.status).toBe(200);

    const asmRes = await fetch(`${authBaseUrl}/.well-known/oauth-authorization-server`);
    expect(asmRes.status).toBe(200);

    const landingRes = await fetch(`${authBaseUrl}/`);
    expect(landingRes.status).toBe(200);
  });

  it("should complete full Codex MCP OAuth login flow and authenticate /mcp tool call", async () => {
    // 1. Initial unauthenticated probe
    const probeRes = await fetch(`${authBaseUrl}/mcp`);
    expect(probeRes.status).toBe(401);
    expect(probeRes.headers.get("www-authenticate")).toContain("resource_metadata");

    // 2. Discover metadata
    const asmRes = await fetch(`${authBaseUrl}/.well-known/oauth-authorization-server`);
    const asm = await asmRes.json();
    expect(asm.authorization_endpoint).toBe(`${authBaseUrl}/oauth/authorize`);
    expect(asm.token_endpoint).toBe(`${authBaseUrl}/oauth/token`);

    // 3. Codex authorization request with PKCE S256
    const codeVerifier = "N4wX_m9vK27uhbUJU1p1r_wW1gFWFOEjXkdBjftJeZ4";
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const codexClientId = "https://chatgpt.com/oauth/codex/client.json";
    const redirectUri = "http://127.0.0.1:50780/callback";
    const clientState = "codex_state_nonce_123";

    const authUrl = `${authBaseUrl}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(codexClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${clientState}&scope=iot%3Aview+iot%3Acontrol`;
    const consentRes = await fetch(authUrl);
    expect(consentRes.status).toBe(200);
    const html = await consentRes.text();
    expect(html).toContain("Codex");
    expect(html).toContain("iot:view");
    expect(html).toContain("iot:control");

    // Extract session_id
    const match = html.match(/name="session_id"\s+value="([^"]+)"/);
    expect(match).not.toBeNull();
    const sessionId = match![1];

    // 4. User clicks [Разрешить доступ]
    const approveRes = await fetch(`${authBaseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `session_id=${encodeURIComponent(sessionId)}&action=approve`,
      redirect: "manual",
    });

    expect(approveRes.status).toBe(302);
    const redirectLocation = approveRes.headers.get("location")!;
    const callbackUrl = new URL(redirectLocation);
    expect(callbackUrl.origin).toBe("http://127.0.0.1:50780");
    expect(callbackUrl.searchParams.get("state")).toBe(clientState);
    expect(callbackUrl.searchParams.get("iss")).toBe(authBaseUrl);
    const authCode = callbackUrl.searchParams.get("code")!;
    expect(authCode).toMatch(/^code_/);

    // 5. Codex exchanges authorization code for Bearer token
    const tokenRes = await fetch(`${authBaseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        client_id: codexClientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }).toString(),
    });

    expect(tokenRes.status).toBe(200);
    const tokenData = await tokenRes.json();
    expect(tokenData.access_token).toMatch(/^mctl_at_/);
    expect(tokenData.token_type).toBe("Bearer");
    expect(tokenData.expires_in).toBeGreaterThan(0);

    // 6. Codex makes authenticated MCP tool call
    const mcpRes = await fetch(`${authBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 101,
        method: "tools/list",
      }),
    });

    expect(mcpRes.status).toBe(200);
    const mcpData = await mcpRes.json();
    expect(mcpData.id).toBe(101);
    expect(mcpData.result.tools).toBeDefined();
    expect(Array.isArray(mcpData.result.tools)).toBe(true);
  });
});
