import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { UpstreamCancelledError, UpstreamTimeoutError, upstreamFetch } from "../src/client/upstream.js";
import {
  authFailures, createMetricsServer, httpRequests, listenMetrics, metricsPortFromEnv, rateLimited, recordHttpRequest, renderMetrics, routeTemplate,
  upstreamDuration, upstreamLabel, upstreamRequests,
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

  it("never resolves an inherited property as an upstream label", () => {
    expect(upstreamLabel("Yandex Quasar")).toBe("quasar");
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(upstreamLabel(name), name).toBe("other");
    expect(() => renderMetrics()).not.toThrow();
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

  it("keys a series by its label set, not by property order", () => {
    const before = httpRequests.get({ route: "/about", method: "GET", status_class: "2xx" });
    httpRequests.inc({ status_class: "2xx", method: "GET", route: "/about" });
    expect(httpRequests.get({ route: "/about", method: "GET", status_class: "2xx" })).toBe(before + 1);
    expect(renderMetrics().split("\n").filter((l) => l.startsWith("mctl_alice_http_requests_total") && l.includes('route="/about"'))).toHaveLength(1);
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

  it("counts a call stopped by the caller's own signal as cancelled, not as an upstream timeout", async () => {
    const count = (outcome: string) => upstreamRequests.get({ upstream: "quasar", outcome });
    const timeout = count("timeout"), cancelled = count("cancelled");
    vi.stubGlobal("fetch", (_i: unknown, init?: RequestInit) => new Promise<Response>((_r, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    await expect(upstreamFetch("https://example.test/", {}, { upstream: "Yandex Quasar", timeoutMs: 10_000, signal: AbortSignal.timeout(20) }))
      .rejects.toBeInstanceOf(UpstreamCancelledError);
    expect([count("timeout") - timeout, count("cancelled") - cancelled]).toEqual([0, 1]);
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

describe("/metrics listener", () => {
  const servers: http.Server[] = [];
  afterAll(async () => {
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is off unless METRICS_PORT is a valid port", () => {
    vi.stubEnv("METRICS_PORT", "");
    expect(metricsPortFromEnv()).toBeNull();
    vi.stubEnv("METRICS_PORT", "nope");
    expect(metricsPortFromEnv()).toBeNull();
    vi.stubEnv("METRICS_PORT", "70000");
    expect(metricsPortFromEnv()).toBeNull();
    vi.stubEnv("METRICS_PORT", "9464");
    expect(metricsPortFromEnv()).toBe(9464);
    vi.stubEnv("METRICS_PORT", " 9464 ");
    expect(metricsPortFromEnv()).toBe(9464);
    for (const junk of ["9464x", "9464 # scrape", "94.5", "0x24e8"]) {
      vi.stubEnv("METRICS_PORT", junk);
      expect(metricsPortFromEnv(), junk).toBeNull();
    }
  });

  it("logs a bind failure instead of crashing the process", async () => {
    const taken = http.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    servers.push(taken);
    const port = (taken.address() as import("node:net").AddressInfo).port;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const metrics = listenMetrics(port, "127.0.0.1");
      await new Promise<void>((resolve) => metrics.once("error", () => resolve()));
      expect(logged.mock.calls.some((args) => String(args[0]).includes(`metrics listener on port ${port} failed`))).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });

  it("serves only GET/HEAD /metrics on its own port; the app port does not serve it", async () => {
    const metrics = createMetricsServer();
    await new Promise<void>((resolve) => metrics.listen(8704, "127.0.0.1", resolve));
    const app = createHttpServer(8705, { publicBaseUrl: "http://127.0.0.1:8705", authRequired: true, enableSampler: false, oauthStorage: new OAuthStorage(":memory:") });
    await new Promise<void>((resolve) => app.listen(8705, "127.0.0.1", resolve));
    servers.push(metrics, app);

    const direct = await realFetch("http://127.0.0.1:8704/metrics");
    expect(direct.status).toBe(200);
    expect(direct.headers.get("content-type")).toContain("text/plain");
    const body = await direct.text();
    expect(body).toMatch(/^mctl_alice_build_info\{version="[^"]+"\} 1$/m);
    expect(body).toContain("# TYPE mctl_alice_upstream_request_duration_seconds histogram");
    expect((await realFetch("http://127.0.0.1:8704/metrics", { method: "HEAD" })).status).toBe(200);
    expect((await realFetch("http://127.0.0.1:8704/metrics", { method: "POST", body: "" })).status).toBe(404);
    expect((await realFetch("http://127.0.0.1:8704/healthz")).status).toBe(404);

    const viaApp = await realFetch("http://127.0.0.1:8705/metrics");
    expect(viaApp.status).toBe(404);
    expect(await viaApp.text()).not.toContain("mctl_alice_");
  });
});

describe("counting over HTTP", () => {
  const servers: { server: http.Server; storage: OAuthStorage }[] = [];

  async function start(port: number, extra: Parameters<typeof createHttpServer>[1] = {}, storage = new OAuthStorage(":memory:")) {
    const server = createHttpServer(port, {
      publicBaseUrl: `http://127.0.0.1:${port}`, enableSampler: false, oauthStorage: storage,
      clientId: "test_client_id", clientSecret: "test_client_secret", ...extra,
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    servers.push({ server, storage });
    return `http://127.0.0.1:${port}`;
  }

  /** Waits for a counter to reach a value: the count happens on the response's close event, after the client has its answer. */
  async function until(read: () => number, expected: number) {
    for (let i = 0; i < 200 && read() !== expected; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(read()).toBe(expected);
  }

  // Outbound Yandex calls answer 500 unless a test says otherwise; the test servers get the real fetch.
  let yandex: (url: string) => Response = () => new Response("{}", { status: 500 });
  beforeAll(() => {
    vi.stubGlobal("fetch", (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.startsWith("http://127.0.0.1") ? realFetch(input, init) : Promise.resolve(yandex(url));
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const { server, storage } of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      storage.close();
    }
  });

  it("counts requests by route template and status class, never by raw path", async () => {
    const base = await start(8701, { authRequired: true });
    const healthz = httpRequests.get({ route: "/healthz", method: "GET", status_class: "2xx" });
    const other = httpRequests.get({ route: "other", method: "GET", status_class: "4xx" });
    await fetch(`${base}/healthz`);
    await fetch(`${base}/no/such/route/y0_secret?code=abc`);
    await until(() => httpRequests.get({ route: "/healthz", method: "GET", status_class: "2xx" }), healthz + 1);
    await until(() => httpRequests.get({ route: "other", method: "GET", status_class: "4xx" }), other + 1);
    const text = renderMetrics();
    expect(text).not.toContain("y0_secret");
    expect(text).not.toContain("code=abc");
  });

  it("counts bearer and token-endpoint failures by reason", async () => {
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
    expect(renderMetrics()).not.toContain("not-a-real-token");
  });

  it("counts insufficient_scope and session_mismatch for real grants", async () => {
    const storage = new OAuthStorage(":memory:");
    const now = Date.now();
    for (const [id, scope] of [["alice", "iot:view iot:control quasar"], ["bob", "iot:view"]] as const) {
      storage.saveUser({ id, yandexUid: id, createdAt: now, updatedAt: now });
      storage.saveUserCredentials(id, { yandexAccessToken: `upstream-${id}`, quasarCookie: `Session_id=${id}` });
      storage.saveToken({ accessToken: `mcp-${id}`, refreshToken: `rt-${id}`, userId: id, clientId: "client", scope, createdAt: now, expiresAt: now + 3600000 });
    }
    const base = await start(8706, { authRequired: true }, storage);
    const scope = authFailures.get({ reason: "insufficient_scope" });
    const mismatch = authFailures.get({ reason: "session_mismatch" });

    // bob holds iot:view only; saying a phrase needs more.
    const say = await fetch(`${base}/api/say`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer mcp-bob" }, body: JSON.stringify({ text: "hi" }) });
    expect(say.status).toBe(403);
    expect(authFailures.get({ reason: "insufficient_scope" })).toBe(scope + 1);

    const abort = new AbortController();
    const sse = await fetch(`${base}/sse`, { signal: abort.signal, headers: { Authorization: "Bearer mcp-alice", Accept: "text/event-stream" } });
    const reader = sse.body!.getReader();
    const session = /sessionId=([^\s]+)/.exec(new TextDecoder().decode((await reader.read()).value))![1];
    const post = await fetch(`${base}/messages?sessionId=${session}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer mcp-bob" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(post.status).toBe(401);
    expect(authFailures.get({ reason: "session_mismatch" })).toBe(mismatch + 1);
    abort.abort(); await reader.cancel().catch(() => {});
  });

  it("counts a forged sign-in state and a failed Yandex code exchange", async () => {
    const base = await start(8707, { authRequired: true });
    const state = authFailures.get({ reason: "login_state" });
    const failed = authFailures.get({ reason: "login_failed" });

    expect((await fetch(`${base}/auth/callback?code=abc&state=forged`, { redirect: "manual" })).status).toBe(400);
    expect(authFailures.get({ reason: "login_state" })).toBe(state + 1);

    // A real sign-in whose code exchange Yandex answers with 500.
    yandex = () => new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
    const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
    const loginState = new URL(login.headers.get("location")!).searchParams.get("state");
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const callback = await fetch(`${base}/auth/callback?code=abc&state=${loginState}`, { redirect: "manual", headers: { Cookie: cookie } });
    expect(callback.status).toBe(500);
    expect(authFailures.get({ reason: "login_failed" })).toBe(failed + 1);
    expect(authFailures.get({ reason: "login_state" })).toBe(state + 1);
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
