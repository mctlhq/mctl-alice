import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TelemetryStorage } from "../src/storage/telemetry-storage.js";
import { TelemetrySampler } from "../src/services/telemetry-sampler.js";
import { StationService } from "../src/services/station-service.js";

describe("TelemetrySampler", () => {
  let storage: TelemetryStorage;
  let mockService: StationService;
  let sampler: TelemetrySampler;

  beforeEach(() => {
    storage = new TelemetryStorage(":memory:");
    mockService = {
      getUserInfo: vi.fn().mockResolvedValue({
        rooms: [{ id: "r-kitchen", name: "Кухня" }],
        devices: [
          {
            id: "socket-1",
            name: "Розетка",
            room: "r-kitchen",
            properties: [
              {
                type: "devices.properties.float",
                parameters: { instance: "voltage", unit: "unit.volt" },
                state: { instance: "voltage", value: 231.5 },
              },
              {
                type: "devices.properties.float",
                parameters: { instance: "power", unit: "unit.watt" },
                state: { instance: "power", value: 14.2 },
              },
            ],
            capabilities: [
              {
                type: "devices.capabilities.on_off",
                state: { instance: "on", value: true },
              },
            ],
          },
          {
            id: "sensor-1",
            name: "Датчик климата",
            room: "r-kitchen",
            properties: [
              {
                type: "devices.properties.float",
                parameters: { instance: "temperature", unit: "unit.temperature.celsius" },
                state: { instance: "temperature", value: 24.5 },
              },
            ],
          },
        ],
      }),
    } as unknown as StationService;

    sampler = new TelemetrySampler(mockService, storage, {
      intervalMs: 1000,
      enabled: true,
    });
  });

  afterEach(() => {
    sampler.stop();
    storage.close();
  });

  it("should collect samples from devices properties and capabilities", async () => {
    const count = await sampler.collectSample();
    // 2 socket properties (voltage, power) + 1 on_off cap + 1 sensor temp = 4 samples
    expect(count).toBe(4);

    const powerHistory = storage.queryHistory({
      deviceId: "socket-1",
      metric: "power",
      from: 0,
      to: Date.now() + 1000,
    });

    expect(powerHistory.count).toBe(1);
    expect(powerHistory.points[0].value).toBe(14.2);
    expect(powerHistory.deviceName).toBe("Розетка");
    expect(powerHistory.roomName).toBe("Кухня");

    const onOffHistory = storage.queryHistory({
      deviceId: "socket-1",
      metric: "on_off",
      from: 0,
      to: Date.now() + 1000,
    });
    expect(onOffHistory.count).toBe(1);
    expect(onOffHistory.points[0].value).toBe(1);

    const tempHistory = storage.queryHistory({
      deviceId: "sensor-1",
      metric: "temperature",
      from: 0,
      to: Date.now() + 1000,
    });
    expect(tempHistory.count).toBe(1);
    expect(tempHistory.points[0].value).toBe(24.5);
  });
});
