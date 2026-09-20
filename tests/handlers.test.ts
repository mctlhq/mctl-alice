import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleToolCall } from "../src/tools/handlers.js";
import { StationService } from "../src/services/station-service.js";

describe("handleToolCall", () => {
  let mockService: StationService;

  beforeEach(() => {
    mockService = {
      listDevices: vi.fn().mockResolvedValue({
        speakers: [{ id: "sp-1", name: "Колонка", room: "Зал", state: "online" }],
        otherDevices: [],
        rooms: [{ id: "r-1", name: "Зал" }],
        scenarios: [{ id: "sc-1", name: "Тест", isActive: true }],
      }),
      sendCommand: vi.fn().mockResolvedValue({
        status: "ok",
        speaker: { id: "sp-1", name: "Колонка" },
        command: "стоп",
      }),
      sayPhrase: vi.fn().mockResolvedValue({
        status: "ok",
        speaker: { id: "sp-1", name: "Колонка" },
        phrase: "Привет",
      }),
      setVolume: vi.fn().mockResolvedValue({
        status: "ok",
        speaker: { id: "sp-1", name: "Колонка" },
        volume: 5,
      }),
      mediaControl: vi.fn().mockResolvedValue({
        status: "ok",
        speaker: { id: "sp-1", name: "Колонка" },
        action: "pause",
        commandSent: "пауза",
      }),
      triggerScenario: vi.fn().mockResolvedValue({
        status: "ok",
        scenario: { id: "sc-1", name: "Тест" },
      }),
      controlDevice: vi.fn().mockResolvedValue({
        status: "ok",
        device: { id: "d-1", name: "Кондиционер", room: "Кухня" },
        actionsApplied: [{ type: "devices.capabilities.on_off", state: { instance: "on", value: true } }],
      }),
      getDeviceState: vi.fn().mockResolvedValue({
        status: "ok",
        device: { id: "d-plug", name: "Розетка", room: "Кухня", type: "devices.types.socket", state: "online" },
        capabilities: [{ type: "devices.capabilities.on_off", instance: "on", value: true }],
        properties: [
          { name: "power", instance: "power", value: 12.5, unit: "unit.watt" },
          { name: "voltage", instance: "voltage", value: 230, unit: "unit.volt" },
        ],
      }),
      getDeviceHistory: vi.fn().mockResolvedValue({
        deviceId: "d-plug",
        deviceName: "Розетка",
        roomName: "Кухня",
        metric: "power",
        unit: "unit.watt",
        from: 1700000000000,
        to: 1700036000000,
        fromIso: "2026-09-20T00:00:00.000Z",
        toIso: "2026-09-20T10:00:00.000Z",
        resolution: "15m",
        count: 2,
        min: 10.0,
        max: 50.0,
        avg: 25.0,
        latest: 15.0,
        totalEnergyKWh: 0.25,
        points: [
          {
            timestamp: 1700000000000,
            timeIso: "2026-09-20T00:00:00.000Z",
            value: 10.0,
            metric: "power",
            unit: "unit.watt",
          },
          {
            timestamp: 1700000900000,
            timeIso: "2026-09-20T00:15:00.000Z",
            value: 50.0,
            metric: "power",
            unit: "unit.watt",
          },
        ],
      }),
      setLight: vi.fn().mockResolvedValue({
        status: "ok",
        device: { id: "light-1", name: "Люстра", room: "Гостиная" },
        actionsApplied: [
          { type: "devices.capabilities.on_off", state: { instance: "on", value: true } },
          { type: "devices.capabilities.range", state: { instance: "brightness", value: 60 } },
          { type: "devices.capabilities.color_setting", state: { instance: "temperature_k", value: 3500 } },
        ],
      }),
      controlRoom: vi.fn().mockResolvedValue({
        status: "ok",
        room: "Кухня",
        action: "turn_off",
        deviceType: "socket",
        affectedCount: 2,
        affectedDevices: [
          { id: "s-1", name: "Розетка 1", room: "Кухня", type: "devices.types.socket" },
          { id: "s-2", name: "Розетка 2", room: "Кухня", type: "devices.types.socket" },
        ],
      }),
      getHomeSummary: vi.fn().mockResolvedValue({
        scope: "Весь дом",
        timestamp: "2026-09-20T10:00:00Z",
        totalDevices: 10,
        climate: [
          { room: "Кухня", temperature: 23.5, humidity: 45, pressure: 760, devices: ["Датчик климата"] },
        ],
        security: [
          { name: "Датчик двери", room: "Прихожая", type: "Датчик открытия", status: "Закрыто 🟢" },
        ],
        lights: {
          total: 3,
          onCount: 1,
          offCount: 2,
          activeLights: [{ name: "Люстра", room: "Гостиная", brightness: 60 }],
        },
        sockets: {
          total: 2,
          onCount: 1,
          totalPowerW: 42.5,
          devices: [{ name: "Розетка 1", room: "Кухня", isOn: true, powerW: 42.5 }],
        },
        batteries: [
          { name: "Датчик двери", room: "Прихожая", level: 18, warning: true },
        ],
        offlineDevices: [],
      }),
    } as unknown as StationService;
  });

  it("should handle alice_list_devices", async () => {
    const res = await handleToolCall("alice_list_devices", {}, mockService);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Колонки с Алисой (1)");
    expect(res.content[0].text).toContain("Колонка");
  });

  it("should handle alice_send_command", async () => {
    const res = await handleToolCall(
      "alice_send_command",
      { command: "стоп" },
      mockService
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Команда "стоп" успешно отправлена');
  });

  it("should return error if command is missing in alice_send_command", async () => {
    const res = await handleToolCall("alice_send_command", {}, mockService);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("обязателен");
  });

  it("should handle alice_say_phrase", async () => {
    const res = await handleToolCall(
      "alice_say_phrase",
      { phrase: "Привет" },
      mockService
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Алиса озвучила фразу "Привет"');
  });

  it("should handle alice_set_volume", async () => {
    const res = await handleToolCall(
      "alice_set_volume",
      { level: 5 },
      mockService
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("установлена на **5**");
  });

  it("should handle alice_media_control", async () => {
    const res = await handleToolCall(
      "alice_media_control",
      { action: "pause" },
      mockService
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Действие медиа-контроля "pause"');
  });

  it("should handle alice_trigger_scenario", async () => {
    const res = await handleToolCall(
      "alice_trigger_scenario",
      { scenario: "Тест" },
      mockService
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Сценарий умного дома **Тест**");
  });

  it("should handle alice_control_device", async () => {
    const res = await handleToolCall(
      "alice_control_device",
      { device: "Кондиционер", room: "Кухня", state: "on", temperature: 22 },
      mockService
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Устройство **Кондиционер** (Кухня) успешно обновлено");
  });

  it("should handle alice_get_device_state", async () => {
    const res = await handleToolCall(
      "alice_get_device_state",
      { device: "Розетка", room: "Кухня" },
      mockService
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Состояние устройства: Розетка");
    expect(res.content[0].text).toContain("**Текущая мощность:** 12.5 Вт");
    expect(res.content[0].text).toContain("**Напряжение:** 230 В");
    expect(res.content[0].text).toContain("**Состояние питания:** Включено");
  });

  it("should handle alice_get_device_history with power summary and energy kWh", async () => {
    const res = await handleToolCall(
      "alice_get_device_history",
      { device: "Розетка", room: "Кухня", metric: "power", resolution: "15m" },
      mockService
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("История телеметрии: Розетка (Кухня)");
    expect(res.content[0].text).toContain("**Суммарное потребление:** **0.25 кВт·ч**");
    expect(res.content[0].text).toContain("**Пиковая (макс.) мощность:** **50 Вт**");
    expect(res.content[0].text).toContain("**Средняя мощность:** **25 Вт**");
    expect(res.content[0].text).toContain("| 2026-09-20 00:00:00 | 10 |");
  });

  it("should return error when device argument is missing in alice_get_device_history", async () => {
    const res = await handleToolCall(
      "alice_get_device_history",
      {},
      mockService
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("параметр 'device' обязателен");
  });

  it("should handle alice_set_light", async () => {
    const res = await handleToolCall(
      "alice_set_light",
      { device: "Люстра", room: "Гостиная", state: "on", brightness: 60, color_temp_k: 3500 },
      mockService
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Управление светом: Люстра");
    expect(res.content[0].text).toContain("Питание: **Включено**");
    expect(res.content[0].text).toContain("Яркость: **60%**");
    expect(res.content[0].text).toContain("Цветовая температура: **3500 K**");
  });

  it("should handle alice_control_room", async () => {
    const res = await handleToolCall(
      "alice_control_room",
      { room: "Кухня", action: "turn_off", device_type: "socket" },
      mockService
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Пакетное управление: Кухня");
    expect(res.content[0].text).toContain("Успешно **выключены** устройства (2 шт., категория: `socket`)");
    expect(res.content[0].text).toContain("Розетка 1");
  });

  it("should handle alice_get_home_summary", async () => {
    const res = await handleToolCall(
      "alice_get_home_summary",
      {},
      mockService
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Сводка умного дома: Весь дом");
    expect(res.content[0].text).toContain("Климат и температура");
    expect(res.content[0].text).toContain("23.5°C");
    expect(res.content[0].text).toContain("Датчик открытия");
    expect(res.content[0].text).toContain("Текущая суммарная мощность: **42.5 Вт**");
    expect(res.content[0].text).toContain("18%");
  });

  it("should return error for unknown tool", async () => {
    const res = await handleToolCall("unknown_tool", {}, mockService);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Неизвестный инструмент");
  });
});
