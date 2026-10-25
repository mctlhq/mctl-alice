import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { TelemetryStorage } from "../src/storage/telemetry-storage.js";
import { initQrAuth, checkQrAuthStatus } from "../src/auth/yandex-qr-auth.js";
import http from "node:http";
vi.mock("../src/auth/yandex-qr-auth.js", () => ({
  initQrAuth: vi.fn(async () => ({ sessionId: "test-qr", qrDataUrl: "data:image/png;base64,test" })),
  checkQrAuthStatus: vi.fn(async () => ({ status: "ok", cookie: "Session_id=alice-qr" })),
}));
const realFetch = globalThis.fetch;
// Yandex account behind each cookie, as https://yandex.ru/iot?storage=1 reports it.
const cookieUids: Record<string, string | null> = { "Session_id=alice-qr": "1001", "Session_id=alice-web": "1001", "Session_id=bob-web": "1002", "Session_id=anonymous": null };
const uids: Record<string, string> = { alice: "1001", bob: "1002" };
function stubYandex() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const cookie = String(new Headers(init?.headers).get("cookie"));
    if (url === "https://yandex.ru/iot?storage=1") return Response.json({ storage: { user: { uid: cookieUids[cookie] ?? null } } });
    if (url === "https://yandex.ru/iot/") return new Response('{"csrfToken2":"csrf"}');
    if (url.startsWith("https://")) throw new Error(`unexpected upstream call ${url}`);
    return realFetch(input, init);
  });
}
describe("hosted QR owner binding", () => {
  let storage: OAuthStorage, history: TelemetryStorage, server: http.Server, base: string;
  beforeEach(async () => {
    vi.clearAllMocks(); stubYandex(); storage = new OAuthStorage(":memory:"); history = new TelemetryStorage(":memory:");
    for (const id of ["alice", "bob"]) {
      storage.saveUser({ id, yandexUid: uids[id], createdAt: Date.now(), updatedAt: Date.now() });
      storage.saveUserCredentials(id, { yandexAccessToken: id });
      storage.saveWebSession(id, id, Date.now() + 60000);
    }
    server = createHttpServer(0, { publicBaseUrl: "http://localhost", authRequired: true, oauthStorage: storage, storage: history, enableSampler: false });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });
  afterEach(async () => { vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); storage.close(); history.close(); });
  it("only the initiating browser owner can finish QR and receives no cookie", async () => {
    expect((await fetch(base + "/auth/qr-code")).status).toBe(401); expect(initQrAuth).not.toHaveBeenCalled();
    expect((await fetch(base + "/auth/qr-code", { headers: { Cookie: "mctl_session=alice" } })).status).toBe(200);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    server = createHttpServer(0, { publicBaseUrl: "http://localhost", authRequired: true, oauthStorage: storage, storage: history, enableSampler: false });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    expect((await fetch(base + "/auth/qr-status?sessionId=test-qr", { headers: { Cookie: "mctl_session=bob" } })).status).toBe(401);
    expect(checkQrAuthStatus).not.toHaveBeenCalled();
    const response = await fetch(base + "/auth/qr-status?sessionId=test-qr", { headers: { Cookie: "mctl_session=alice" } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: "ok" });
    expect(storage.getUserCredentials("alice")?.quasarCookie).toBe("Session_id=alice-qr");
    expect(storage.getUserCredentials("bob")?.quasarCookie).toBeUndefined();
    expect((await fetch(base + "/auth/qr-status?sessionId=test-qr", { headers: { Cookie: "mctl_session=alice" } })).status).toBe(401);
  });
  it("rejects a QR login completed with a different Yandex account", async () => {
    expect((await fetch(base + "/auth/qr-code", { headers: { Cookie: "mctl_session=bob" } })).status).toBe(200);
    const response = await fetch(base + "/auth/qr-status?sessionId=test-qr", { headers: { Cookie: "mctl_session=bob" } });
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain("alice-qr");
    expect(storage.getUserCredentials("bob")?.quasarCookie).toBeUndefined();
  });
  it("saves a pasted cookie only for the account it signs in as", async () => {
    const save = (session: string, cookie: string) => fetch(base + "/auth/save-cookie", {
      method: "POST", headers: { Cookie: `mctl_session=${session}`, Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ cookie }),
    });
    for (const cookie of ["Session_id=bob-web", "Session_id=anonymous"]) {
      expect((await save("alice", cookie)).status, cookie).toBe(403);
    }
    expect(storage.getUserCredentials("alice")?.quasarCookie).toBeUndefined();
    expect((await save("alice", "Session_id=alice-web")).status).toBe(200);
    expect(storage.getUserCredentials("alice")?.quasarCookie).toBe("Session_id=alice-web");
  });
});
