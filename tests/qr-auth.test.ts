import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { describe, it, expect, vi } from "vitest";
import { initQrAuth, checkQrAuthStatus } from "../src/auth/yandex-qr-auth.js";

/** The code reads every Passport body as text inside the deadline; give JSON-only stubs a text(). */
const withText = (res: any) => (res.text ? res : { ...res, text: async () => (res.json ? JSON.stringify(await res.json()) : "") });

describe("Yandex QR Auth", () => {
  function createMockFetch(state = "magic_code_waiting") {
    return vi.fn().mockImplementation(async (url: any) => withText(await passportStub(url, state))) as any;
  }

  async function passportStub(url: any, state: string): Promise<any> {
    {
      const urlStr = String(url);
      if (urlStr === "https://passport.yandex.ru/pwl-yandex") {
        return {
          ok: true,
          status: 200,
          text: async () => 'var __CSRF__ = "mock_csrf_token_123";',
          headers: {
            getSetCookie: () => ["yandexuid=12345; Path=/; Domain=.yandex.ru"],
            get: () => "yandexuid=12345; Path=/; Domain=.yandex.ru",
          },
        };
      }
      if (urlStr.includes("/api/passport/auth/password/submit")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            track_id: "test_track_123",
            csrf_token: "mock_csrf_token_123",
          }),
          headers: {
            getSetCookie: () => [],
            get: () => null,
          },
        };
      }
      if (urlStr.includes("/api/passport/auth/magic/code/status")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ state, trackId: "test_track_123" }),
          headers: {
            getSetCookie: () => [],
            get: () => null,
          },
        };
      }
      if (urlStr.includes("/api/passport/auth/magic/code")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            link: "https://passport.yandex.ru/am/push/qrsecure?track_id=test_track_123&magic=MOCK_MAGIC",
          }),
          headers: {
            getSetCookie: () => [],
            get: () => null,
          },
        };
      }
      if (urlStr.includes("/api/passport/sessions/get_session")) {
        return {
          ok: true,
          status: 200,
          headers: {
            getSetCookie: () => [
              "Session_id=3:1700000000.5.0:mock_session; Path=/; Domain=.yandex.ru",
              "sessionid2=3:1700000000.5.0:mock_session2; Path=/; Domain=.yandex.ru",
            ],
            get: () => "Session_id=3:1700000000.5.0:mock_session; Path=/; Domain=.yandex.ru",
          },
        };
      }
      return { ok: false, status: 404, text: async () => "not found", headers: { getSetCookie: () => [] } };
    }
  }

  it("should initialize QR auth and return SVG and trackId", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createMockFetch();

    try {
      const res = await initQrAuth();
      expect(res.sessionId).toBe("test_track_123");
      expect(res.link).toContain("qrsecure");
      expect(res.qrSvg).toContain("<svg");
      expect(res.qrSvg).toContain("</svg>");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should report waiting status when approval is pending", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createMockFetch("magic_code_waiting");

    try {
      const res = await initQrAuth();
      const status = await checkQrAuthStatus(res.sessionId);
      expect(status.status).toBe("waiting");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should finish auth when approval is completed", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createMockFetch("otp_auth_finished");

    try {
      const res = await initQrAuth();
      const status = await checkQrAuthStatus(res.sessionId);
      expect(status.status).toBe("ok");
      expect(status.cookie).toContain("Session_id=3:1700000000.5.0:mock_session");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("persists hosted QR state outside the process-local map", async () => {
    const storage = new OAuthStorage(":memory:");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createMockFetch("otp_auth_finished");
    try {
      const qr = await initQrAuth(storage);
      expect(storage.getBrowserTransaction(`qr-state:${qr.sessionId}`)).toContain("mock_csrf_token_123");
      const result = await checkQrAuthStatus(qr.sessionId, storage);
      expect(result.status).toBe("ok");
      expect(storage.getBrowserTransaction(`qr-state:${qr.sessionId}`)).toBeNull();
      expect((await checkQrAuthStatus(qr.sessionId, storage)).status).toBe("expired");
    } finally { globalThis.fetch = originalFetch; storage.close(); }
  });

  it("persists rotated passport cookies across waiting polls without extending the QR expiry", async () => {
    const storage = new OAuthStorage(":memory:");
    const originalFetch = globalThis.fetch;
    const mock = createMockFetch("magic_code_waiting");
    let polls = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      if (String(input).includes("/magic/code/status")) {
        polls++;
        if (polls === 2) expect((init?.headers as Record<string, string>).Cookie).toContain("passport=rotated");
        return new Response(JSON.stringify({ state: polls === 1 ? "magic_code_waiting" : "otp_auth_finished", trackId: "test_track_123" }), { headers: { "Set-Cookie": "passport=rotated; Path=/" } });
      }
      return mock(input, init);
    });
    try {
      const qr = await initQrAuth(storage);
      const before = JSON.parse(storage.getBrowserTransaction(`qr-state:${qr.sessionId}`)!);
      expect((await checkQrAuthStatus(qr.sessionId, storage)).status).toBe("waiting");
      const saved = JSON.parse(storage.getBrowserTransaction(`qr-state:${qr.sessionId}`)!);
      expect(saved.cookies).toContain("passport=rotated");
      expect(saved.createdAt).toBe(before.createdAt);
      expect((await checkQrAuthStatus(qr.sessionId, storage)).status).toBe("ok");
      expect(polls).toBe(2);
    } finally { globalThis.fetch = originalFetch; storage.close(); }
  });

  it("should return expired for unknown sessionId", async () => {
    const status = await checkQrAuthStatus("non_existent_session");
    expect(status.status).toBe("expired");
  });

  it("should return error when Yandex returns errors in status check", async () => {
    const originalFetch = globalThis.fetch;
    const mock = createMockFetch();
    globalThis.fetch = vi.fn().mockImplementation(async (url: any, opts: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/passport/auth/magic/code/status")) {
        return withText({
          ok: true,
          status: 200,
          json: async () => ({
            error: "uN Exception: status: error",
            errors: ["csrf_token.invalid"],
          }),
          headers: { getSetCookie: () => [] },
        });
      }
      return mock(url, opts);
    }) as any;

    try {
      const res = await initQrAuth();
      const status = await checkQrAuthStatus(res.sessionId);
      expect(status.status).toBe("error");
      expect(status.message).toContain("csrf_token.invalid");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
