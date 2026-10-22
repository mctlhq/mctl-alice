import { beforeEach, describe, expect, it, vi } from "vitest";
import { StationService } from "../src/services/station-service.js";
import { YandexIoTClient } from "../src/client/yandex-api.js";
import { QuasarClient } from "../src/client/quasar-client.js";
import { YandexUserInfo } from "../src/client/types.js";

const speaker = (id: string, name: string, room: string) => ({
  id, name, room, type: "devices.types.smart_speaker.yandex.station",
  capabilities: [{ type: "devices.capabilities.range", parameters: { instance: "volume", range: { min: 0, max: 10 } }, state: { instance: "volume", value: 3 } }],
});
const light = (id: string, name: string, room: string) => ({
  id, name, room, type: "devices.types.light",
  capabilities: [
    { type: "devices.capabilities.on_off", state: { instance: "on", value: false } },
    { type: "devices.capabilities.range", parameters: { instance: "brightness" }, state: { instance: "brightness", value: 50 } },
  ],
  properties: [],
});

// Two identically named speakers, two speakers sharing a room, and lights
// whose names nest inside each other.
const info = {
  status: "ok",
  request_id: "r",
  rooms: [
    { id: "r-kitchen", name: "Кухня" },
    { id: "r-bed", name: "Спальня" },
    { id: "r-guest", name: "Спальня гостевая" },
    { id: "r-living", name: "Гостиная" },
  ],
  devices: [
    speaker("spk-kitchen", "Станция", "r-kitchen"),
    speaker("spk-bed", "Станция", "r-bed"),
    speaker("spk-living-1", "Колонка левая", "r-living"),
    speaker("spk-living-2", "Колонка правая", "r-living"),
    speaker("spk-guest", "Станция Мини", "r-guest"),
    light("lamp-bed", "Лампа", "r-bed"),
    light("lamp-guest", "Лампа", "r-guest"),
    light("lamp-night", "Лампа ночная", "r-kitchen"),
    light("floor", "Торшер", "r-living"),
    light("floor-corner", "Торшер угловой", "r-kitchen"),
  ],
  scenarios: [],
} as unknown as YandexUserInfo;

describe("speaker and device ambiguity", () => {
  let api: YandexIoTClient;
  let quasar: QuasarClient;
  let service: StationService;
  beforeEach(() => {
    api = {
      getUserInfo: vi.fn().mockResolvedValue(info),
      getDeviceState: vi.fn().mockResolvedValue({ status: "ok", ...info.devices[5] }),
      sendDeviceActions: vi.fn().mockResolvedValue({ status: "ok" }),
      triggerScenario: vi.fn().mockResolvedValue({ status: "ok" }),
    } as unknown as YandexIoTClient;
    quasar = {
      hasCookie: () => true,
      sendTts: vi.fn().mockResolvedValue({ status: "ok" }),
      sendCommand: vi.fn().mockResolvedValue({ status: "ok" }),
      triggerScenario: vi.fn().mockResolvedValue({ status: "ok" }),
    } as unknown as QuasarClient;
    service = new StationService(api, quasar);
  });
  const nothingSent = () => {
    expect(quasar.sendTts).not.toHaveBeenCalled();
    expect(quasar.sendCommand).not.toHaveBeenCalled();
    expect(api.sendDeviceActions).not.toHaveBeenCalled();
  };

  it("every speaker tool refuses two speakers with the same name", async () => {
    await expect(service.sayPhrase("привет", "станция")).rejects.toThrow(/ambiguous.*spk-kitchen.*spk-bed/);
    await expect(service.sendCommand("включи музыку", "Станция")).rejects.toThrow(/ambiguous/);
    await expect(service.setVolume(5, "станция")).rejects.toThrow(/ambiguous/);
    await expect(service.mediaControl("pause", "станция")).rejects.toThrow(/ambiguous/);
    nothingSent();
  });

  it("refuses a room that holds two speakers", async () => {
    await expect(service.sayPhrase("привет", "гостиная")).rejects.toThrow(/ambiguous.*spk-living-1.*spk-living-2/);
    nothingSent();
  });

  it("speaks on the one speaker an id or a unique name names", async () => {
    await service.sayPhrase("привет", "spk-bed");
    await service.sayPhrase("привет", "правая");
    expect(vi.mocked(quasar.sendTts).mock.calls.map((call) => call[0])).toEqual(["spk-bed", "spk-living-2"]);
  });

  it("light, state and history tools refuse a duplicated device name", async () => {
    await expect(service.setLight({ device: "лампа", brightness: 80 })).rejects.toThrow(/ambiguous.*lamp-bed.*lamp-guest/);
    await expect(service.getDeviceState({ device: "лампа" })).rejects.toThrow(/ambiguous/);
    await expect(service.getDeviceHistory({ device: "лампа" })).rejects.toThrow(/ambiguous/);
    expect(api.getDeviceState).not.toHaveBeenCalled();
    nothingSent();
  });

  it("an ambiguous room does not narrow a device search", async () => {
    await expect(service.setLight({ device: "лампа", room: "спал", brightness: 80 })).rejects.toThrow(/Room "спал" is ambiguous/);
    nothingSent();
  });

  it("an exact name wins over names that merely contain it", async () => {
    await service.setLight({ device: "торшер", state: "on" });
    expect(vi.mocked(api.sendDeviceActions).mock.calls[0][0][0].id).toBe("floor");
    await service.sayPhrase("привет", "станция мини");
    expect(vi.mocked(quasar.sendTts).mock.calls[0][0]).toBe("spk-guest");
  });

  it("the home summary refuses an ambiguous room and still narrows to a unique one", async () => {
    await expect(service.getHomeSummary("спал")).rejects.toThrow(/Room "спал" is ambiguous/);
    await expect(service.getHomeSummary("гараж")).rejects.toThrow(/Room "гараж" was not found/);
    expect(await service.getHomeSummary("спальня")).toMatchObject({ scope: "Спальня" });
    expect(await service.getHomeSummary("все")).toMatchObject({ scope: "Весь дом" });
  });
});
