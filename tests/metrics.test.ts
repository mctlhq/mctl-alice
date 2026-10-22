import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { UpstreamTimeoutError, upstreamFetch } from "../src/client/upstream.js";
import {
  authFailures, httpRequests, rateLimited, recordHttpRequest, renderMetrics, routeTemplate, upstreamDuration, upstreamRequests,
} from "../src/metrics.js";

const realFetch = globalThis.fetch;

describe("label values stay bounded", () => {
  it("maps known routes to themselves and everything else to a fixed value", () => {
    expect(routeTemplate("/mcp")).toBe("/mcp");
    expect(routeTemplate("/oauth/token")).toBe("/oauth/token");
    expect(routeTemplate("/assets/app.3f9c.js")).toBe("/assets/*");
    expect(routeTemplate("/api/devices/secret-device-id")).toBe("other");
    expect(routeTemplate("/y0_AgAAAAB-looks-like-a-token")).toBe("other");
  });

  it("drops the query string and never renders a raw path", () => {
    const before = httpRequests.get({ route: "/mcp", method: "POST", status_class: "2xx" });
    recordHttpRequest("/mcp?access_token=SECRET123", "POST", 200, true);
    recordHttpRequest("/SECRET456/x", "BREW", 200, true);
    expect(httpRequests.get({ route: "/mcp", method: "POST", status_class: "2xx" })).toBe(before + 1);
    expect(httpRequests.get({ route: "other", method: "other", status_class: "2xx" })).toBeGreaterThan(0);
    const text = renderMetrics();
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("BREW");
  });

  it("counts a response closed before its headers as aborted", () => {
    const before = httpRequests.get({ route: "/sse", method: "GET", status_class: "aborted" });
    recordHttpRequest("/sse", "GET", 200, false);
    expect(httpRequests.get({ route: "/sse", method: "GET", status_class: "aborted" })).toBe(before + 1);
  });
});

describe("upstream calls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("counts each outcome per upstream and observes latency", async () => {
    const count = (outcome: string) => upstreamRequests.get({ upstream: "quasar", outcome });
    const ok = count("ok"), s5 = count("5xx"), s4 = count("4xx"), err = count("error"), timeout = count("timeout");
    const observed = upstreamDuration.count({ upstream: "quasar" });
    const opts = { upstream: "Yandex Quasar", timeoutMs: 30 };

    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    await upstreamFetch("https://example.test/", {}, opts);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    await upstreamFetch("https://example.test/", {}, opts);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    await upstreamFetch("https://example.test/", {}, opts);
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    await expect(upstreamFetch("https://example.test/", {}, opts)).rejects.toThrow("fetch failed");
    vi.stubGlobal("fetch", (_i: unknown, init?: RequestInit) => new Promise<Response>((_r, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    await expect(upstreamFetch("https://example.test/", {}, opts)).rejects.toBeInstanceOf(UpstreamTimeoutError);

    expect([count("ok") - ok, count("5xx") - s5, count("4xx") - s4, count("error") - err, count("timeout") - timeout])
      .toEqual([1, 1, 1, 1, 1]);
    expect(upstreamDuration.count({ upstream: "quasar" })).toBe(observed + 5);
  });

  it("counts a body that fails to parse as an error, not as ok", async () => {
    const ok = upstreamRequests.get({ upstream: "iot", outcome: "ok" });
    const err = upstreamRequests.get({ upstream: "iot", outcome: "error" });
    vi.stubGlobal("fetch", async () => new Response("not json", { status: 200 }));
    await expect(upstreamFetch("https://example.test/", {}, { upstream: "Yandex IoT" }, (r) => r.json())).rejects.toThrow();
    expect(upstreamRequests.get({ upstream: "iot", outcome: "ok" })).toBe(ok);
    expect(upstreamRequests.get({ upstream: "iot", outcome: "error" })).toBe(err + 1);
  });

  it("labels an unknown upstream name as other", async () => {
    const before = upstreamRequests.get({ upstream: "other", outcome: "ok" });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    await upstreamFetch("https://example.test/", {}, { upstream: "Somewhere else" });
    expect(upstreamRequests.get({ upstream: "other", outcome: "ok" })).toBe(before + 1);
  });
});

describe("/metrics over HTTP", () => {
  const servers: { server: http.Server; storage: OAuthStorage }[] = [];

  async function start(port: number, extra: Parameters<typeof createHttpServer>[1] = {}) {
    const storage = new OAuthStorage(":memory:");
    const server = createHttpServer(port, { publicBaseUrl: `http://127.0.0.1:${port}`, enableSampler: false, oauthStorage: storage, ...extra });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    servers.push({ server, storage });
    return `http://127.0.0.1:${port}`;
  }

  /** Lets the response's close event, which does the counting, run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeAll(() => {
    vi.stubGlobal("fetch", (input: any, init?: any) => {
      const url = String(input);
      return url.startsWith("http://127.0.0.1") ? realFetch(input, init) : Promise.resolve(new Response("{}", { status: 500 }));
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const { server, storage } of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      storage.close();
    }
  });

  it("serves the exposition to a direct scrape and refuses anything that came through a proxy", async () => {
    const base = await start(8700, { authRequired: true });
    const direct = await fetch(`${base}/metrics`);
    expect(direct.status).toBe(200);
    expect(direct.headers.get("content-type")).toContain("text/plain");
    const body = await direct.text();
    expect(body).toMatch(/^mctl_alice_build_info\{version="[^"]+"\} 1$/m);
    expect(body).toContain("# TYPE mctl_alice_upstream_request_duration_seconds histogram");

    for (const header of ["X-Forwarded-For", "X-Real-IP", "Forwarded", "CF-Connecting-IP", "X-Forwarded-Host"]) {
      const proxied = await fetch(`${base}/metrics`, { headers: { [header]: "203.0.113.7" } });
      expect(proxied.status, header).toBe(404);
      expect(await proxied.text(), header).not.toContain("mctl_alice_");
    }
    expect((await fetch(`${base}/metrics`, { method: "POST", body: "" })).status).toBe(404);
  });

  it("counts requests by route template and status class", async () => {
    const base = await start(8701, { authRequired: true });
    const healthz = httpRequests.get({ route: "/healthz", method: "GET", status_class: "2xx" });
    const other = httpRequests.get({ route: "other", method: "GET", status_class: "4xx" });
    await fetch(`${base}/healthz`);
    await fetch(`${base}/no/such/route/y0_secret?code=abc`);
    await settle();
    expect(httpRequests.get({ route: "/healthz", method: "GET", status_class: "2xx" })).toBe(healthz + 1);
    expect(httpRequests.get({ route: "other", method: "GET", status_class: "4xx" })).toBe(other + 1);
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).not.toContain("y0_secret");
    expect(text).not.toContain("code=abc");
  });

  it("counts bearer, token-endpoint and scope failures by reason", async () => {
    const base = await start(8702, { authRequired: true });
    const reasons = ["missing_token", "malformed", "invalid_token", "cookie_header", "token_invalid_grant"];
    const before = Object.fromEntries(reasons.map((r) => [r, authFailures.get({ reason: r })]));
    const mcp = (headers: Record<string, string>) =>
      fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" });

    expect((await mcp({})).status).toBe(401);
    expect((await mcp({ Authorization: "Basic abc" })).status).toBe(401);
    expect((await mcp({ Authorization: "Bearer not-a-real-token" })).status).toBe(401);
    expect((await mcp({ Authorization: "Bearer x", "X-Yandex-Cookie": "Session_id=x" })).status).toBe(401);
    const token = await fetch(`${base}/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=nope&code_verifier=" + "a".repeat(43),
    });
    expect(token.status).toBe(400);

    for (const r of reasons) expect(authFailures.get({ reason: r }) - before[r], r).toBe(1);
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).not.toContain("not-a-real-token");
  });

  it("counts 429 answers by bucket", async () => {
    const base = await start(8703, { authRequired: true, rateLimits: { register: 1 } });
    const before = rateLimited.get({ bucket: "register" });
    const register = () => fetch(`${base}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await register();
    expect((await register()).status).toBe(429);
    expect((await register()).status).toBe(429);
    expect(rateLimited.get({ bucket: "register" })).toBe(before + 2);
  });
});
