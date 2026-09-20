import { describe, it, expect, vi } from "vitest";
import { handleToolCall, checkScope } from "../src/tools/handlers.js";
import { StationService } from "../src/services/station-service.js";

describe("Scope Enforcement in Tool Handlers", () => {
  const mockService = {
    listDevices: vi.fn().mockResolvedValue({
      speakers: [],
      otherDevices: [],
      rooms: [],
      scenarios: [],
    }),
    controlDevice: vi.fn().mockResolvedValue({
      status: "ok",
      device: { name: "Лампа", room: "Гостиная" },
    }),
    sendCommand: vi.fn().mockResolvedValue({
      status: "ok",
      speaker: { id: "spk_1", name: "Колонка" },
      command: "стоп",
    }),
  } as unknown as StationService;

  it("should allow read operations with iot:view scope", async () => {
    const res = await handleToolCall("alice_list_devices", {}, mockService, "iot:view");
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Умный дом Яндекса");
  });

  it("should reject control operations with only iot:view scope", async () => {
    const res = await handleToolCall(
      "alice_control_device",
      { device: "dev_1", action: "turn_on" },
      mockService,
      "iot:view"
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("недостаточно прав доступа");
  });

  it("should allow control operations when iot:control is granted", async () => {
    const res = await handleToolCall(
      "alice_control_device",
      { device: "dev_1", action: "turn_on" },
      mockService,
      "iot:view iot:control"
    );
    expect(res.isError).toBeFalsy();
  });

  it("should reject quasar speaker command when only iot:view is granted", async () => {
    const res = await handleToolCall(
      "alice_send_command",
      { command: "стоп", device: "spk_1" },
      mockService,
      "iot:view"
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("недостаточно прав доступа");
  });

  it("should allow quasar speaker command when quasar scope is granted", async () => {
    const res = await handleToolCall(
      "alice_send_command",
      { command: "стоп", device: "spk_1" },
      mockService,
      "iot:view quasar"
    );
    expect(res.isError).toBeFalsy();
  });
});
