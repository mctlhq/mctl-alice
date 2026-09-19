import { describe, it, expect, vi, beforeEach } from "vitest";
import { QuasarClient, encodeDeviceId, buildTtsScenarioPayload, buildCommandScenarioPayload } from "../src/client/quasar-client.js";

describe("QuasarClient", () => {
  it("should correctly encode device ID to Russian alphabet", () => {
    const id = "0123456789abcdef-";
    const encoded = encodeDeviceId(id);
    expect(encoded).toBe("оеаинтсрвлкмдпуяы");
  });

  it("should build valid TTS scenario payload", () => {
    const payload = buildTtsScenarioPayload("test-name", "trigger1", "dev-123", "Привет");
    expect(payload.name).toBe("test-name");
    expect(payload.triggers[0].trigger.value).toBe("trigger1");
    expect(payload.steps[0].parameters.items[0].value.capabilities[0].type).toBe("devices.capabilities.quasar");
    expect(payload.steps[0].parameters.items[0].value.capabilities[0].state.value.text).toBe("Привет");
  });

  it("should build valid command scenario payload", () => {
    const payload = buildCommandScenarioPayload("test-name", "trigger1", "dev-123", "включи свет");
    expect(payload.name).toBe("test-name");
    expect(payload.steps[0].parameters.items[0].value.capabilities[0].type).toBe("devices.capabilities.quasar.server_action");
    expect(payload.steps[0].parameters.items[0].value.capabilities[0].state.value).toBe("включи свет");
  });

  it("should format cookie with Session_id prefix if just token provided", () => {
    const client = new QuasarClient({ useKeychain: false, persistEnv: false });
    client.setCookie("3:sample_session_id", false);
    expect(client.hasCookie()).toBe(true);
  });
});
