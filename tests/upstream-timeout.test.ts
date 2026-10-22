import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import http from "node:http";
import { QuasarClient } from "../src/client/quasar-client.js";
import { exchangeCodeForToken, refreshAccessToken } from "../src/auth/token-storage.js";
import { fetchYandexProfile } from "../src/auth/oauth-helper.js";
import { initQrAuth } from "../src/auth/yandex-qr-auth.js";
import { UpstreamError, UpstreamTimeoutError, sanitizeUpstreamMessage, upstreamFetch } from "../src/client/upstream.js";
import { createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";

const realFetch = globalThis.fetch;

/** A fetch that never answers until its signal aborts. */
const hangingFetch = (_input: any, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // would hang forever: the test would fail on its own timeout
    const fail = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });

afterEach(() => vi.unstubAllGlobals());

describe("upstream deadlines", () => {
  it("upstreamFetch maps a deadline to UpstreamTimeoutError naming the upstream", async () => {
    vi.stubGlobal("fetch", hangingFetch);
    const err = await upstreamFetch("https://example.test/", {}, { upstream: "Yandex Quasar", timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamTimeoutError);
    expect(err.message).toContain("Yandex Quasar did not respond within");
  });

  it("names the default 10 s deadline in the message", () => {
    expect(new UpstreamTimeoutError("Yandex Quasar", 10_000).message).toBe("Yandex Quasar did not respond within 10s");
  });

  it("QuasarClient.getCsrfToken and request time out", async () => {
    vi.stubGlobal("fetch", hangingFetch);
    const client = () => new QuasarClient({ cookie: "Session_id=x", useKeychain: false, persistEnv: false, timeoutMs: 20 });
    await expect(client().getCsrfToken()).rejects.toBeInstanceOf(UpstreamTimeoutError);
    await expect(client().getAccountUid()).rejects.toBeInstanceOf(UpstreamTimeoutError);
    await expect(client().getScenarios()).rejects.toThrow(/Yandex Quasar did not respond/);
  });

  it("exchangeCodeForToken and refreshAccessToken time out", async () => {
    vi.stubGlobal("fetch", hangingFetch);
    await expect(exchangeCodeForToken({ code: "c", clientId: "i", clientSecret: "s", timeoutMs: 20 })).rejects.toThrow(/Yandex OAuth did not respond/);
    await expect(refreshAccessToken({ refreshToken: "r", clientId: "i", clientSecret: "s", timeoutMs: 20 })).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it("fetchYandexProfile fails fast when identity must be verified", async () => {
    vi.stubGlobal("fetch", hangingFetch);
    await expect(fetchYandexProfile("tok", true, 20)).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it("initQrAuth times out", async () => {
    vi.stubGlobal("fetch", hangingFetch);
    await expect(initQrAuth(undefined, 20)).rejects.toThrow(/Yandex Passport did not respond/);
  });
});

describe("upstream error sanitization", () => {
  const quasarFetch = (status: number, body: string) => (input: any) =>
    Promise.resolve(
      String(input) === "https://yandex.ru/quasar"
        ? new Response('<html>"csrfToken2":"abc"</html>', { status: 200 })
        : new Response(body, { status }),
    );

  it("never embeds an HTML or oversized raw body", async () => {
    const payload = `<script>alert(1)</script>\n${"A".repeat(5000)}TAIL_MARKER`;
    vi.stubGlobal("fetch", quasarFetch(500, payload));
    const err = await new QuasarClient({ cookie: "Session_id=x", useKeychain: false, persistEnv: false }).getScenarios().catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.message).toMatch(/^Yandex Quasar error \(500\): /);
    const detail = err.message.replace(/^Yandex Quasar error \(500\): /, "");
    expect(detail.length).toBeLessThanOrEqual(120);
    expect(err.message).not.toMatch(/[<>\n]/);
    expect(err.message).not.toContain("TAIL_MARKER");
  });

  it("keeps a short known JSON message and strips markup and quotes", async () => {
    vi.stubGlobal("fetch", quasarFetch(400, JSON.stringify({ message: "Bad <b>\"scenario\"</b>\n name", extra: "secret" })));
    const err = await new QuasarClient({ cookie: "Session_id=x", useKeychain: false, persistEnv: false }).getScenarios().catch((e) => e);
    expect(err.message).toBe("Yandex Quasar error (400): Bad scenario name");
    expect(sanitizeUpstreamMessage('{"error_description":"x"}')).toBe("x");
    expect(sanitizeUpstreamMessage("not json")).toBe("unexpected response");
    expect(sanitizeUpstreamMessage(JSON.stringify({ unknown: "leak" }))).toBe("unexpected response");
  });

  it("does not embed the whole payload when scenario creation fails", async () => {
    const big = { status: "error", message: "nope", debug: "D".repeat(3000) };
    vi.stubGlobal("fetch", (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://yandex.ru/quasar") return Promise.resolve(new Response('"csrfToken2":"abc"', { status: 200 }));
      if (init?.method === "POST") return Promise.resolve(new Response(JSON.stringify(big), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ status: "ok", scenarios: [] }), { status: 200 }));
    });
    const client = new QuasarClient({ cookie: "Session_id=x", useKeychain: false, persistEnv: false });
    const err = await client.sendTts("dev-1", "hi").catch((e) => e);
    expect(String(err.message).length).toBeLessThan(200);
    expect(err.message).not.toContain("DDDD");
  });
});

describe("account cleanup deadline", () => {
  const PORT = 8321;
  const baseUrl = `http://127.0.0.1:${PORT}`;
  let server: http.Server;
  let storage: OAuthStorage;

  async function setup() {
    storage = new OAuthStorage(":memory:");
    server = createHttpServer(PORT, { publicBaseUrl: baseUrl, authRequired: false, enableSampler: false, oauthStorage: storage, cleanupDeadlineMs: 300 });
    await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
    vi.stubGlobal("fetch", (input: any, init?: RequestInit) => (String(input).startsWith(baseUrl) ? realFetch(input, init) : hangingFetch(input, init)));
  }
  async function teardown() {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
  }
  function seed(userId: string, sessionId: string) {
    storage.saveUser({ id: userId, yandexUid: "1", displayName: "U", createdAt: Date.now(), updatedAt: Date.now() });
    storage.saveUserCredentials(userId, { yandexAccessToken: "t", quasarCookie: "Session_id=c" });
    storage.saveWebSession(sessionId, userId, Date.now() + 3600000);
    storage.saveQuasarScenario(userId, "dev-1", "scn-1", "mctl-x");
  }

  it("deletes the account and reports scenarios_left when Quasar hangs", async () => {
    await setup();
    try {
      seed("usr_t5_a", "sess_t5_a");
      const started = Date.now();
      const res = await fetch(`${baseUrl}/account/delete`, { method: "POST", headers: { Origin: baseUrl, Cookie: "mctl_session=sess_t5_a" }, redirect: "manual" });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?deleted=true&scenarios_left=true");
      expect(storage.getUser("usr_t5_a")).toBeNull();
    } finally { await teardown(); }
  });

  it("disconnects Quasar, clears the cookie and keeps the recorded ids when Quasar hangs", async () => {
    await setup();
    try {
      seed("usr_t5_b", "sess_t5_b");
      const started = Date.now();
      const res = await fetch(`${baseUrl}/account/disconnect-quasar`, { method: "POST", headers: { Origin: baseUrl, Cookie: "mctl_session=sess_t5_b" }, redirect: "manual" });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/account?quasar_disconnected=true&scenarios_left=true");
      expect(storage.getUserCredentials("usr_t5_b")?.quasarCookie).toBeUndefined();
      expect(storage.listQuasarScenarios("usr_t5_b").map((s: any) => s.scenarioId)).toEqual(["scn-1"]);
    } finally { await teardown(); }
  });
});
