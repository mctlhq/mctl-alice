import { afterEach, describe, expect, it, vi } from "vitest";
import { QuasarClient, encodeDeviceId } from "../src/client/quasar-client.js";

const device = "d2b45847-349b-43d3-ae96-178f0ea84485";

// Stubs Quasar the way Yandex behaves: a voice phrase another scenario holds is refused.
function stubAccount(scenarios: Array<{ id: string; name: string; trigger: string }>) {
  const puts: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method || "GET";
    if (url === "https://yandex.ru/iot/") return new Response('{"csrfToken2":"csrf"}');
    if (url === "https://iot.quasar.yandex.ru/m/user/scenarios" && method === "GET") {
      return Response.json({ status: "ok", scenarios: scenarios.map(({ id, name }) => ({ id, name })) });
    }
    const write = (id: string | null) => {
      const trigger = JSON.parse(String(init?.body)).triggers[0].trigger.value;
      if (scenarios.some((sc) => sc.id !== id && sc.trigger === trigger)) {
        return Response.json({ status: "error", message: "Активационная фраза для сценария уже используется" });
      }
      if (id) { puts.push(trigger); scenarios.find((sc) => sc.id === id)!.trigger = trigger; return Response.json({ status: "ok" }); }
      scenarios.push({ id: "created", name: JSON.parse(String(init?.body)).name, trigger });
      return Response.json({ status: "ok", scenario_id: "created" });
    };
    if (url === "https://iot.quasar.yandex.ru/m/user/scenarios" && method === "POST") return write(null);
    const one = url.match(/^https:\/\/iot\.quasar\.yandex\.ru\/m\/v4\/user\/scenarios\/([^/]+)$/);
    if (one && method === "PUT") return write(decodeURIComponent(one[1]));
    if (url.endsWith("/actions") && method === "POST") return Response.json({ status: "ok" });
    throw new Error(`unexpected upstream call ${method} ${url}`);
  });
  return puts;
}

const client = () => new QuasarClient({ cookie: "Session_id=x", useKeychain: false, persistEnv: false, userId: "usr_2558abcd" });

describe("proxy scenario voice trigger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not collide with a pre-ownership proxy holding the bare device phrase", async () => {
    const puts = stubAccount([
      { id: "legacy", name: `mctl-${device}`, trigger: encodeDeviceId(device) },
      { id: "owned", name: `mctl-usr_2558-${device}`, trigger: `${encodeDeviceId(device)}1234` },
    ]);
    await expect(client().sendTts(device, "Привет")).resolves.toBeDefined();
    await expect(client().sendCommand(device, "какая погода сегодня")).resolves.toBeDefined();
    expect(puts).toHaveLength(2);
    expect(puts[0]).not.toBe(encodeDeviceId(device));
    expect(puts[1]).toBe(puts[0]);
  });

  it("creates a proxy with the same trigger its updates write", async () => {
    const puts = stubAccount([{ id: "legacy", name: `mctl-${device}`, trigger: encodeDeviceId(device) }]);
    await client().sendTts(device, "Привет");
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatch(new RegExp(`^${encodeDeviceId(device)}[оеаинтсрвлкмдпуяы]{4}$`));
  });
});
