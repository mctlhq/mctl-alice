import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { authenticateRequest, createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { TelemetryStorage } from "../src/storage/telemetry-storage.js";
import { IStorage } from "../src/storage/storage-interface.js";
import { YandexIoTClient } from "../src/client/yandex-api.js";
import { QuasarClient } from "../src/client/quasar-client.js";
import { StationService } from "../src/services/station-service.js";
import { OAuthController } from "../src/auth/oauth-controller.js";
import { ALICE_TOOLS } from "../src/tools/definitions.js";
import { checkScope, TOOL_SCOPES } from "../src/tools/handlers.js";

const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const realFetch = globalThis.fetch;
// Stubs Quasar: lists the given scenarios and records which ones get deleted.
function stubQuasar(scenarios: Array<{ id: string; name: string }>): string[] {
  const deleted: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://yandex.ru/iot/") return new Response('{"csrfToken2":"csrf"}');
    if (url === "https://iot.quasar.yandex.ru/m/user/scenarios") return Response.json({ status: "ok", scenarios });
    const del = url.match(/^https:\/\/iot\.quasar\.yandex\.ru\/m\/v4\/user\/scenarios\/([^/]+)$/);
    if (del && init?.method === "DELETE") { deleted.push(decodeURIComponent(del[1])); return Response.json({ status: "ok" }); }
    if (url.startsWith("https://")) throw new Error(`unexpected upstream call ${url}`);
    return realFetch(input, init);
  });
  return deleted;
}
const request = (token?: string) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} }) as http.IncomingMessage;
const now = Date.now();
function seed(storage: IStorage, id: string, scope = "iot:view iot:control quasar") {
  return (async () => {
    await storage.saveUser({ id, yandexUid: id, createdAt: now, updatedAt: now });
    await storage.saveUserCredentials(id, { yandexAccessToken: `upstream-${id}`, yandexRefreshToken: `refresh-${id}`, quasarCookie: `Session_id=${id}` });
    await storage.saveToken({ accessToken: `mcp-${id}`, refreshToken: `rt-${id}`, userId: id, clientId: "client", scope,
      yandexAccessToken: "stale-upstream", yandexRefreshToken: "stale-refresh", createdAt: now, expiresAt: now + 3600000 });
  })();
}

// Every method returns a Promise, like the production PostgreSQL backend.
function asynchronous(storage: OAuthStorage): IStorage {
  return new Proxy(storage, { get(target, prop) {
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? async (...args: unknown[]) => value.apply(target, args) : value;
  } });
}

describe("hosted access boundary", () => {
  let db: OAuthStorage;
  let storage: IStorage;
  let telemetry: TelemetryStorage;
  let server: http.Server | undefined;
  let base: string;
  beforeEach(async () => {
    vi.stubEnv("YANDEX_OAUTH_TOKEN", "shared-home");
    vi.stubEnv("YANDEX_REFRESH_TOKEN", "shared-refresh");
    vi.stubEnv("YANDEX_COOKIE", "Session_id=shared-home");
    db = new OAuthStorage(":memory:"); storage = asynchronous(db); telemetry = new TelemetryStorage(":memory:");
    await seed(storage, "alice"); await seed(storage, "bob", "iot:view");
    await storage.saveClient({ clientId: "client", clientSecret: "", clientName: "Test client", redirectUris: ["http://localhost/callback"], createdAt: now });
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    db.close(); telemetry.close();
  });
  const authenticate = (storage: IStorage, token?: string) => authenticateRequest(request(token), undefined, undefined, storage, undefined, true);
  async function start() {
    server = createHttpServer(0, { publicBaseUrl: "http://localhost", authRequired: true, oauthStorage: storage, storage: telemetry, enableSampler: false });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  }
  it("awaits storage and resolves each user's current credentials, never token copies or env", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "ok", devices: [], rooms: [], scenarios: [] })));
    for (const id of ["alice", "bob"]) {
      const auth = await authenticate(storage, `mcp-${id}`);
      expect(auth.authenticated).toBe(true);
      if (!auth.authenticated) throw new Error("Expected success");
      expect(auth.userId).toBe(id); expect(auth.clientId).toBe("client");
      await auth.service.listDevices();
      expect(fetchMock.mock.lastCall?.[1]?.headers).toMatchObject({ Authorization: `Bearer upstream-${id}` });
      expect(!!auth.service.getQuasarClient()).toBe(id === "alice");
    }
  });
  it.each([undefined, "random", "shared-home", "y0_upstream"])("rejects %s without upstream calls", async token => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const auth = await authenticate(storage, token);
    expect(auth).toMatchObject({ authenticated: false, status: 401 }); expect(auth.service).toBeUndefined(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["legacy_user", "usr_local", "missing", ""])("rejects invalid owner %s", async userId => {
    const record = db.getToken("mcp-alice")!; db.saveToken({ ...record, userId });
    expect(await authenticate(storage, "mcp-alice")).toMatchObject({ authenticated: false, status: 401 });
  });
  it.each(["", "*", "unknown", "iot:view unknown"])("rejects invalid scope %s", async scope => {
    const record = db.getToken("mcp-alice")!; db.saveToken({ ...record, scope });
    expect(await authenticate(storage, "mcp-alice")).toMatchObject({ authenticated: false, status: 401 });
  });
  it("rejects expired and revoked grants", async () => {
    const record = db.getToken("mcp-alice")!; db.saveToken({ ...record, expiresAt: now - 1 });
    expect(await authenticate(storage, "mcp-alice")).toMatchObject({ authenticated: false, status: 401 });
    await storage.revokeUserGrant("bob", "client");
    expect(await authenticate(storage, "mcp-bob")).toMatchObject({ authenticated: false, status: 401 });
    expect(await storage.getTokenByRefreshToken("rt-bob")).toBeNull();
  });
  it.each(["getToken", "getUser", "getUserCredentials"] as const)("fails closed on %s failure", async method => {
    vi.spyOn(db, method).mockImplementation(() => { throw new Error("database or ciphertext failure"); });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await authenticate(storage, "mcp-alice")).toMatchObject({ authenticated: false, status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("never loads shared credentials when a hosted credential is missing", async () => {
    expect(() => new YandexIoTClient(undefined, { credentialsMode: "hosted" })).toThrow();
    expect(new QuasarClient({ credentialsMode: "hosted" }).hasCookie()).toBe(false);
    const service = new StationService(undefined, undefined, undefined, "hosted");
    await expect(service.listDevices()).rejects.toThrow("Reconnect");
    await expect(service.getDeviceHistory({ device: "same" })).rejects.toThrow("not recorded in the hosted service");
    await storage.saveUserCredentials("alice", { yandexAccessToken: "upstream-alice", quasarCookie: undefined });
    const auth = await authenticate(storage, "mcp-alice");
    if (!auth.authenticated) throw new Error("IoT remains available");
    expect(auth.service.getQuasarClient()).toBeNull();
    await expect(auth.service.sayPhrase("test")).rejects.toThrow("Connect Quasar");
    await storage.deleteUserCredentials("alice");
    expect(await authenticate(storage, "mcp-alice")).toMatchObject({ authenticated: false, status: 401 });
  });
  it("refresh uses and persists only the current user's upstream refresh token", async () => {
    vi.stubEnv("YANDEX_CLIENT_ID", "app"); vi.stubEnv("YANDEX_CLIENT_SECRET", "app-secret");
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push([String(input), init]);
      if (String(input).includes("oauth.yandex")) return new Response(JSON.stringify({ access_token: "new-alice", refresh_token: "new-refresh", expires_in: 3600 }));
      return new Response(JSON.stringify({ status: "ok", devices: [], rooms: [], scenarios: [] }), { status: calls.length === 1 ? 401 : 200 });
    });
    const auth = await authenticate(storage, "mcp-alice"); if (!auth.authenticated) throw new Error("Expected success");
    await auth.service.listDevices();
    expect(String(calls[1][1]?.body)).toContain("refresh-alice");
    expect(await storage.getUserCredentials("alice")).toMatchObject({ yandexAccessToken: "new-alice", yandexRefreshToken: "new-refresh" });
    expect(await storage.getUserCredentials("bob")).toMatchObject({ yandexAccessToken: "upstream-bob" });
  });
  it("covers every advertised tool with deny-by-default permissions", () => {
    for (const tool of ALICE_TOOLS) { expect(TOOL_SCOPES[tool.name]).toBeDefined(); expect(checkScope(tool.name, "")).toBe(false); }
    expect(checkScope("alice_say_phrase", "iot:control")).toBe(false);
    expect(checkScope("alice_set_light", "iot:view")).toBe(false);
  });
  it("enforces the same identity and permissions on REST, MCP and batch", async () => {
    await start();
    for (const path of ["/mcp", "/api/devices", "/sse"]) {
      const response = await realFetch(base + path, { headers: { Authorization: "Bearer random" } }); expect(response.status).toBe(401);
    }
    const headers = { Authorization: "Bearer mcp-bob", "Content-Type": "application/json" };
    const rest = await realFetch(base + "/api/say", { method: "POST", headers, body: '{"phrase":"test"}' });
    expect(rest.status).toBe(403); expect(rest.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    const batch = await realFetch(base + "/mcp", { method: "POST", headers, body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "alice_set_light", arguments: { device: "same" } } },
    ]) });
    const data = await batch.json(); expect(data[0].result.tools).toHaveLength(4); expect(data[1].result.isError).toBe(true);
    const cookie = await realFetch(base + "/mcp", { headers: { ...headers, "x-yandex-cookie": "Session_id=other" } }); expect(cookie.status).toBe(401);
    vi.spyOn(db, "getToken").mockImplementation(() => { throw new Error("offline"); });
    expect((await realFetch(base + "/mcp", { headers })).status).toBe(503);
  });
  it("binds SSE messages to token, user and client, and rechecks revocation", async () => {
    await start(); const abort = new AbortController();
    const response = await realFetch(base + "/sse", { signal: abort.signal, headers: { Authorization: "Bearer mcp-alice", Accept: "text/event-stream" } });
    const reader = response.body!.getReader(); const first = new TextDecoder().decode((await reader.read()).value);
    const session = /sessionId=([^\s]+)/.exec(first)![1];
    const post = (token?: string) => realFetch(base + `/messages?sessionId=${session}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect((await post()).status).toBe(401); expect((await post("mcp-bob")).status).toBe(401);
    expect((await post("mcp-alice")).status).toBe(202);
    await storage.revokeUserGrant("alice", "client"); expect((await post("mcp-alice")).status).toBe(401);
    abort.abort(); await reader.cancel().catch(() => {});
  });
  it("offers recovery for corrupt credentials while MCP remains fail-closed", async () => {
    const sql = (db as unknown as { db: DatabaseSync }).db;
    sql.exec("UPDATE user_credentials SET encrypted_yandex_access_token='corrupt' WHERE user_id='alice'");
    await storage.saveWebSession("browser-a", "alice", Date.now() + 60000);
    await start();
    const page = await realFetch(base + "/account", { headers: { Cookie: "mctl_session=browser-a" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Reconnect your Yandex account");
    expect(await authenticate(storage, "mcp-alice")).toMatchObject({ authenticated: false, status: 503 });
    expect(await authenticate(storage, "mcp-bob")).toMatchObject({ authenticated: true });
  });
  it("requires S256 for new hosted grants and validates the verifier", async () => {
    const controller = new OAuthController({ baseUrl: "http://localhost", yandexClientId: "app", storage, authRequired: true });
    const params = { client_id: "client", redirect_uri: "http://localhost/callback", userId: "alice", scope: "iot:view" };
    for (const pkce of [{}, { code_challenge: challenge, code_challenge_method: "plain" }]) {
      expect(await controller.handleAuthorize({ ...params, ...pkce })).toMatchObject({ error: "invalid_request" });
    }
    for (const codeVerifier of [undefined, "wrong", verifier]) {
      const consent = await controller.handleAuthorize({ ...params, code_challenge: challenge, code_challenge_method: "S256" });
      if (!("sessionId" in consent)) throw new Error("Expected consent");
      const approval = await controller.approveAuthorization(consent.sessionId, "alice");
      const exchange = controller.handleToken({ grant_type: "authorization_code", client_id: "client", redirect_uri: params.redirect_uri, code: new URL(approval.redirectUrl).searchParams.get("code")!, code_verifier: codeVerifier });
      if (codeVerifier === verifier) expect(await exchange).toMatchObject({ scope: "iot:view" });
      else await expect(exchange).rejects.toThrow();
    }
  });
  it("hosted consent requires an existing owner and never honors auto approval", async () => {
    const controller = new OAuthController({ baseUrl: "http://localhost", yandexClientId: "app", storage, authRequired: true });
    const params = { client_id: "client", redirect_uri: "http://localhost/callback", scope: "iot:view", auto_approve: true, code_challenge: challenge, code_challenge_method: "S256" };
    expect(await controller.handleAuthorize(params)).toMatchObject({ error: "login_required" });
    const consent = await controller.handleAuthorize({ ...params, userId: "alice" }); expect(consent).toMatchObject({ type: "consent" });
    if (!("sessionId" in consent)) throw new Error("Expected consent");
    await expect(controller.approveAuthorization(consent.sessionId, "bob")).rejects.toThrow();
    await expect(controller.approveAuthorization(consent.sessionId, "alice", "iot:control")).rejects.toThrow();
    const legacy = db.getToken("mcp-alice")!; db.saveToken({ ...legacy, userId: "legacy_user" });
    await expect(controller.handleToken({ grant_type: "refresh_token", refresh_token: "rt-alice", client_id: "client" })).rejects.toThrow("Invalid grant");
  });
  it("browser consent rejects GET approval, forged POST, and another browser", async () => {
    await start();
    await storage.saveWebSession("browser-a", "alice", Date.now() + 60000);
    await storage.saveWebSession("browser-b", "bob", Date.now() + 60000);
    const query = "/oauth/authorize?client_id=client&redirect_uri=http://localhost/callback&scope=iot:view&auto_approve=true&code_challenge_method=S256&code_challenge=" + challenge;
    const login = await realFetch(base + query, { redirect: "manual" }); expect(login.status).toBe(302); expect(login.headers.get("location")).toMatch(/^\/auth\/login/);
    const consent = await realFetch(base + query, { headers: { Cookie: "mctl_session=browser-a" } });
    expect(consent.status).toBe(200); const html = await consent.text();
    const id = /name="session_id" value="([^"]+)"/.exec(html)![1];
    const get = await realFetch(base + `/oauth/authorize?session_id=${id}&action=approve`, { headers: { Cookie: "mctl_session=browser-a" }, redirect: "manual" });
    expect(get.headers.get("location") || "").not.toContain("code=");
    server!.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    await start(); // A different server instance must retain the browser-bound transaction.
    const body = `session_id=${id}&action=approve&scope_iot%3Aview=yes`;
    const forged = await realFetch(base + "/oauth/authorize", { method: "POST", headers: { Cookie: "mctl_session=browser-a", "Content-Type": "application/x-www-form-urlencoded" }, body }); expect(forged.status).toBe(403);
    const wrong = await realFetch(base + "/oauth/authorize", { method: "POST", headers: { Cookie: "mctl_session=browser-b", Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded" }, body }); expect(wrong.status).toBe(400);
    const ok = await realFetch(base + "/oauth/authorize", { method: "POST", headers: { Cookie: "mctl_session=browser-a", Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded" }, body, redirect: "manual" }); expect(ok.status).toBe(302); expect(ok.headers.get("location")).toContain("code=");
  });
  it("account grant revocation closes an already open SSE connection", async () => {
    await start(); await storage.saveWebSession("browser-a", "alice", Date.now() + 60000);
    const response = await realFetch(base + "/sse", { headers: { Authorization: "Bearer mcp-alice", Accept: "text/event-stream" } });
    const reader = response.body!.getReader(); await reader.read();
    const revoke = await realFetch(base + "/account/revoke-grant", { method: "POST", headers: { Cookie: "mctl_session=browser-a", Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded" }, body: "client_id=client", redirect: "manual" });
    expect(revoke.status).toBe(302); expect((await reader.read()).done).toBe(true);
    expect(await storage.getTokenByRefreshToken("rt-alice")).toBeNull();
  });
  it.each(["/account/delete", "/account/delete-all"])("%s erases every owner row and history and keeps other users", async path => {
    await start();
    await storage.saveWebSession("browser-a", "alice", Date.now() + 60000);
    await storage.saveWebSession("browser-a2", "alice", Date.now() + 60000);
    await storage.saveQuasarScenario("alice", "speaker", "scn-a");
    await storage.saveAuthCode({ code: "code-a", clientId: "client", redirectUri: "http://localhost/cb", userId: "alice", yandexAccessToken: "x", scope: "iot:view", createdAt: now, expiresAt: now + 60000 });
    for (const id of ["alice", "bob"]) await telemetry.forUser(id).saveSamples([{ deviceId: "d", deviceName: "d", metric: "power", value: 1, timestamp: now }]);
    const deleted = stubQuasar([{ id: "scn-a", name: "renamed by user" }, { id: "user-own", name: "Morning" }]);
    const response = await realFetch(base + path, { method: "POST", headers: { Cookie: "mctl_session=browser-a", Origin: "http://localhost" }, redirect: "manual" });
    expect(response.status).toBe(302); expect(response.headers.get("location")).toBe("/?deleted=true");
    expect(deleted).toEqual(["scn-a"]);
    expect(response.headers.get("set-cookie")).toMatch(/^mctl_session=;.*Max-Age=0/);
    expect(await storage.getUser("alice")).toBeNull();
    expect(await storage.getUserCredentials("alice")).toBeNull();
    expect(await storage.getToken("mcp-alice")).toBeNull();
    expect(await storage.getWebSession("browser-a2")).toBeNull();
    expect(await storage.listQuasarScenarios("alice")).toEqual([]);
    expect(await storage.consumeAuthCode("code-a")).toBeNull();
    expect((await telemetry.forUser("alice").getStats()).totalSamples).toBe(0);
    expect((await telemetry.forUser("bob").getStats()).totalSamples).toBe(1);
    expect(await storage.getToken("mcp-bob")).not.toBeNull();
  });
  it("account deletion still completes when Yandex scenarios cannot be removed, and says so", async () => {
    await start();
    await storage.saveWebSession("browser-a", "alice", Date.now() + 60000);
    await storage.saveQuasarScenario("alice", "speaker", "scn-a");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://")) return new Response("unavailable", { status: 503 });
      return realFetch(input, init);
    });
    const response = await realFetch(base + "/account/delete", { method: "POST", headers: { Cookie: "mctl_session=browser-a", Origin: "http://localhost" }, redirect: "manual" });
    expect(response.headers.get("location")).toBe("/?deleted=true&scenarios_left=true");
    expect(await storage.getUser("alice")).toBeNull();
  });
  it("disconnecting Quasar removes this user's proxy scenarios in Yandex and the cookie", async () => {
    await start();
    await storage.saveWebSession("browser-a", "alice", Date.now() + 60000);
    await storage.saveQuasarScenario("alice", "speaker", "scn-a");
    const deleted = stubQuasar([{ id: "scn-a", name: "x" }, { id: "user-own", name: "Morning" }]);
    const response = await realFetch(base + "/account/disconnect-quasar", { method: "POST", headers: { Cookie: "mctl_session=browser-a", Origin: "http://localhost" }, redirect: "manual" });
    expect(response.headers.get("location")).toBe("/account?quasar_disconnected=true");
    expect(deleted).toEqual(["scn-a"]);
    expect((await storage.getUserCredentials("alice"))?.quasarCookie).toBeUndefined();
    expect(await storage.listQuasarScenarios("alice")).toEqual([]);
  });
  it("a failed Yandex cleanup on disconnect keeps the recorded ids for a later retry", async () => {
    await start();
    await storage.saveWebSession("browser-a", "alice", Date.now() + 60000);
    await storage.saveQuasarScenario("alice", "speaker", "scn-a");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://")) return new Response("unavailable", { status: 503 });
      return realFetch(input, init);
    });
    const response = await realFetch(base + "/account/disconnect-quasar", { method: "POST", headers: { Cookie: "mctl_session=browser-a", Origin: "http://localhost" }, redirect: "manual" });
    expect(response.headers.get("location")).toBe("/account?quasar_disconnected=true&scenarios_left=true");
    expect((await storage.getUserCredentials("alice"))?.quasarCookie).toBeUndefined();
    expect(await storage.listQuasarScenarios("alice")).toHaveLength(1);
  });
  it("account deletion without a session deletes nothing", async () => {
    await start();
    const response = await realFetch(base + "/account/delete", { method: "POST", headers: { Origin: "http://localhost" }, redirect: "manual" });
    expect(response.status).toBe(302);
    expect(await storage.getUser("alice")).not.toBeNull(); expect(await storage.getUser("bob")).not.toBeNull();
  });
  it("logout ends only the browser session and keeps MCP grants", async () => {
    await start();
    await storage.saveWebSession("browser-a", "alice", Date.now() + 60000);
    await storage.saveWebSession("browser-a2", "alice", Date.now() + 60000);
    const response = await realFetch(base + "/account/logout", { method: "POST", headers: { Cookie: "mctl_session=browser-a", Origin: "http://localhost" }, redirect: "manual" });
    expect(response.status).toBe(302); expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toMatch(/^mctl_session=;.*Max-Age=0/);
    expect(await storage.getWebSession("browser-a")).toBeNull();
    expect(await storage.getWebSession("browser-a2")).not.toBeNull();
    expect(await storage.getToken("mcp-alice")).not.toBeNull();
  });
  it("account forms post only to routes that exist", async () => {
    await start(); await storage.saveWebSession("browser-a", "alice", Date.now() + 60000);
    const html = await (await realFetch(base + "/account", { headers: { Cookie: "mctl_session=browser-a" } })).text();
    const actions = [...html.matchAll(/<form[^>]*action="([^"]+)"/g)].map(m => m[1]);
    expect(actions).toEqual(expect.arrayContaining(["/account/logout", "/account/delete"]));
    for (const action of actions) {
      const probe = await realFetch(base + action, { method: "POST", headers: { Origin: "http://localhost" }, redirect: "manual" });
      expect(probe.status, action).not.toBe(404);
    }
  });
  it("readiness fails when storage cannot be read", async () => {
    await start(); expect((await realFetch(base + "/readyz")).status).toBe(200);
    vi.spyOn(db, "getUser").mockImplementation(() => { throw new Error("offline"); });
    // Past the one-second window in which probes share a storage round-trip.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 1500);
    expect((await realFetch(base + "/readyz")).status).toBe(503);
  });

  it("readiness pings telemetry storage and never counts its rows", async () => {
    // getStats() is a sequential scan of the whole samples table; on 1.3M rows a probe cost ~2.5 s of disk reads.
    await start();
    const ping = vi.spyOn(telemetry, "ping");
    const getStats = vi.spyOn(telemetry, "getStats");
    expect((await realFetch(base + "/readyz")).status).toBe(200);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(getStats).not.toHaveBeenCalled();
  });
  it("readiness fails when telemetry storage cannot answer", async () => {
    await start(); expect((await realFetch(base + "/readyz")).status).toBe(200);
    vi.spyOn(telemetry, "ping").mockImplementation(() => { throw new Error("offline"); });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 1500);
    expect((await realFetch(base + "/readyz")).status).toBe(503);
  });

  it("preserves local OAuth grants without accepting them in hosted mode", async () => {
    const record = db.getToken("mcp-alice")!; db.saveToken({ ...record, userId: "legacy_user" });
    const local = new StationService();
    expect(await authenticateRequest(request("mcp-alice"), local, undefined, storage, telemetry, false)).toMatchObject({ authenticated: true, mode: "local", service: local });
    expect(await authenticate(storage, "mcp-alice")).toMatchObject({ authenticated: false, status: 401 });
  });

  it("isolates control and Quasar upstream headers for two users with identical device IDs", async () => {
    await seed(storage, "bob");
    for (const id of ["alice", "bob"]) {
      const calls: Array<{ url: string; headers: Headers }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input); calls.push({ url, headers: new Headers(init?.headers) });
        if (url === "https://yandex.ru/iot/") return new Response('{"csrfToken2":"test-csrf"}');
        if (url.includes("/user/info")) return new Response(JSON.stringify({ status: "ok", rooms: [], scenarios: [], devices: [
          { id: "lamp", name: "Lamp", type: "devices.types.light", capabilities: [{ type: "devices.capabilities.on_off", retrievable: true, state: { instance: "on", value: false } }] },
          { id: "speaker", name: "Speaker", type: "devices.types.smart_speaker", capabilities: [] },
        ] }));
        return new Response(JSON.stringify({ status: "ok", scenarios: [], scenario_id: "scenario", devices: [] }));
      });
      const record = db.getToken(`mcp-${id}`)!;
      db.saveToken({ ...record, scope: "iot:control" });
      let auth = await authenticate(storage, `mcp-${id}`); if (!auth.authenticated) throw new Error("Expected success");
      await auth.service.controlDevice({ device: "lamp", state: "on" });
      expect(calls.some(call => call.url.includes("/devices/actions"))).toBe(true);
      expect(calls.every(call => call.headers.get("authorization") === `Bearer upstream-${id}`)).toBe(true);
      calls.length = 0; db.saveToken(record);
      auth = await authenticate(storage, `mcp-${id}`); if (!auth.authenticated) throw new Error("Expected success");
      await auth.service.sayPhrase("test", "speaker");
      expect(calls.filter(call => call.url.includes("quasar")).every(call => call.headers.get("cookie") === `Session_id=${id}`)).toBe(true);
      expect(calls.some(call => call.url.endsWith("/actions"))).toBe(true);
      vi.restoreAllMocks();
    }
  });
  it("never uses the shared refresh token when the user has none", async () => {
    vi.stubEnv("YANDEX_CLIENT_ID", "app"); vi.stubEnv("YANDEX_CLIENT_SECRET", "app-secret");
    await storage.saveUserCredentials("alice", { yandexAccessToken: "expired", quasarCookie: undefined });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 401 }));
    const auth = await authenticate(storage, "mcp-alice"); if (!auth.authenticated) throw new Error("Expected success");
    await expect(auth.service.listDevices()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(String(fetchMock.mock.calls[0][0])).toContain("api.iot.yandex.net");
  });

});
