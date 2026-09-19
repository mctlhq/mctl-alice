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

  it("should return error for unknown tool", async () => {
    const res = await handleToolCall("unknown_tool", {}, mockService);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Неизвестный инструмент");
  });
});
