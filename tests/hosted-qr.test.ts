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
describe("hosted QR owner binding", () => {
  let storage: OAuthStorage, history: TelemetryStorage, server: http.Server, base: string;
  beforeEach(async () => {
    vi.clearAllMocks(); storage = new OAuthStorage(":memory:"); history = new TelemetryStorage(":memory:");
    for (const id of ["alice", "bob"]) {
      storage.saveUser({ id, yandexUid: id, createdAt: Date.now(), updatedAt: Date.now() });
      storage.saveUserCredentials(id, { yandexAccessToken: id });
      storage.saveWebSession(id, id, Date.now() + 60000);
    }
    server = createHttpServer(0, { authRequired: true, oauthStorage: storage, storage: history, enableSampler: false });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); storage.close(); history.close(); });
  it("only the initiating browser owner can finish QR and receives no cookie", async () => {
    expect((await fetch(base + "/auth/qr-code")).status).toBe(401); expect(initQrAuth).not.toHaveBeenCalled();
    expect((await fetch(base + "/auth/qr-code", { headers: { Cookie: "mctl_session=alice" } })).status).toBe(200);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    server = createHttpServer(0, { authRequired: true, oauthStorage: storage, storage: history, enableSampler: false });
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
});
