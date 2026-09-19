import { describe, it, expect, vi, beforeEach } from "vitest";
import { StationService } from "../src/services/station-service.js";
import { YandexIoTClient } from "../src/client/yandex-api.js";
import { YandexUserInfo } from "../src/client/types.js";

describe("StationService", () => {
  let mockClient: YandexIoTClient;
  let service: StationService;

  const mockUserInfo: YandexUserInfo = {
    status: "ok",
    request_id: "req-1",
    rooms: [
      { id: "room-living", name: "Гостиная" },
      { id: "room-kitchen", name: "Кухня" },
    ],
    devices: [
      {
        id: "station-living",
        name: "Станция Макс",
        room: "room-living",
        type: "devices.types.smart_speaker.yandex.station.max",
        capabilities: [
          {
            type: "devices.capabilities.quasar.server_action",
            parameters: {},
          },
          {
            type: "devices.capabilities.range",
            parameters: {
              instance: "volume",
              range: { min: 1, max: 10, precision: 1 },
            },
          },
        ],
      },
      {
        id: "station-kitchen",
        name: "Станция Мини Кухня",
        room: "room-kitchen",
        type: "devices.types.smart_speaker.yandex.station.mini",
        capabilities: [
          {
            type: "devices.capabilities.quasar.server_action",
          },
        ],
      },
      {
        id: "light-living",
        name: "Люстра",
        room: "room-living",
        type: "devices.types.light",
        capabilities: [],
      },
    ],
    scenarios: [
      { id: "scen-morning", name: "Доброе утро", is_active: true },
      { id: "scen-night", name: "Спокойной ночи", is_active: true },
    ],
  };

  beforeEach(() => {
    mockClient = {
      getUserInfo: vi.fn().mockResolvedValue(mockUserInfo),
      sendDeviceActions: vi.fn().mockResolvedValue({ status: "ok" }),
      triggerScenario: vi.fn().mockResolvedValue({ status: "ok" }),
    } as unknown as YandexIoTClient;

    service = new StationService(mockClient);
  });

  it("should correctly identify smart speakers", () => {
    expect(service.isSpeaker(mockUserInfo.devices![0])).toBe(true);
    expect(service.isSpeaker(mockUserInfo.devices![1])).toBe(true);
    expect(service.isSpeaker(mockUserInfo.devices![2])).toBe(false);
  });

  it("should list devices separating speakers and other devices", async () => {
    const list = await service.listDevices();
    expect(list.speakers.length).toBe(2);
    expect(list.speakers[0].name).toBe("Станция Макс");
    expect(list.speakers[0].room).toBe("Гостиная");
    expect(list.otherDevices?.length).toBe(1);
    expect(list.rooms.length).toBe(2);
    expect(list.scenarios.length).toBe(2);
  });

  it("should resolve speaker by exact ID", async () => {
    const speaker = await service.resolveSpeaker("station-kitchen");
    expect(speaker.id).toBe("station-kitchen");
  });

  it("should resolve speaker by name (case-insensitive substring)", async () => {
    const speaker = await service.resolveSpeaker("макс");
    expect(speaker.id).toBe("station-living");
  });

  it("should resolve speaker by room name", async () => {
    const speaker = await service.resolveSpeaker("Кухня");
    expect(speaker.id).toBe("station-kitchen");
  });

  it("should resolve default/first speaker when query is omitted", async () => {
    const speaker = await service.resolveSpeaker();
    expect(speaker.id).toBe("station-living");
  });

  it("should send command as text_action", async () => {
    const res = await service.sendCommand("включи джаз", "Кухня");
    expect(res.status).toBe("ok");
    expect(res.command).toBe("включи джаз");
    expect(res.speaker.id).toBe("station-kitchen");
    expect(mockClient.sendDeviceActions).toHaveBeenCalledWith([
      {
        id: "station-kitchen",
        actions: [
          {
            type: "devices.capabilities.quasar.server_action",
            state: {
              instance: "text_action",
              value: "включи джаз",
            },
          },
        ],
      },
    ]);
  });

  it("should send phrase as phrase_action (TTS)", async () => {
    const res = await service.sayPhrase("Чай готов!", "Гостиная");
    expect(res.status).toBe("ok");
    expect(res.phrase).toBe("Чай готов!");
    expect(res.speaker.id).toBe("station-living");
    expect(mockClient.sendDeviceActions).toHaveBeenCalledWith([
      {
        id: "station-living",
        actions: [
          {
            type: "devices.capabilities.quasar.server_action",
            state: {
              instance: "phrase_action",
              value: "Чай готов!",
            },
          },
        ],
      },
    ]);
  });

  it("should set volume with clamping", async () => {
    const res = await service.setVolume(7, "station-living");
    expect(res.status).toBe("ok");
    expect(res.volume).toBe(7);
    expect(mockClient.sendDeviceActions).toHaveBeenCalledWith([
      {
        id: "station-living",
        actions: [
          {
            type: "devices.capabilities.range",
            state: {
              instance: "volume",
              value: 7,
            },
          },
        ],
      },
    ]);
  });

  it("should trigger scenario by name", async () => {
    const res = await service.triggerScenario("доброе утро");
    expect(res.status).toBe("ok");
    expect(res.scenario.id).toBe("scen-morning");
    expect(mockClient.triggerScenario).toHaveBeenCalledWith("scen-morning");
  });
});
