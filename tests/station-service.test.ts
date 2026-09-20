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
        capabilities: [
          {
            type: "devices.capabilities.on_off",
            state: { instance: "on", value: true },
          },
          {
            type: "devices.capabilities.range",
            parameters: {
              instance: "brightness",
              range: { min: 1, max: 100, precision: 1 },
            },
            state: { instance: "brightness", value: 80 },
          },
          {
            type: "devices.capabilities.color_setting",
            parameters: {
              temperature_k: { min: 1500, max: 6500 },
              color_scene: {
                scenes: [{ id: "night" }, { id: "reading" }, { id: "party" }],
              },
            },
            state: { instance: "temperature_k", value: 3000 },
          },
        ],
      },
      {
        id: "socket-kitchen",
        name: "Розетка на кухне",
        room: "room-kitchen",
        type: "devices.types.socket",
        capabilities: [
          {
            type: "devices.capabilities.on_off",
            state: { instance: "on", value: true },
          },
        ],
        properties: [
          {
            type: "devices.properties.float",
            parameters: { instance: "power", unit: "unit.watt" },
            state: { instance: "power", value: 125.5 },
          },
        ],
      },
      {
        id: "sensor-door",
        name: "Датчик двери",
        room: "room-living",
        type: "devices.types.sensor",
        capabilities: [],
        properties: [
          {
            type: "devices.properties.event",
            parameters: { instance: "open" },
            state: { instance: "open", value: false },
          },
          {
            type: "devices.properties.float",
            parameters: { instance: "battery_level", unit: "unit.percent" },
            state: { instance: "battery_level", value: 15 },
          },
        ],
      },
      {
        id: "ac-kitchen",
        name: "Кондиционер",
        room: "room-kitchen",
        type: "devices.types.thermostat.ac",
        capabilities: [
          {
            type: "devices.capabilities.on_off",
            parameters: { split: false },
          },
          {
            type: "devices.capabilities.range",
            parameters: {
              instance: "temperature",
              range: { min: 16, max: 30, precision: 1 },
            },
          },
          {
            type: "devices.capabilities.mode",
            parameters: {
              instance: "thermostat",
              modes: [{ value: "cool" }, { value: "heat" }],
            },
          },
        ],
        properties: [
          {
            type: "devices.properties.float",
            parameters: { instance: "temperature", unit: "unit.temperature.celsius" },
            state: { instance: "temperature", value: 21.5 },
          },
        ],
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

    const noCookieQuasar = {
      hasCookie: vi.fn().mockReturnValue(false),
    } as any;
    service = new StationService(mockClient, noCookieQuasar);
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
    expect(list.otherDevices?.length).toBe(4);
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

  it("should use QuasarClient for sayPhrase when cookie is available", async () => {
    const mockQuasar = {
      hasCookie: vi.fn().mockReturnValue(true),
      sendTts: vi.fn().mockResolvedValue({ status: "ok" }),
      sendCommand: vi.fn().mockResolvedValue({ status: "ok" }),
    } as any;

    const quasarService = new StationService(mockClient, mockQuasar);
    const res = await quasarService.sayPhrase("Привет мир", "Кухня");

    expect(res.status).toBe("ok");
    expect(res.method).toBe("quasar_tts");
    expect(mockQuasar.sendTts).toHaveBeenCalledWith(
      "station-kitchen",
      "Привет мир"
    );
    expect(mockClient.sendDeviceActions).not.toHaveBeenCalled();
  });

  it("should use QuasarClient for sendCommand when cookie is available", async () => {
    const mockQuasar = {
      hasCookie: vi.fn().mockReturnValue(true),
      sendTts: vi.fn().mockResolvedValue({ status: "ok" }),
      sendCommand: vi.fn().mockResolvedValue({ status: "ok" }),
    } as any;

    const quasarService = new StationService(mockClient, mockQuasar);
    const res = await quasarService.sendCommand("включи рок", "Кухня");

    expect(res.status).toBe("ok");
    expect(res.method).toBe("quasar_command");
    expect(mockQuasar.sendCommand).toHaveBeenCalledWith(
      "station-kitchen",
      "включи рок"
    );
    expect(mockClient.sendDeviceActions).not.toHaveBeenCalled();
  });

  it("should provide helpful error when official IoT API fails sayPhrase", async () => {
    mockClient.sendDeviceActions = vi.fn().mockRejectedValue(new Error("unknown capability"));
    const serviceWithoutQuasar = new StationService(mockClient, {
      hasCookie: () => false,
    } as any);

    await expect(serviceWithoutQuasar.sayPhrase("Привет", "Кухня")).rejects.toThrow(
      "Для прямого воспроизведения произвольного текста (TTS) требуется авторизация Yandex Quasar"
    );
  });

  it("should control device on_off and temperature via official IoT API", async () => {
    mockClient.sendDeviceActions = vi.fn().mockResolvedValue({ status: "ok" });

    const res = await service.controlDevice({
      device: "Кондиционер",
      room: "Кухня",
      state: "on",
      temperature: 22,
      mode: "cool",
    });

    expect(res.status).toBe("ok");
    expect(res.device.name).toBe("Кондиционер");
    expect(res.device.room).toBe("Кухня");
    expect(mockClient.sendDeviceActions).toHaveBeenCalledWith([
      {
        id: "ac-kitchen",
        actions: [
          {
            type: "devices.capabilities.on_off",
            state: { instance: "on", value: true },
          },
          {
            type: "devices.capabilities.range",
            state: { instance: "temperature", value: 22 },
          },
          {
            type: "devices.capabilities.mode",
            state: { instance: "thermostat", value: "cool" },
          },
        ],
      },
    ]);
  });

  it("should throw error when controlling non-existent device", async () => {
    await expect(
      service.controlDevice({
        device: "Несуществующее устройство",
      })
    ).rejects.toThrow("was not found");
  });

  it("should fetch real-time device state and telemetry properties", async () => {
    mockClient.getDevice = vi.fn().mockResolvedValue({
      id: "ac-kitchen",
      name: "Кондиционер",
      type: "devices.types.thermostat.ac",
      state: "online",
      room: "room-kitchen",
      capabilities: [
        {
          type: "devices.capabilities.on_off",
          state: { instance: "on", value: true },
        },
      ],
      properties: [
        {
          type: "devices.properties.float",
          parameters: { instance: "temperature", unit: "unit.temperature.celsius" },
          state: { instance: "temperature", value: 21.5 },
        },
      ],
    });

    const res = await service.getDeviceState({
      device: "Кондиционер",
      room: "Кухня",
    });

    expect(mockClient.getDevice).toHaveBeenCalledWith("ac-kitchen");
    expect(res.status).toBe("ok");
    expect(res.device.name).toBe("Кондиционер");
    expect(res.device.room).toBe("Кухня");
    expect(res.device.state).toBe("online");
    expect(res.capabilities).toEqual([
      { type: "devices.capabilities.on_off", instance: "on", value: true },
    ]);
    expect(res.properties).toEqual([
      { name: "temperature", instance: "temperature", value: 21.5, unit: "unit.temperature.celsius" },
    ]);
  });

  it("should query history and calculate kWh via getDeviceHistory", async () => {
    const memoryStorage = new (await import("../src/storage/telemetry-storage.js")).TelemetryStorage(":memory:");
    service.setStorage(memoryStorage);

    const now = Date.now();
    memoryStorage.saveSamples([
      {
        deviceId: "ac-kitchen",
        deviceName: "Кондиционер",
        roomName: "Кухня",
        metric: "power",
        value: 500,
        unit: "unit.watt",
        timestamp: now - 30 * 60000,
      },
      {
        deviceId: "ac-kitchen",
        deviceName: "Кондиционер",
        roomName: "Кухня",
        metric: "power",
        value: 1000,
        unit: "unit.watt",
        timestamp: now,
      },
    ]);

    const res = await service.getDeviceHistory({
      device: "Кондиционер",
      room: "Кухня",
      metric: "power",
      from: "24h",
      to: "now",
    });

    expect(res.deviceName).toBe("Кондиционер");
    expect(res.roomName).toBe("Кухня");
    expect(res.count).toBe(2);
    expect(res.min).toBe(500);
    expect(res.max).toBe(1000);
    expect(res.avg).toBe(750);
    expect(res.totalEnergyKWh).toBeGreaterThan(0);
    memoryStorage.close();
  });

  it("should control light brightness, color temperature, and scene via setLight", async () => {
    mockClient.sendDeviceActions = vi.fn().mockResolvedValue({ status: "ok" });

    const res = await service.setLight({
      device: "Люстра",
      room: "Гостиная",
      state: "on",
      brightness: 75,
      color_temp_k: 4000,
      scene: "reading",
    });

    expect(res.status).toBe("ok");
    expect(res.device.name).toBe("Люстра");
    expect(res.device.room).toBe("Гостиная");
    expect(mockClient.sendDeviceActions).toHaveBeenCalledWith([
      {
        id: "light-living",
        actions: [
          {
            type: "devices.capabilities.on_off",
            state: { instance: "on", value: true },
          },
          {
            type: "devices.capabilities.range",
            state: { instance: "brightness", value: 75 },
          },
          {
            type: "devices.capabilities.color_setting",
            state: { instance: "temperature_k", value: 4000 },
          },
          {
            type: "devices.capabilities.color_setting",
            state: { instance: "scene", value: "reading" },
          },
        ],
      },
    ]);
  });

  it("should batch control devices in a room via controlRoom", async () => {
    mockClient.sendDeviceActions = vi.fn().mockResolvedValue({ status: "ok" });

    const res = await service.controlRoom({
      room: "Кухня",
      action: "turn_off",
      device_type: "socket",
    });

    expect(res.status).toBe("ok");
    expect(res.room).toBe("Кухня");
    expect(res.action).toBe("turn_off");
    expect(res.affectedCount).toBe(1);
    expect(res.affectedDevices[0].id).toBe("socket-kitchen");

    expect(mockClient.sendDeviceActions).toHaveBeenCalledWith([
      {
        id: "socket-kitchen",
        actions: [
          {
            type: "devices.capabilities.on_off",
            state: { instance: "on", value: false },
          },
        ],
      },
    ]);
  });

  it("should generate comprehensive home summary via getHomeSummary", async () => {
    const summary = await service.getHomeSummary();

    expect(summary.scope).toBe("Весь дом");
    expect(summary.totalDevices).toBe(6);
    expect(summary.climate.length).toBeGreaterThan(0);
    expect(summary.climate.find((c) => c.room === "Кухня")?.temperature).toBe(21.5);
    expect(summary.security.some((s) => s.type === "Датчик открытия")).toBe(true);
    expect(summary.lights.total).toBe(1);
    expect(summary.lights.onCount).toBe(1);
    expect(summary.sockets.total).toBe(1);
    expect(summary.sockets.totalPowerW).toBe(125.5);
    expect(summary.batteries.length).toBe(1);
    expect(summary.batteries[0].name).toBe("Датчик двери");
    expect(summary.batteries[0].warning).toBe(true); // 15% < 20%
  });
});



