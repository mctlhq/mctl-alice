import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { PublicStatsCache } from "../src/server/public-stats.js";
import { createHttpServer } from "../src/server/http-server.js";
import { utcDay } from "../src/storage/storage-interface.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1, 12);

const newStorage = () => new OAuthStorage(":memory:");
const addUser = (st: OAuthStorage, id: string, withCreds = true) => {
  st.saveUser({ id, yandexUid: `uid-${id}`, createdAt: T0, updatedAt: T0 });
  if (withCreds) st.saveUserCredentials(id, { yandexAccessToken: "tok" });
};

describe("usage totals", () => {
  it("counts calls, connected accounts and 30-day active users", () => {
    const st = newStorage();
    addUser(st, "a"); addUser(st, "b"); addUser(st, "c", false); addUser(st, "d");
    st.saveClient({ clientId: "k1", clientName: "ChatGPT", redirectUris: [], createdAt: T0 });
    st.saveClient({ clientId: "k2", clientName: "Claude", redirectUris: [], createdAt: T0 });
    st.saveClient({ clientId: "k3", clientName: "OpenClaw MCP", redirectUris: [], createdAt: T0 });
    const tok = (n: string, client: string, user: string) => st.saveToken({ accessToken: n, clientId: client, userId: user, yandexAccessToken: "y", scope: "x", createdAt: T0, expiresAt: T0 + 1 });
    tok("t1", "k1", "a"); tok("t2", "k2", "a"); tok("t3", "k3", "b"); tok("t4", "k1", "c");
    // "d" holds credentials but never connected a client: not counted. "c" has no credentials: not counted.
    st.recordToolCall("a", T0); st.recordToolCall("a", T0); st.recordToolCall("b", T0 - 29 * DAY);
    st.recordToolCall("c", T0 - 30 * DAY); // day 31 back: not active in the window
    expect(st.getUsageTotals(T0)).toEqual({ toolCalls: 4, connectedAccounts: 2, activeUsers30d: 2, assistants: { chatgpt: 1, claude: 1, other: 1 } });
    expect(utcDay(T0 - 29 * DAY)).toBe(utcDay(T0) - 29);
  });

  it("deleting a user removes their counters", () => {
    const st = newStorage();
    addUser(st, "a"); st.recordToolCall("a", T0);
    st.deleteUser("a");
    expect(st.getUsageTotals(T0)).toEqual({ toolCalls: 0, connectedAccounts: 0, activeUsers30d: 0, assistants: { chatgpt: 0, claude: 0, other: 0 } });
  });
});

describe("PublicStatsCache", () => {
  it("is empty until a sample succeeds and keeps the last snapshot when a sample fails", async () => {
    let fail = false;
    const storage = { getUsageTotals: async () => { if (fail) throw new Error("db down"); return { toolCalls: 5, connectedAccounts: 2, activeUsers30d: 1, assistants: { chatgpt: 1, claude: 1, other: 0 } }; } } as any;
    const cache = new PublicStatsCache(storage, () => 7);
    expect(cache.snapshot()).toBeNull();
    await cache.sample();
    expect(cache.snapshot()).toMatchObject({ toolCalls: 5, sessionsOnline: 7 });
    fail = true;
    await cache.sample();
    expect(cache.snapshot()).toMatchObject({ toolCalls: 5 });
  });

  it("never stores a snapshot when the first sample fails", async () => {
    const cache = new PublicStatsCache({ getUsageTotals: async () => { throw new Error("x"); } } as any, () => 0);
    await cache.sample();
    expect(cache.snapshot()).toBeNull();
  });
});

describe("GET /api/stats", () => {
  let server: http.Server; let base = "";
  const start = async () => {
    server = createHttpServer(0, { publicBaseUrl: "http://localhost", enableSampler: false });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  };
  afterEach(async () => { delete process.env.PUBLIC_STATS_REFRESH_MS; server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });

  it("answers 503 before any sample, never a zero-filled body", async () => {
    await start();
    const res = await fetch(`${base}/api/stats`);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(await res.json()).toEqual({ error: "stats_unavailable" });
  });

  it("serves aggregates only, publicly cacheable, once sampled", async () => {
    process.env.PUBLIC_STATS_REFRESH_MS = "60000";
    await start();
    let body: any = null; let status = 0;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${base}/api/stats`);
      status = res.status;
      if (status === 200) { body = await res.json(); expect(res.headers.get("cache-control")).toContain("public"); break; }
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["activeUsers30d", "assistants", "connectedAccounts", "sampledAt", "sessionsOnline", "toolCalls"]);
  });
});

describe("recording a hosted tool call", () => {
  let storage: OAuthStorage; let server: http.Server; let port = 0;
  const rpc = (name: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
  const post = async (body: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer tok_a" } });
    return res.text();
  };

  beforeAll(async () => {
    storage = newStorage(); addUser(storage, "usr_a");
    storage.saveToken({ accessToken: "tok_a", refreshToken: "rt_a", clientId: "c", userId: "usr_a", yandexAccessToken: "y_a",
      scope: "iot:view iot:control", createdAt: Date.now(), expiresAt: Date.now() + 3_600_000 });
    server = createHttpServer(0, { publicBaseUrl: "http://localhost", authRequired: true, oauthStorage: storage, enableSampler: false });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as import("node:net").AddressInfo).port;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });

  it("counts a successful call and ignores a failed one", async () => {
    const realFetch = globalThis.fetch;
    const yandex = (ok: boolean) => vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
      return ok ? new Response(JSON.stringify({ status: "ok", rooms: [], devices: [], scenarios: [] })) : new Response("{}", { status: 500 });
    });

    yandex(true);
    expect(await post(rpc("alice_list_devices"))).toContain('"result"');
    await vi.waitFor(() => expect(storage.getUsageTotals().toolCalls).toBe(1));

    vi.restoreAllMocks(); yandex(false);
    await post(rpc("alice_list_devices"));
    await new Promise((r) => setTimeout(r, 100));
    expect(storage.getUsageTotals().toolCalls).toBe(1);
    vi.restoreAllMocks();
  });
});
