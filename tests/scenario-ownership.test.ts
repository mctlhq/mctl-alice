import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuasarClient, encodeDeviceId } from "../src/client/quasar-client.js";
import { StationService } from "../src/services/station-service.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { YandexIoTClient } from "../src/client/yandex-api.js";
import { YandexUserInfo } from "../src/client/types.js";

const userId = "usr_1001";
const legacyName = "mctl-usr_1001-speaker";

// A fake Quasar account: scenarios live here, requests are logged.
function fakeQuasar(client: QuasarClient, initial: Array<{ id: string; name: string; triggers?: Array<{ value: string }> }>, options: { failDelete?: boolean; failList?: boolean } = {}) {
  const scenarios = [...initial];
  const log: string[] = [];
  vi.spyOn(client as any, "request").mockImplementation(async (url: unknown, init: unknown) => {
    const method = (init as RequestInit | undefined)?.method || "GET";
    const path = String(url).replace("https://iot.quasar.yandex.ru", "");
    log.push(`${method} ${path}`);
    if (path === "/m/user/scenarios" && method === "GET") {
      if (options.failList) throw new Error("Quasar unavailable");
      return { status: "ok", scenarios: [...scenarios] };
    }
    if (path === "/m/user/scenarios" && method === "POST") {
      const id = `created-${scenarios.length}`;
      scenarios.push({ id, name: JSON.parse(String((init as RequestInit).body)).name });
      return { status: "ok", scenario_id: id };
    }
    if (method === "DELETE") {
      if (options.failDelete) throw new Error("delete failed");
      const id = decodeURIComponent(path.split("/").pop()!);
      scenarios.splice(scenarios.findIndex((s) => s.id === id), 1);
      return { status: "ok" };
    }
    return { status: "ok" };
  });
  return { scenarios, log };
}

describe("proxy scenario ownership", () => {
  let storage: OAuthStorage;
  const client = () => new QuasarClient({ credentialsMode: "hosted", cookie: "Session_id=x", userId, storage });
  beforeEach(() => { storage = new OAuthStorage(":memory:"); });
  afterEach(() => { vi.restoreAllMocks(); storage.close(); });

  it("reuses the recorded scenario even after the user renames it", async () => {
    storage.saveQuasarScenario(userId, "speaker", "mine");
    const c = client();
    fakeQuasar(c, [{ id: "mine", name: "renamed" }]);
    expect(await c.getOrCreateSpeakerScenario("speaker")).toBe("mine");
  });

  it("never adopts a scenario by trigger or by a foreign name, and records what it creates", async () => {
    const c = client();
    const trigger = encodeDeviceId("speaker");
    const { scenarios } = fakeQuasar(c, [
      { id: "users-own", name: "Morning", triggers: [{ value: trigger }] },
      { id: "other-owner", name: "mctl-usr_2002-speaker" },
    ]);
    const id = await c.getOrCreateSpeakerScenario("speaker");
    expect(["users-own", "other-owner"]).not.toContain(id);
    expect(scenarios.find((s) => s.id === id)?.name).toBe(legacyName);
    expect(storage.getQuasarScenario(userId, "speaker")).toBe(id);
  });

  it("adopts a pre-existing proxy with this owner's exact name and records it", async () => {
    const c = client();
    fakeQuasar(c, [{ id: "legacy", name: legacyName }]);
    expect(await c.getOrCreateSpeakerScenario("speaker")).toBe("legacy");
    expect(storage.getQuasarScenario(userId, "speaker")).toBe("legacy");
  });

  it("does not create a duplicate when the scenario list cannot be read", async () => {
    const c = client();
    const { log } = fakeQuasar(c, [], { failList: true });
    await expect(c.getOrCreateSpeakerScenario("speaker")).rejects.toThrow("Quasar unavailable");
    expect(log.filter((l) => l.startsWith("POST"))).toEqual([]);
  });

  it("serializes the same speaker across client instances", async () => {
    const events: string[] = [];
    const run = (text: string) => {
      const c = client();
      vi.spyOn(c, "getOrCreateSpeakerScenario").mockResolvedValue("sc");
      vi.spyOn(c, "triggerScenario").mockImplementation(async () => { events.push(`trigger:${text}`); return { status: "ok" }; });
      vi.spyOn(c as any, "request").mockImplementation(async () => {
        events.push(`put:${text}`);
        await new Promise((r) => setTimeout(r, 15));
        return { status: "ok" };
      });
      return c.sendTts("speaker", text);
    };
    await Promise.all([run("one"), run("two")]);
    expect(events).toEqual(["put:one", "trigger:one", "put:two", "trigger:two"]);
  });

  it("cleanup deletes recorded and legacy proxies only, then forgets them", async () => {
    storage.saveQuasarScenario(userId, "speaker", "recorded");
    const c = client();
    const { scenarios } = fakeQuasar(c, [
      { id: "recorded", name: "renamed" },
      { id: "legacy", name: "mctl-usr_1001-other" },
      { id: "users-own", name: "Morning" },
      { id: "other-owner", name: "mctl-usr_2002-speaker" },
    ]);
    expect(await c.cleanupAllProxyScenarios()).toBe(2);
    expect(scenarios.map((s) => s.id)).toEqual(["users-own", "other-owner"]);
    expect(storage.listQuasarScenarios(userId)).toEqual([]);
  });

  it("cleanup reports failures instead of claiming nothing was there", async () => {
    storage.saveQuasarScenario(userId, "speaker", "recorded");
    const failing = client();
    fakeQuasar(failing, [{ id: "recorded", name: "x" }], { failDelete: true });
    await expect(failing.cleanupAllProxyScenarios()).rejects.toThrow("Could not delete 1 of 1");
    const unreadable = client();
    fakeQuasar(unreadable, [], { failList: true });
    await expect(unreadable.cleanupAllProxyScenarios()).rejects.toThrow("Quasar unavailable");
    expect(storage.listQuasarScenarios(userId)).toHaveLength(1);
  });
});

describe("ambiguous targets", () => {
  const info: YandexUserInfo = {
    status: "ok",
    request_id: "r",
    rooms: [{ id: "r1", name: "Кухня" }, { id: "r2", name: "Спальня" }],
    devices: [
      { id: "lamp-k", name: "Лампа", room: "r1", type: "devices.types.light", capabilities: [{ type: "devices.capabilities.on_off", state: { instance: "on", value: false } }] },
      { id: "lamp-s", name: "Лампа", room: "r2", type: "devices.types.light", capabilities: [{ type: "devices.capabilities.on_off", state: { instance: "on", value: false } }] },
      { id: "spk-1", name: "Станция Мини", room: "r1", type: "devices.types.smart_speaker.yandex.station.mini", capabilities: [] },
      { id: "spk-2", name: "Станция Макс", room: "r2", type: "devices.types.smart_speaker.yandex.station.max", capabilities: [] },
    ],
    scenarios: [{ id: "s1", name: "Включить свет" }, { id: "s2", name: "Выключить свет" }],
  } as unknown as YandexUserInfo;
  let api: YandexIoTClient;
  let service: StationService;
  beforeEach(() => {
    api = {
      getUserInfo: vi.fn().mockResolvedValue(info),
      sendDeviceActions: vi.fn().mockResolvedValue({ status: "ok" }),
      triggerScenario: vi.fn().mockResolvedValue({ status: "ok" }),
    } as unknown as YandexIoTClient;
    service = new StationService(api, { hasCookie: () => false } as any);
  });

  it("refuses to pick one of several equally good matches", async () => {
    await expect(service.controlDevice({ device: "лампа", state: "on" })).rejects.toThrow(/ambiguous.*lamp-k.*lamp-s/);
    await expect(service.resolveSpeaker("станция")).rejects.toThrow(/ambiguous/);
    await expect(service.triggerScenario("свет")).rejects.toThrow(/ambiguous/);
    expect(api.sendDeviceActions).not.toHaveBeenCalled();
    expect(api.triggerScenario).not.toHaveBeenCalled();
  });

  it("still resolves a unique match, and a room narrows it", async () => {
    await service.controlDevice({ device: "лампа", room: "спальня", state: "on" });
    expect(vi.mocked(api.sendDeviceActions).mock.calls[0][0][0].id).toBe("lamp-s");
    expect((await service.resolveSpeaker("макс")).id).toBe("spk-2");
  });

  it("an unknown room is an error, not a search across the whole home", async () => {
    await expect(service.controlDevice({ device: "лампа", room: "гараж", state: "on" })).rejects.toThrow(/Room "гараж" was not found/);
    expect(api.sendDeviceActions).not.toHaveBeenCalled();
  });
});
