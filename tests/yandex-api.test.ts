import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { YandexIoTClient, YandexApiError } from "../src/client/yandex-api.js";

describe("YandexIoTClient", () => {
  const mockToken = "test-token-12345";
  let client: YandexIoTClient;
  const originalFetch = global.fetch;

  beforeEach(() => {
    client = new YandexIoTClient(mockToken, { useKeychain: false });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should throw error if token is not provided", () => {
    const oldEnv = process.env.YANDEX_OAUTH_TOKEN;
    delete process.env.YANDEX_OAUTH_TOKEN;
    expect(() => new YandexIoTClient("", { useKeychain: false })).toThrow(YandexApiError);
    if (oldEnv) process.env.YANDEX_OAUTH_TOKEN = oldEnv;
  });

  it("should strip Bearer prefix from token", () => {
    const c = new YandexIoTClient("Bearer my-secret-token", { useKeychain: false });
    expect((c as any).token).toBe("my-secret-token");
  });

  it("should fetch user info successfully", async () => {
    const mockUserInfo = {
      status: "ok",
      request_id: "req-1",
      devices: [
        {
          id: "dev-1",
          name: "Яндекс Станция",
          type: "devices.types.smart_speaker.yandex.station",
          capabilities: [],
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(mockUserInfo),
    });

    const info = await client.getUserInfo();
    expect(info.status).toBe("ok");
    expect(info.devices?.length).toBe(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.iot.yandex.net/v1.0/user/info",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token-12345",
        }),
      })
    );
  });

  it("should handle 401 Unauthorized with descriptive error when no refresh token", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: "Invalid token" }),
    });

    await expect(client.getUserInfo()).rejects.toThrow(
      /Unauthorized \(401\)/
    );
  });

  it("should automatically refresh token on 401 and retry request when refresh credentials exist", async () => {
    const clientWithRefresh = new YandexIoTClient("initial-expired-token", {
      useKeychain: false,
      refreshToken: "mock-refresh-token",
      clientId: "mock-client-id",
      clientSecret: "mock-client-secret",
    });

    let attempts = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "refreshed-new-access-token",
            refresh_token: "rotated-refresh-token",
            expires_in: 31536000,
          }),
        };
      }

      if (url.includes("/user/info")) {
        attempts++;
        if (attempts === 1) {
          return {
            ok: false,
            status: 401,
            text: async () => JSON.stringify({ message: "Token expired" }),
          };
        }
        return {
          ok: true,
          text: async () => JSON.stringify({ status: "ok", devices: [] }),
        };
      }

      throw new Error(`Unexpected url: ${url}`);
    });

    const result = await clientWithRefresh.getUserInfo();
    expect(result.status).toBe("ok");
    expect(attempts).toBe(2);
    expect((clientWithRefresh as any).token).toBe("refreshed-new-access-token");
    expect((clientWithRefresh as any).refreshToken).toBe("rotated-refresh-token");
  });

  it("should throw descriptive error if auto-refresh itself fails", async () => {
    const clientWithRefresh = new YandexIoTClient("initial-expired-token", {
      useKeychain: false,
      refreshToken: "revoked-refresh-token",
      clientId: "mock-client-id",
      clientSecret: "mock-client-secret",
    });

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/token")) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error_description: "Refresh token revoked" }),
        };
      }
      return {
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ message: "Token expired" }),
      };
    });

    await expect(clientWithRefresh.getUserInfo()).rejects.toThrow(
      /auto-refresh failed: Refresh token revoked/
    );
  });

  it("should send device actions payload", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ status: "ok", request_id: "req-2" }),
    });

    const actions = [
      {
        id: "dev-1",
        actions: [
          {
            type: "devices.capabilities.quasar.server_action",
            state: { instance: "text_action", value: "включи музыку" },
          },
        ],
      },
    ];

    const res = await client.sendDeviceActions(actions);
    expect(res.status).toBe("ok");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.iot.yandex.net/v1.0/devices/actions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ devices: actions }),
      })
    );
  });

  it("should trigger scenario by ID", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ status: "ok", request_id: "req-3" }),
    });

    const res = await client.triggerScenario("scen-123");
    expect(res.status).toBe("ok");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.iot.yandex.net/v1.0/scenarios/scen-123/actions",
      expect.objectContaining({
        method: "POST",
      })
    );
  });
});
