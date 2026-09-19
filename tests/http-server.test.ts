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
});
