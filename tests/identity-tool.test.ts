import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { createHttpServer } from "../src/server/http-server.js";
import { ALICE_TOOLS } from "../src/tools/definitions.js";
import { handleToolCall, checkScope, MAX_ACCOUNT_ID_LENGTH, type ToolCallContext } from "../src/tools/handlers.js";
import { StationService } from "../src/services/station-service.js";

const TOOL = "alice_get_my_identity";

/** A service whose every method throws: the tool must not touch it. */
const untouchableService = new Proxy({}, {
  get: (_target, prop) => {
    if (prop === "then") return undefined;
    throw new Error(`${TOOL} reached StationService.${String(prop)}`);
  },
}) as unknown as StationService;

const account = (yandexUid: unknown, id: unknown = "usr_synthetic_1"): ToolCallContext => ({
  getAccount: () => ({ id, yandexUid }),
});

const call = (context?: ToolCallContext, scope = "iot:view") =>
  handleToolCall(TOOL, {}, untouchableService, scope, context);

/** An error result carries no id anywhere: not structured, not in the text. */
function expectRefused(res: Awaited<ReturnType<typeof call>>, leaked?: string) {
  expect(res.isError).toBe(true);
  expect(res.structuredContent).toBeUndefined();
  expect(res.content).toHaveLength(1);
  expect(res.content[0].text).not.toContain("account_id");
  if (leaked) expect(res.content[0].text).not.toContain(leaked);
}

describe("alice_get_my_identity descriptor", () => {
  const tool = ALICE_TOOLS.find((t) => t.name === TOOL)!;

  it("takes no arguments and is annotated as a local read", () => {
    expect(tool.inputSchema).toEqual({ type: "object", properties: {} });
    expect(tool.annotations).toEqual({
      title: "Get my mctl-alice account ID",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("is granted by iot:view and by iot:control, and by nothing else", () => {
    expect(checkScope(TOOL, "iot:view")).toBe(true);
    expect(checkScope(TOOL, "iot:control")).toBe(true);
    expect(checkScope(TOOL, "quasar")).toBe(false);
    expect(checkScope(TOOL, "")).toBe(false);
    expect(checkScope(TOOL, undefined)).toBe(false);
  });
});

describe("alice_get_my_identity handler", () => {
  it("returns the stored yandexUid as account_id and nothing else", async () => {
    const res = await call(account("700000001"));
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ account_id: "700000001" });
    expect(Object.keys(res.structuredContent!)).toEqual(["account_id"]);
    expect(res.content).toEqual([{ type: "text", text: "account_id: 700000001" }]);
    expect(Object.keys(res).sort()).toEqual(["content", "structuredContent"]);
  });

  it("does not pass on any other field of the stored account", async () => {
    const res = await call({
      getAccount: () => ({
        id: "usr_synthetic_1", yandexUid: "700000001", login: "synthetic-login",
        displayName: "Synthetic Name", createdAt: 1, updatedAt: 2,
      }),
    });
    expect(res.structuredContent).toEqual({ account_id: "700000001" });
    expect(JSON.stringify(res)).not.toMatch(/synthetic-login|Synthetic Name|usr_synthetic_1/);
  });

  it("is refused without iot:view or iot:control, like the read tools", async () => {
    const getAccount = vi.fn(() => ({ id: "usr_synthetic_1", yandexUid: "700000001" }));
    for (const scope of ["quasar", "", "unknown:scope"]) {
      const res = await handleToolCall(TOOL, {}, untouchableService, scope, { getAccount });
      expectRefused(res, "700000001");
      expect(res.content[0].text).toContain("недостаточно прав доступа");
      const read = await handleToolCall("alice_list_devices", {}, untouchableService, scope);
      expect(read.content[0].text).toContain("недостаточно прав доступа");
    }
    expect(getAccount).not.toHaveBeenCalled();
  });

  it("answers with an error when there is no account to read", async () => {
    // stdio and single-user HTTP pass no context at all.
    expectRefused(await call(undefined));
    expectRefused(await call({}));
    expectRefused(await call({ getAccount: () => null }));
    expectRefused(await call({ getAccount: () => undefined }));
    expectRefused(await call({ getAccount: async () => null }));
  });

  it("answers with an error, not the storage message, when the read fails", async () => {
    const res = await call({ getAccount: async () => { throw new Error("synthetic-storage-detail"); } });
    expectRefused(res, "synthetic-storage-detail");
  });

  it("refuses the placeholder accounts even when they carry an id", async () => {
    expectRefused(await call(account("local_uid", "usr_local")), "local_uid");
    expectRefused(await call(account("700000001", "legacy_user")), "700000001");
    expectRefused(await call(account("700000001", "")), "700000001");
    expectRefused(await call(account("700000001", null)), "700000001");
    expectRefused(await call(account("700000001", 42)), "700000001");
  });

  it("refuses a missing, empty, non-string or malformed stored id", async () => {
    for (const bad of [undefined, null, "", " ", 700000001, "7000 00001", "700000001\n", "ид", ["700000001"]]) {
      expectRefused(await call(account(bad)));
    }
  });

  it("accepts an id of exactly the maximum length and refuses one longer", async () => {
    const longest = "7".repeat(MAX_ACCOUNT_ID_LENGTH);
    expect(MAX_ACCOUNT_ID_LENGTH).toBe(128);
    expect((await call(account(longest))).structuredContent).toEqual({ account_id: longest });
    expectRefused(await call(account(longest + "7")), longest);
  });
});

describe("alice_get_my_identity over hosted HTTP", () => {
  let storage: OAuthStorage;
  let server: http.Server;
  let base = "";
  let realFetch: typeof fetch;
  let outbound: string[];

  const addUser = (id: string, yandexUid: string, token: string, scope: string) => {
    storage.saveUser({ id, yandexUid, login: `login-${id}`, displayName: `Name ${id}`, createdAt: Date.now(), updatedAt: Date.now() });
    storage.saveUserCredentials(id, { yandexAccessToken: `y-${id}` });
    storage.saveToken({ accessToken: token, refreshToken: `rt-${token}`, clientId: "client-synthetic", userId: id,
      yandexAccessToken: `y-${id}`, scope, createdAt: Date.now(), expiresAt: Date.now() + 3_600_000 });
  };

  const rpc = async (token: string | undefined, method: string, params?: unknown) => {
    const res = await realFetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    // A JSON-RPC answer arrives either as plain JSON or as one SSE data line.
    const data = /^data: (.*)$/m.exec(text)?.[1] ?? text;
    let body: any = null;
    try { body = JSON.parse(data); } catch { /* not JSON: an error page */ }
    return { status: res.status, text, body };
  };
  const identity = (token: string | undefined) => rpc(token, "tools/call", { name: TOOL, arguments: {} });

  const start = async (authRequired: boolean) => {
    server = createHttpServer(0, { publicBaseUrl: "http://localhost", authRequired, oauthStorage: storage, enableSampler: false });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  };

  beforeEach(() => {
    storage = new OAuthStorage(":memory:");
    addUser("usr_synthetic_a", "700000001", "tok_a", "iot:view");
    addUser("usr_synthetic_b", "700000002", "tok_b", "iot:control");
    addUser("usr_synthetic_c", "700000003", "tok_c", "quasar");
    realFetch = globalThis.fetch;
    outbound = [];
    // The test reaches its own server through realFetch; anything the server
    // sends through fetch would be a call to Yandex.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      outbound.push(String(input?.url ?? input));
      return new Response("{}", { status: 500 });
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("gives each token its own account id", async () => {
    await start(true);
    const a = await identity("tok_a");
    const b = await identity("tok_b");
    expect(a.body.result.isError).toBeFalsy();
    expect(a.body.result.structuredContent).toEqual({ account_id: "700000001" });
    expect(a.body.result.content).toEqual([{ type: "text", text: "account_id: 700000001" }]);
    expect(b.body.result.structuredContent).toEqual({ account_id: "700000002" });
    expect(JSON.stringify(a.body)).not.toContain("700000002");
    expect(JSON.stringify(b.body)).not.toContain("700000001");
    // Asking again, after the other user did, still answers for the token.
    expect((await identity("tok_a")).body.result.structuredContent).toEqual({ account_id: "700000001" });
  });

  it("returns no name, login or internal user id", async () => {
    await start(true);
    const text = JSON.stringify((await identity("tok_a")).body);
    expect(text).not.toMatch(/login-usr|Name usr|usr_synthetic|y-usr/);
  });

  it("lists the tool for iot:view and iot:control, and not for quasar alone", async () => {
    await start(true);
    const names = async (token: string) => ((await rpc(token, "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name);
    expect(await names("tok_a")).toContain(TOOL);
    expect(await names("tok_b")).toContain(TOOL);
    expect(await names("tok_c")).not.toContain(TOOL);
    const refused = (await identity("tok_c")).body.result;
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toBeUndefined();
    expect(refused.content[0].text).toContain("недостаточно прав доступа");
  });

  it("calls no external service and writes nothing", async () => {
    await start(true);
    const writes = ["recordToolCall", "saveUser", "saveUserCredentials", "saveToken"] as const;
    const spies = writes.map((name) => vi.spyOn(storage, name));
    expect((await identity("tok_a")).body.result.structuredContent).toEqual({ account_id: "700000001" });
    await new Promise((r) => setTimeout(r, 50));
    expect(outbound).toEqual([]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(storage.getUsageTotals().toolCalls).toBe(0);
  });

  it("answers with an error when the stored id is empty or over-long", async () => {
    await start(true);
    const db = (storage as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    const setUid = (uid: string) => db.prepare("UPDATE users SET yandex_uid = ? WHERE id = ?").run(uid, "usr_synthetic_a");
    for (const uid of ["", "7".repeat(129)]) {
      setUid(uid);
      const result = (await identity("tok_a")).body.result;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content[0].text).not.toContain("account_id");
    }
    // The other user is unaffected.
    expect((await identity("tok_b")).body.result.structuredContent).toEqual({ account_id: "700000002" });
  });

  /** Lets the first `passes` reads of the account through, then runs `then`. */
  const afterReads = (passes: number, then: () => null) => {
    const real = storage.getUser.bind(storage);
    let reads = 0;
    return vi.spyOn(storage, "getUser").mockImplementation((id: string) => (reads++ < passes ? real(id) : then()));
  };
  const expectErrorResult = (res: Awaited<ReturnType<typeof identity>>) => {
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.structuredContent).toBeUndefined();
    expect(res.text).not.toContain("account_id");
    expect(res.text).not.toContain("700000001");
  };

  it("refuses the token of a deleted account", async () => {
    // Its own token: the server remembers a refused token across instances.
    addUser("usr_synthetic_d", "700000004", "tok_deleted", "iot:view");
    await start(true);
    expect((await identity("tok_deleted")).body.result.structuredContent).toEqual({ account_id: "700000004" });
    storage.deleteUser("usr_synthetic_d");
    const res = await identity("tok_deleted");
    expect(res.status).toBe(401);
    expect(res.text).not.toContain("700000004");
  });

  it("answers with an error when the account disappears after the token was admitted", async () => {
    await start(true);
    // One read admits the token, the next one is the tool's own.
    const getUser = afterReads(1, () => null);
    expectErrorResult(await identity("tok_a"));
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("answers with an error, without the storage message, when the account read fails", async () => {
    await start(true);
    const getUser = afterReads(1, () => { throw new Error("synthetic-storage-detail"); });
    const res = await identity("tok_a");
    expectErrorResult(res);
    expect(res.text).not.toContain("synthetic-storage-detail");
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("answers for the session's own token over the SSE transport", async () => {
    await start(true);
    const ask = async (token: string) => {
      const abort = new AbortController();
      const stream = await realFetch(`${base}/sse`, { signal: abort.signal, headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } });
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      const until = async (pattern: RegExp) => {
        for (;;) {
          const match = pattern.exec(seen);
          if (match) return match;
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`SSE stream ended before ${pattern}`);
          seen += decoder.decode(chunk.value, { stream: true });
        }
      };
      try {
        const session = (await until(/sessionId=([^\s]+)/))[1];
        const send = (message: unknown) => realFetch(`${base}/messages?sessionId=${session}`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(message),
        });
        expect((await send({ jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "synthetic-client", version: "0" } } })).status).toBe(202);
        await send({ jsonrpc: "2.0", method: "notifications/initialized" });
        expect((await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: TOOL, arguments: {} } })).status).toBe(202);
        return JSON.parse((await until(/data: (\{[^\n]*"id":2[^\n]*\})/))[1]).result;
      } finally {
        abort.abort();
        await reader.cancel().catch(() => {});
      }
    };
    expect((await ask("tok_a")).structuredContent).toEqual({ account_id: "700000001" });
    expect((await ask("tok_b")).structuredContent).toEqual({ account_id: "700000002" });
    expect(outbound).toEqual([]);
  });

  it("refuses an unauthenticated call", async () => {
    await start(true);
    const res = await identity(undefined);
    expect(res.status).toBe(401);
    expect(res.text).not.toContain("account_id");
  });

  it("answers with an error in single-user mode, where no account stands behind the call", async () => {
    // The single-user server keeps its one owner under a placeholder id.
    storage.saveUser({ id: "usr_local", yandexUid: "local_uid", createdAt: Date.now(), updatedAt: Date.now() });
    await start(false);
    const res = await identity(undefined);
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.structuredContent).toBeUndefined();
    expect(res.text).not.toContain("account_id");
    expect(res.text).not.toContain("local_uid");
  });
});
