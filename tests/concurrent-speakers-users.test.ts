import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuasarClient } from "../src/client/quasar-client.js";
import { authenticateRequest } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { IStorage } from "../src/storage/storage-interface.js";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

// A Quasar client whose scenario PUT takes a while and logs when it starts and ends.
function timedClient(userId: string, log: string[]) {
  const client = new QuasarClient({ useKeychain: false, persistEnv: false, userId, cookie: `Session_id=${userId}` });
  vi.spyOn(client, "getOrCreateSpeakerScenario").mockImplementation(async (deviceId: string) => `sc-${userId}-${deviceId}`);
  vi.spyOn(client, "triggerScenario").mockResolvedValue({ status: "ok" });
  vi.spyOn(client as any, "request").mockImplementation(async (url: unknown, init: any) => {
    if (init?.method !== "PUT") return { status: "ok" };
    const id = String(url).split("/").pop();
    log.push(`start ${id}`);
    await tick(20);
    log.push(`end ${id}`);
    return { status: "ok" };
  });
  return client;
}
// True when the first job ended before the second one started.
const serialized = (log: string[], a: string, b: string) =>
  log.indexOf(`end ${a}`) < log.indexOf(`start ${b}`) || log.indexOf(`end ${b}`) < log.indexOf(`start ${a}`);

describe("concurrent commands to speakers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("two speakers of one user are driven in parallel", async () => {
    const log: string[] = [];
    const client = timedClient("usr_alice", log);
    await Promise.all([client.sendTts("kitchen", "раз"), client.sendCommand("bedroom", "стоп")]);
    expect(serialized(log, "sc-usr_alice-kitchen", "sc-usr_alice-bedroom")).toBe(false);
  });

  it("one speaker is serialized even across per-request client instances", async () => {
    const log: string[] = [];
    const first = timedClient("usr_alice", log);
    const second = timedClient("usr_alice", log);
    const ids = ["sc-usr_alice-kitchen"];
    await Promise.all([first.sendTts("kitchen", "раз"), second.sendTts("kitchen", "два"), first.sendCommand("kitchen", "стоп")]);
    expect(log).toEqual(Array(3).fill([`start ${ids[0]}`, `end ${ids[0]}`]).flat());
  });

  it("two users never wait on each other, even with the same device id", async () => {
    const log: string[] = [];
    await Promise.all([timedClient("usr_alice", log).sendTts("speaker", "раз"), timedClient("usr_bob", log).sendTts("speaker", "два")]);
    expect(serialized(log, "sc-usr_alice-speaker", "sc-usr_bob-speaker")).toBe(false);
  });
});

// Every method returns a Promise, like the production PostgreSQL backend.
function asynchronous(storage: OAuthStorage): IStorage {
  return new Proxy(storage, { get(target, prop) {
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? async (...args: unknown[]) => value.apply(target, args) : value;
  } });
}

describe("two users at once in hosted mode", () => {
  let db: OAuthStorage;
  let storage: IStorage;
  const users = ["alice", "bob"] as const;
  beforeEach(async () => {
    db = new OAuthStorage(":memory:");
    storage = asynchronous(db);
    for (const id of users) {
      await storage.saveUser({ id, yandexUid: id, createdAt: Date.now(), updatedAt: Date.now() });
      await storage.saveUserCredentials(id, { yandexAccessToken: `upstream-${id}`, quasarCookie: `Session_id=${id}` });
      await storage.saveToken({ accessToken: `mcp-${id}`, refreshToken: `rt-${id}`, userId: id, clientId: "client", scope: "iot:view quasar",
        yandexAccessToken: "stale", createdAt: Date.now(), expiresAt: Date.now() + 3600000 });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  // Two Yandex accounts behind one fetch: each request is answered from the
  // account its credentials name, and any cross-account reference is recorded.
  function fakeYandex() {
    const scenarios: Record<string, string[]> = { alice: [], bob: [] };
    const spoken: Array<{ owner: string; deviceName: string }> = [];
    const violations: string[] = [];
    let created = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      await tick(Math.floor(Math.random() * 8));
      if (url.startsWith("https://api.iot.yandex.net/")) {
        const owner = /^Bearer upstream-(alice|bob)$/.exec(headers.get("authorization") || "")?.[1];
        if (!owner) { violations.push(`IoT call with ${headers.get("authorization")}`); return new Response("{}", { status: 401 }); }
        return Response.json({ status: "ok", rooms: [], scenarios: [], devices: [
          { id: "speaker", name: `Станция ${owner}`, type: "devices.types.smart_speaker.yandex.station", capabilities: [] },
        ] });
      }
      if (url === "https://yandex.ru/iot/") return new Response('{"csrfToken2":"csrf"}');
      const owner = /(?:^|;\s*)Session_id=(alice|bob)(?:;|$)/.exec(headers.get("cookie") || "")?.[1];
      if (!owner) { violations.push(`Quasar call ${url} with cookie ${headers.get("cookie")}`); return new Response("{}", { status: 401 }); }
      const method = init?.method || "GET";
      if (url === "https://iot.quasar.yandex.ru/m/user/scenarios" && method === "GET") {
        return Response.json({ status: "ok", scenarios: scenarios[owner].map((id) => ({ id, name: `mctl-${owner}-speaker` })) });
      }
      if (url === "https://iot.quasar.yandex.ru/m/user/scenarios" && method === "POST") {
        const id = `sc-${owner}-${++created}`;
        scenarios[owner].push(id);
        return Response.json({ status: "ok", scenario_id: id });
      }
      const target = /\/scenarios\/([^/]+)(\/actions)?$/.exec(url);
      if (target) {
        if (!scenarios[owner].includes(target[1])) violations.push(`${owner} touched ${target[1]}`);
        if (method === "PUT") spoken.push({ owner, deviceName: JSON.parse(String(init?.body)).name });
        return Response.json({ status: "ok" });
      }
      violations.push(`unexpected ${method} ${url}`);
      return Response.json({ status: "error" });
    });
    return { scenarios, spoken, violations };
  }
  const request = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as unknown as http.IncomingMessage;

  it("interleaved sessions see only their own devices, cookies and proxy scenarios", async () => {
    const yandex = fakeYandex();
    const run = async (id: (typeof users)[number], phrase: string) => {
      const auth = await authenticateRequest(request(`mcp-${id}`), undefined, undefined, storage, undefined, true);
      if (!auth.authenticated) throw new Error("Expected success");
      expect(auth.userId).toBe(id);
      const devices = await auth.service.listDevices();
      expect(JSON.stringify(devices)).toContain(`Станция ${id}`);
      expect(JSON.stringify(devices)).not.toContain(`Станция ${id === "alice" ? "bob" : "alice"}`);
      const spoken = await auth.service.sayPhrase(phrase);
      expect(spoken.speaker.name).toBe(`Станция ${id}`);
    };
    // Two rounds: the second one starts while caches from the first are warm.
    await Promise.all([run("alice", "раз"), run("bob", "раз")]);
    await Promise.all([run("bob", "два"), run("alice", "два")]);

    expect(yandex.violations).toEqual([]);
    for (const id of users) {
      // One proxy scenario per account, recorded for its owner only.
      expect(yandex.scenarios[id]).toHaveLength(1);
      expect(await storage.getQuasarScenario(id, "speaker")).toBe(yandex.scenarios[id][0]);
      expect(yandex.spoken.filter((s) => s.owner === id).map((s) => s.deviceName)).toEqual([`mctl-${id}-speaker`, `mctl-${id}-speaker`]);
    }
  });
});
