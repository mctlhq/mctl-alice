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
});
