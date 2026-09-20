import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TelemetryStorage } from "../src/storage/telemetry-storage.js";

describe("TelemetryStorage", () => {
  let storage: TelemetryStorage;

  beforeEach(() => {
    storage = new TelemetryStorage(":memory:");
  });

  afterEach(() => {
    storage.close();
  });

  it("should batch insert samples and query raw history", () => {
    const now = 1700000000000;
    storage.saveSamples([
      {
        deviceId: "dev-plug-1",
        deviceName: "Розетка на кухне",
        roomName: "Кухня",
        metric: "power",
        value: 12.5,
        unit: "unit.watt",
        timestamp: now,
      },
      {
        deviceId: "dev-plug-1",
        deviceName: "Розетка на кухне",
        roomName: "Кухня",
        metric: "voltage",
        value: 232.0,
        unit: "unit.volt",
        timestamp: now,
      },
      {
        deviceId: "dev-plug-1",
        deviceName: "Розетка на кухне",
        roomName: "Кухня",
        metric: "power",
        value: 18.0,
        unit: "unit.watt",
        timestamp: now + 60000,
      },
    ]);

    const res = storage.queryHistory({
      deviceId: "dev-plug-1",
      metric: "power",
      from: now - 1000,
      to: now + 120000,
      resolution: "max",
    });

    expect(res.count).toBe(2);
    expect(res.min).toBe(12.5);
    expect(res.max).toBe(18.0);
    expect(res.avg).toBe(15.25);
    expect(res.latest).toBe(18.0);
    expect(res.points.length).toBe(2);
    expect(res.points[0].value).toBe(12.5);
    expect(res.points[1].value).toBe(18.0);
  });

  it("should accurately integrate power into energy kWh", () => {
    // 1 hour of constant 1000 Watts
    const start = 1700000000000;
    const samples = [];
    for (let m = 0; m <= 60; m++) {
      samples.push({
        deviceId: "heater",
        deviceName: "Обогреватель",
        metric: "power",
        value: 1000,
        unit: "unit.watt",
        timestamp: start + m * 60000,
      });
    }
    storage.saveSamples(samples);

    const res = storage.queryHistory({
      deviceId: "heater",
      metric: "power",
      from: start,
      to: start + 60 * 60000,
      resolution: "max",
    });

    // 1000W * 1h = 1.0 kWh (+/- 0.02 due to trailing point estimate)
    expect(res.totalEnergyKWh).toBeDefined();
    expect(res.totalEnergyKWh).toBeGreaterThanOrEqual(1.0);
    expect(res.totalEnergyKWh).toBeLessThanOrEqual(1.05);
    expect(res.avg).toBe(1000);
    expect(res.min).toBe(1000);
    expect(res.max).toBe(1000);
  });

  it("should bucket samples into 5m and 1h resolutions", () => {
    const start = 1700000000000;
    const samples = [];
    for (let i = 0; i < 15; i++) {
      samples.push({
        deviceId: "socket",
        deviceName: "Розетка",
        metric: "power",
        value: 10 + i,
        unit: "unit.watt",
        timestamp: start + i * 60000,
      });
    }
    storage.saveSamples(samples);

    const bucketed5m = storage.queryHistory({
      deviceId: "socket",
      metric: "power",
      from: start,
      to: start + 15 * 60000,
      resolution: "5m",
    });

    expect(bucketed5m.resolution).toBe("5m");
    expect(bucketed5m.points.length).toBeLessThan(samples.length);
    expect(bucketed5m.points[0].sampleCount).toBeGreaterThan(1);
    expect(bucketed5m.points[0].minValue).toBeDefined();
    expect(bucketed5m.points[0].maxValue).toBeDefined();
  });

  it("should prune old samples based on retention days", () => {
    const oldTs = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const recentTs = Date.now() - 5 * 24 * 60 * 60 * 1000;

    storage.saveSamples([
      {
        deviceId: "dev-1",
        deviceName: "Датчик",
        metric: "temp",
        value: 20,
        timestamp: oldTs,
      },
      {
        deviceId: "dev-1",
        deviceName: "Датчик",
        metric: "temp",
        value: 22,
        timestamp: recentTs,
      },
    ]);

    const deleted = storage.pruneOld(30);
    expect(deleted).toBe(1);

    const remaining = storage.queryHistory({
      deviceId: "dev-1",
      metric: "temp",
      from: 0,
      to: Date.now(),
    });
    expect(remaining.count).toBe(1);
    expect(remaining.points[0].value).toBe(22);
  });
});
