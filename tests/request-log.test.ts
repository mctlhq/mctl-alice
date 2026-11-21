import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import { createHttpServer } from "../src/server/http-server.js";
import { requestId, toolLabel, uaFamily } from "../src/log.js";
import { QuasarClient } from "../src/client/quasar-client.js";
import { userRef } from "../src/client/upstream.js";

describe("log helpers", () => {
  it("uses a plain cf-ray and refuses anything else", () => {
    expect(requestId("8a1b2c3d4e5f6789-FRA")).toBe("8a1b2c3d4e5f6789-FRA");
    for (const bad of ["has space", "new\nline", "x".repeat(65), "", undefined, 42, '"quoted"']) {
      const id = requestId(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("reduces a User-Agent to its product token", () => {
    expect(uaFamily("codex-mcp-client/0.163.0-alpha.11.1")).toBe("codex-mcp-client");
    expect(uaFamily("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe("Mozilla");
    expect(uaFamily("node")).toBe("node");
    expect(uaFamily(undefined)).toBe("none");
    expect(uaFamily("/weird")).toBe("other");
    expect(uaFamily("a".repeat(80) + "/1")).toBe("other");
  });

  it("logs only registered tool names", () => {
    expect(toolLabel("alice_list_devices")).toBe("alice_list_devices");
    expect(toolLabel("<script>")).toBe("unknown");
    expect(toolLabel(undefined)).toBe("unknown");
  });
});

describe("request log", () => {
  let server: http.Server;
  let port = 0;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    server = createHttpServer(0, { publicBaseUrl: "http://localhost", enableSampler: false });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as import("node:net").AddressInfo).port;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  afterEach(() => spy?.mockRestore());

  const json = (): any[] => spy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
  // The line is written from the response's "close" event, a tick after the client has the body.
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { headers });

  it("writes one JSON line per request with status, duration and a route template", async () => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await get("/openapi.json", { "user-agent": "codex-mcp-client/0.163.0" });
    await res.text(); await settle();
    const lines = json().filter((l) => l.msg === "http");
    expect(lines).toHaveLength(1);
    const l = lines[0];
    expect(l).toMatchObject({ level: "info", method: "GET", route: "/openapi.json", status: 200, aborted: false, ua: "codex-mcp-client" });
    expect(typeof l.duration_ms).toBe("number");
    expect(typeof l.ts).toBe("string");
    expect(l.request_id).toBe(res.headers.get("x-request-id"));
  });

  it("does not log the raw path, query or user agent version", async () => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await get("/no/such/page?token=SECRET123", { "user-agent": "evil/9.9.9 SECRET456" });
    await res.text(); await settle();
    const raw = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(raw).not.toMatch(/SECRET|no\/such|9\.9\.9/);
    expect(json().find((l) => l.msg === "http")).toMatchObject({ route: "other", status: 404, ua: "evil" });
  });

  it("stays quiet for probes and scrapes", async () => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const p of ["/healthz", "/readyz", "/metrics"]) await (await get(p)).text();
    await settle();
    expect(json().filter((l) => l.msg === "http")).toHaveLength(0);
  });

  it("reuses a valid cf-ray and replaces a hostile one", async () => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ok = await get("/openapi.json", { "cf-ray": "8a1b2c3d4e5f6789-FRA" });
    await ok.text();
    expect(ok.headers.get("x-request-id")).toBe("8a1b2c3d4e5f6789-FRA");
    const bad = await get("/openapi.json", { "cf-ray": "x y;z" });
    await bad.text(); await settle();
    expect(bad.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(json().filter((l) => l.msg === "http").map((l) => l.request_id)).toContain("8a1b2c3d4e5f6789-FRA");
  });

  it("logs a tool call with the tool name, outcome and the request id, never the arguments", async () => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "not_a_tool<x>", arguments: { secret: "ARGSECRET" } } });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-ray": "abc123-AMS" }, body,
    });
    await res.text(); await settle();
    const raw = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(raw).not.toMatch(/ARGSECRET|not_a_tool/);
    const tool = json().find((l) => l.msg === "tool_call");
    expect(tool).toMatchObject({ tool: "unknown", is_error: true, request_id: "abc123-AMS" });
    expect(typeof tool.duration_ms).toBe("number");
    expect(json().find((l) => l.msg === "http")).toMatchObject({ route: "/mcp", request_id: "abc123-AMS" });
  });
});

describe("Quasar failure log", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("carries the user tag instead of user=-", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) })));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new QuasarClient({ credentialsMode: "hosted", cookie: "c", userId: "usr_1", useKeychain: false, persistEnv: false } as any);
    await expect((client as any).fetchQuasar("https://iot.quasar.yandex.ru/x", {})).rejects.toThrow();
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[upstream-failure]"))!;
    expect(line).toContain('upstream="Yandex Quasar"');
    expect(line).toContain(`user=${userRef("usr_1")}`);
    expect(line).not.toContain("user=-");
    expect(line).not.toContain("usr_1");
  });
});
