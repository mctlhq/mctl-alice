import { describe, it, expect, vi } from "vitest";
import { QuasarClient } from "../src/client/quasar-client.js";

describe("Quasar Concurrency & Scenario Isolation", () => {
  it("should serialize concurrent operations for the same speaker using internal lock", async () => {
    const client = new QuasarClient({
      useKeychain: false,
      persistEnv: false,
      userId: "usr_alice_123",
      cookie: "Session_id=test_cookie",
    });

    const executionLog: string[] = [];

    // Mock internal methods
    vi.spyOn(client as any, "getOrCreateSpeakerScenario").mockResolvedValue("sc_100");
    vi.spyOn(client as any, "triggerScenario").mockImplementation(async () => {
      executionLog.push("trigger");
      return { status: "ok" };
    });

    vi.spyOn(client as any, "request").mockImplementation(async (url: string, opts: any) => {
      if (opts?.method === "PUT") {
        const body = JSON.parse(opts.body);
        executionLog.push(`start_put:${body.name}`);
        // simulate async delay
        await new Promise((r) => setTimeout(r, 20));
        executionLog.push(`end_put:${body.name}`);
        return { status: "ok" };
      }
      return { status: "ok" };
    });

    // Run two concurrent sendTts calls for the same device
    const call1 = client.sendTts("dev_speaker_1", "Первое сообщение");
    const call2 = client.sendTts("dev_speaker_1", "Второе сообщение");

    await Promise.all([call1, call2]);

    // Because of serialization lock:
    // start_put -> end_put -> trigger -> start_put -> end_put -> trigger
    expect(executionLog).toEqual([
      "start_put:mctl-usr_alic-dev_speaker_1",
      "end_put:mctl-usr_alic-dev_speaker_1",
      "trigger",
      "start_put:mctl-usr_alic-dev_speaker_1",
      "end_put:mctl-usr_alic-dev_speaker_1",
      "trigger",
    ]);
  });

  it("should isolate scenario names with user prefix when userId is configured", async () => {
    const client = new QuasarClient({
      useKeychain: false,
      persistEnv: false,
      userId: "user_bob_456",
      cookie: "Session_id=test_cookie",
    });

    let createdPayload: any = null;
    vi.spyOn(client, "getScenarios").mockResolvedValue([]);
    vi.spyOn(client as any, "request").mockImplementation(async (url: string, opts: any) => {
      if (opts?.method === "POST" && url.endsWith("/scenarios")) {
        createdPayload = JSON.parse(opts.body);
        return { status: "ok", scenario_id: "new_sc_200" };
      }
      return { status: "ok" };
    });

    const scenarioId = await client.getOrCreateSpeakerScenario("speaker_kitchen");
    expect(scenarioId).toBe("new_sc_200");
    expect(createdPayload.name).toBe("mctl-user_bob-speaker_kitchen");
  });

  it("should cleanup only scenarios matching the user prefix", async () => {
    const client = new QuasarClient({
      useKeychain: false,
      persistEnv: false,
      userId: "user_bob_456",
      cookie: "Session_id=test_cookie",
    });

    const deletedIds: string[] = [];
    vi.spyOn(client, "getScenarios").mockResolvedValue([
      { id: "sc_bob_1", name: "mctl-user_bob-speaker_1" },
      { id: "sc_bob_2", name: "mctl-user_bob-speaker_2" },
      { id: "sc_other", name: "mctl-user_alic-speaker_1" },
      { id: "sc_custom", name: "Доброе утро" },
    ]);

    vi.spyOn(client as any, "request").mockImplementation(async (url: string, opts: any) => {
      if (opts?.method === "DELETE") {
        const id = url.split("/").pop();
        if (id) deletedIds.push(id);
        return { status: "ok" };
      }
      return { status: "ok" };
    });

    const count = await client.cleanupAllProxyScenarios();
    expect(count).toBe(2);
    expect(deletedIds).toEqual(["sc_bob_1", "sc_bob_2"]);
  });
});
