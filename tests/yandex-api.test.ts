import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { YandexIoTClient, YandexApiError } from "../src/client/yandex-api.js";

describe("YandexIoTClient", () => {
  const mockToken = "test-token-12345";
  let client: YandexIoTClient;
  const originalFetch = global.fetch;

  beforeEach(() => {
    client = new YandexIoTClient(mockToken);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should throw error if token is not provided", () => {
    const oldEnv = process.env.YANDEX_OAUTH_TOKEN;
    delete process.env.YANDEX_OAUTH_TOKEN;
    expect(() => new YandexIoTClient("")).toThrow(YandexApiError);
    if (oldEnv) process.env.YANDEX_OAUTH_TOKEN = oldEnv;
  });

  it("should strip Bearer prefix from token", () => {
    const c = new YandexIoTClient("Bearer my-secret-token");
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

  it("should handle 401 Unauthorized with descriptive error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: "Invalid token" }),
    });

    await expect(client.getUserInfo()).rejects.toThrow(
      /Unauthorized \(401\)/
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
