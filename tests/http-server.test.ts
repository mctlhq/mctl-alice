import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createHttpServer } from "../src/server/http-server.js";
import { getOpenApiSpec } from "../src/server/openapi.js";

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

  it("should serve landing page HTML at GET /", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("mctl-alice");
    expect(text).toContain("BETA");
    expect(text).toContain("alice_send_command");
    expect(text).toContain("Quasar Cookie");
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

  it("should serve Quasar cookie configuration page at /auth/cookie", async () => {
    const res = await fetch(`${baseUrl}/auth/cookie`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("mctl-alice — Настройка Quasar");
    expect(html).toContain("Session_id");
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

  it("should redirect to Yandex OAuth on /oauth/authorize", async () => {
    const res = await fetch(
      `${baseUrl}/oauth/authorize?client_id=test_client&redirect_uri=https://chatgpt.com/callback&response_type=code&state=xyz`,
      { redirect: "manual" }
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("https://oauth.yandex.ru/authorize");
    expect(location).toContain("redirect_uri=");
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

  it("should handle ChatGPT OAuth session on /auth/callback", async () => {
    // 1. Initiate authorization to create pending session
    const authRes = await fetch(
      `${baseUrl}/oauth/authorize?client_id=test_client&redirect_uri=https://chatgpt.com/callback&response_type=code&state=client_state_val`,
      { redirect: "manual" }
    );
    expect(authRes.status).toBe(302);
    const yandexUrl = new URL(authRes.headers.get("location")!);
    const sessionState = yandexUrl.searchParams.get("state")!;
    expect(sessionState).toBeDefined();

    // 2. Simulate Yandex callback to /auth/callback (e.g. user denied or returned error)
    const callbackRes = await fetch(
      `${baseUrl}/auth/callback?state=${sessionState}&error=access_denied&error_description=User+denied`,
      { redirect: "manual" }
    );
    expect(callbackRes.status).toBe(302);
    const clientRedirect = new URL(callbackRes.headers.get("location")!);
    expect(clientRedirect.origin).toBe("https://chatgpt.com");
    expect(clientRedirect.pathname).toBe("/callback");
    expect(clientRedirect.searchParams.get("error")).toBe("access_denied");
    expect(clientRedirect.searchParams.get("state")).toBe("client_state_val");
    expect(clientRedirect.searchParams.get("iss")).toBe(baseUrl);
  });

  it("should handle Claude.ai MCP OAuth authorization on /oauth/authorize", async () => {
    const res = await fetch(
      `${baseUrl}/oauth/authorize?response_type=code&client_id=https%3A%2F%2Fclaude.ai%2Foauth%2Fmcp-oauth-client-metadata&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=test&code_challenge_method=S256&state=claude_state_test`,
      { redirect: "manual" }
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("https://oauth.yandex.ru/authorize");
  });
});
