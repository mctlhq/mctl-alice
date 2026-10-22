import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { RateLimiter, clientAddress, rateLimitBucket } from "../src/server/rate-limit.js";

describe("RateLimiter", () => {
  it("allows the budget, then denies with a positive Retry-After, then recovers", () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 });
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(limiter.hit("a", t0 + i).allowed).toBe(true);
    const denied = limiter.hit("a", t0 + 10);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(limiter.hit("b", t0 + 10).allowed).toBe(true);
    expect(limiter.hit("a", t0 + 3 * 60_000).allowed).toBe(true);
  });

  it("keeps the number of keys bounded", () => {
    const limiter = new RateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) limiter.hit(`k${i}`, 1_000_000 + i);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it("evicts expired entries before the least recently used live one", () => {
    const limiter = new RateLimiter({ limit: 5, windowMs: 1000, maxKeys: 2 });
    // "expired" was used more recently than "live", but its window started 2+ windows ago.
    limiter.hit("expired", 0);
    limiter.hit("live", 500);
    limiter.hit("expired", 900);
    limiter.hit("new", 2100);
    expect(limiter.has("live")).toBe(true);
    expect(limiter.has("expired")).toBe(false);
    expect(limiter.size).toBe(2);
  });
});

describe("route buckets and client address", () => {
  it("maps routes, and never limits health checks", () => {
    expect(rateLimitBucket("/healthz", "GET")).toBeNull();
    expect(rateLimitBucket("/readyz", "GET")).toBeNull();
    expect(rateLimitBucket("/oauth/register", "POST")).toBe("register");
    expect(rateLimitBucket("/auth/qr-code", "GET")).toBe("qr");
    expect(rateLimitBucket("/auth/save-cookie", "POST")).toBe("login");
    expect(rateLimitBucket("/account/delete", "POST")).toBe("account");
    expect(rateLimitBucket("/account", "GET")).toBeNull();
    expect(rateLimitBucket("/api/say", "POST")).toBe("mcp");
    expect(rateLimitBucket("/mcp/messages", "POST")).toBe("mcp");
    expect(rateLimitBucket("/", "GET")).toBeNull();
    expect(rateLimitBucket("/", "POST")).toBe("mcp");
  });

  it("takes the N-th X-Forwarded-For entry from the right only when trusted", () => {
    const req = { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" }, socket: { remoteAddress: "9.9.9.9" } } as any;
    expect(clientAddress(req, 0)).toBe("9.9.9.9");
    expect(clientAddress(req, 1)).toBe("3.3.3.3");
    expect(clientAddress(req, 2)).toBe("2.2.2.2");
    expect(clientAddress(req, 5)).toBe("9.9.9.9");
  });

  it("prefers a configured single-valued client IP header", () => {
    const req = (h: Record<string, unknown>) => ({ headers: { "x-forwarded-for": "3.3.3.3", ...h }, socket: { remoteAddress: "9.9.9.9" } }) as any;
    expect(clientAddress(req({ "cf-connecting-ip": "4.4.4.4" }), 0, "cf-connecting-ip")).toBe("4.4.4.4");
    expect(clientAddress(req({ "cf-connecting-ip": "4.4.4.4" }), 0, "")).toBe("9.9.9.9");
    expect(clientAddress(req({}), 1, "cf-connecting-ip")).toBe("3.3.3.3");
    expect(clientAddress(req({ "cf-connecting-ip": "4.4.4.4, 5.5.5.5" }), 0, "cf-connecting-ip")).toBe("9.9.9.9");
    expect(clientAddress(req({ "cf-connecting-ip": "  " }), 0, "cf-connecting-ip")).toBe("9.9.9.9");
  });
});

describe("rate limits over HTTP", () => {
  const realFetch = globalThis.fetch;
  const servers: { server: http.Server; storage: OAuthStorage }[] = [];

  // Ephemeral ports, so parallel test files cannot collide.
  async function start(extra: Parameters<typeof createHttpServer>[1] = {}) {
    const storage = new OAuthStorage(":memory:");
    const server = createHttpServer(0, { publicBaseUrl: "http://127.0.0.1", authRequired: false, enableSampler: false, oauthStorage: storage, ...extra });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push({ server, storage });
    return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  }

  beforeAll(() => {
    // Anything that is not this test server must not reach Yandex.
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

  it("answers 429 with Retry-After once a bucket is over budget", async () => {
    const base = await start({ rateLimits: { register: 2, token: 2, authorize: 2, login: 2, qr: 2, qrstatus: 2, account: 2, mcp: 2 } });
    const post = (p: string) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: "{}", redirect: "manual" });
    const get = (p: string) => fetch(base + p, { redirect: "manual" });
    const cases: [string, () => Promise<Response>][] = [
      ["/oauth/register", () => post("/oauth/register")],
      ["/oauth/token", () => post("/oauth/token")],
      ["/oauth/authorize POST", () => post("/oauth/authorize")],
      ["/oauth/authorize GET", () => get("/oauth/authorize")],
      ["/auth/login", () => get("/auth/login")],
      ["/auth/qr-code", () => get("/auth/qr-code")],
      ["/account/revoke-grant", () => post("/account/revoke-grant")],
      ["/mcp", () => post("/mcp")],
      ["/api/say", () => post("/api/say")],
    ];
    // authorize POST and GET share a bucket; give each case its own by order.
    const seen = new Set<string>();
    for (const [name, call] of cases) {
      const bucketKey = name.split(" ")[0] === "/oauth/authorize" ? "authorize" : name === "/api/say" || name === "/mcp" ? "mcp" : name;
      if (seen.has(bucketKey)) continue;
      seen.add(bucketKey);
      expect((await call()).status, name).not.toBe(429);
      expect((await call()).status, name).not.toBe(429);
      const limited = await call();
      expect(limited.status, name).toBe(429);
      expect(Number(limited.headers.get("retry-after")), name).toBeGreaterThan(0);
      expect(limited.headers.get("cache-control")).toBe("no-store");
    }
    // /oauth/revoke shares the token bucket, which /oauth/token already exhausted.
    expect((await post("/oauth/revoke")).status).toBe(429);
    // Every account action shares one bucket, which /account/revoke-grant already exhausted.
    expect((await post("/account/delete")).status).toBe(429);
    // /api/* shares the MCP bucket, which is already exhausted.
    expect((await post("/api/say")).status).toBe(429);
    // The shared authorize bucket also limits the other method.
    expect((await post("/oauth/authorize")).status).toBe(429);
    // The MCP POST gets a JSON-RPC error body.
    expect((await (await post("/mcp")).json()).error.code).toBe(-32029);
  });

  it("never limits /healthz or /readyz", async () => {
    const base = await start({ rateLimits: { register: 1, token: 1, authorize: 1, login: 1, qr: 1, qrstatus: 1, account: 1, mcp: 1 } });
    for (let i = 0; i < 20; i++) expect((await fetch(`${base}/healthz`)).status).toBe(200);
    for (let i = 0; i < 20; i++) expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it("lets back-to-back /readyz probes share one storage round-trip", async () => {
    const base = await start();
    const getUser = vi.spyOn(servers[servers.length - 1].storage, "getUser");
    const answers = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/readyz`)));
    for (let i = 0; i < 20; i++) answers.push(await fetch(`${base}/readyz`));
    expect(answers.every((r) => r.status === 200)).toBe(true);
    expect(getUser.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("cannot be bypassed by rotating bearer tokens", async () => {
    const base = await start({ rateLimits: { mcp: 2 } });
    const call = (token: string) => fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: "{}" });
    await call("token-a"); await call("token-b");
    expect((await call("token-c")).status).toBe(429);
  });

  it("polling /auth/qr-status does not exhaust the login bucket", async () => {
    const base = await start({ rateLimits: { login: 2, qrstatus: 50 } });
    for (let i = 0; i < 30; i++) await fetch(`${base}/auth/qr-status`);
    expect((await fetch(`${base}/auth/callback`)).status).not.toBe(429);
  });

  it("separates clients by X-Forwarded-For only when TRUST_PROXY_HOPS is set", async () => {
    const trusted = await start({ rateLimits: { register: 1 }, trustProxyHops: 1 });
    const register = (base: string, ip: string) => fetch(`${base}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: "{}" });
    await register(trusted, "10.0.0.1");
    expect((await register(trusted, "10.0.0.1")).status).toBe(429);
    expect((await register(trusted, "10.0.0.2")).status).not.toBe(429);

    const untrusted = await start({ rateLimits: { register: 1 }, trustProxyHops: 0 });
    await register(untrusted, "10.0.0.1");
    expect((await register(untrusted, "10.0.0.2")).status).toBe(429);
  });

  it("separates clients by CLIENT_IP_HEADER only when it is configured", async () => {
    const register = (base: string, ip: string) => fetch(`${base}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: "{}" });
    const keyed = await start({ rateLimits: { register: 1 }, clientIpHeader: "CF-Connecting-IP" });
    await register(keyed, "198.51.100.1");
    expect((await register(keyed, "198.51.100.1")).status).toBe(429);
    expect((await register(keyed, "198.51.100.2")).status).not.toBe(429);

    const unkeyed = await start({ rateLimits: { register: 1 } });
    await register(unkeyed, "198.51.100.1");
    expect((await register(unkeyed, "198.51.100.2")).status).toBe(429);
  });
});
