import { describe, it, expect, vi } from "vitest";
import { initQrAuth, checkQrAuthStatus } from "../src/auth/yandex-qr-auth.js";

describe("Yandex QR Auth", () => {
  function createMockFetch(state = "magic_code_waiting") {
    return vi.fn().mockImplementation(async (url: any) => {
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
    }) as any;
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

  it("should return expired for unknown sessionId", async () => {
    const status = await checkQrAuthStatus("non_existent_session");
    expect(status.status).toBe("expired");
  });
});
