import { describe, expect, it } from "vitest";
import { ALICE_TOOLS } from "../src/tools/definitions.js";

const byName = new Map(ALICE_TOOLS.map((t) => [t.name, t]));

describe("tool annotations", () => {
  it("gives every tool a title and the four hints a client needs", () => {
    expect(ALICE_TOOLS.length).toBe(13);
    for (const tool of ALICE_TOOLS) {
      const a = tool.annotations;
      expect(a?.title, `${tool.name}: no title`).toBeTruthy();
      expect(typeof a?.readOnlyHint, `${tool.name}: readOnlyHint`).toBe("boolean");
      expect(typeof a?.idempotentHint, `${tool.name}: idempotentHint`).toBe("boolean");
      // Only the identity tool stays inside this server; the rest call Yandex.
      expect(a?.openWorldHint, `${tool.name}: openWorldHint`).toBe(tool.name !== "alice_get_my_identity");
      // destructiveHint is only meaningful on a tool that writes.
      if (a?.readOnlyHint === false) {
        expect(typeof a.destructiveHint, `${tool.name}: a writing tool must say destructive or not`).toBe("boolean");
      }
    }
  });

  it("marks exactly the sensor, listing and identity tools read-only", () => {
    const readOnly = ALICE_TOOLS.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual([
      "alice_get_device_history",
      "alice_get_device_state",
      "alice_get_home_summary",
      "alice_get_my_identity",
      "alice_list_devices",
    ]);
  });

  it("flags the calls with the widest effect as destructive", () => {
    const destructive = ALICE_TOOLS.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
    expect(destructive).toEqual(["alice_control_room", "alice_send_command", "alice_trigger_scenario"]);
  });

  it("calls only absolute-state setters idempotent among the writers", () => {
    const idempotentWriters = ALICE_TOOLS
      .filter((t) => t.annotations?.readOnlyHint === false && t.annotations.idempotentHint)
      .map((t) => t.name)
      .sort();
    expect(idempotentWriters).toEqual(["alice_control_device", "alice_control_room", "alice_set_light", "alice_set_volume"]);
    // next/prev, a spoken phrase and a scenario run repeat their effect.
    for (const name of ["alice_media_control", "alice_say_phrase", "alice_trigger_scenario", "alice_send_command"]) {
      expect(byName.get(name)?.annotations?.idempotentHint, name).toBe(false);
    }
  });
});
