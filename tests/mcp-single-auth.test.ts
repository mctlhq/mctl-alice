import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { createHttpServer } from "../src/server/http-server.js";

const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "alice_list_devices", arguments: {} } });

describe("a tool call authenticates once, and re-checks a stale admission", () => {
  let storage: OAuthStorage;
  let server: http.Server;
  let port = 0;

  beforeEach(async () => {
    storage = new OAuthStorage(":memory:");
    storage.saveUser({ id: "usr_a", yandexUid: "1", login: "a", displayName: "A", createdAt: Date.now(), updatedAt: Date.now() });
    storage.saveUserCredentials("usr_a", { yandexAccessToken: "y_a" });
    storage.saveToken({ accessToken: "tok_a", refreshToken: "rt_a", clientId: "c", userId: "usr_a", yandexAccessToken: "y_a",
      scope: "iot:view iot:control", createdAt: Date.now(), expiresAt: Date.now() + 3_600_000 });
    server = createHttpServer(0, { publicBaseUrl: "http://localhost", authRequired: true, oauthStorage: storage, enableSampler: false });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as import("node:net").AddressInfo).port;
    // Only Yandex is reached through fetch; the test talks to its own server over http.request.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "ok", rooms: [], devices: [], scenarios: [] })));
  });
  afterEach(async () => { vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });

  /** POST /mcp over a raw socket so the body can arrive late. */
  const post = (body: string, bodyDelayMs = 0) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer tok_a", "content-length": Buffer.byteLength(body) } },
      (res) => { let text = ""; res.on("data", (d) => (text += d)); res.on("end", () => resolve({ status: res.statusCode ?? 0, text })); });
    req.on("error", reject);
    req.flushHeaders();
    setTimeout(() => req.end(body), bodyDelayMs);
  });

  it("reads the token once for a prompt single call", async () => {
    const getToken = vi.spyOn(storage, "getToken");
    const res = await post(JSON.stringify(call(1)));
    expect(res.status).toBe(200);
    expect(res.text).toContain('"result"');
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("re-checks the token when the body arrives after the admission has gone stale", async () => {
    const pending = post(JSON.stringify(call(2)), 1300);
    await new Promise((r) => setTimeout(r, 300));
    storage.revokeToken("tok_a"); // revoked while the client is still uploading
    const res = await pending;
    expect(res.text).toMatch(/Invalid access token|isError/);
    expect(res.text).not.toContain("Умный дом");
  });
});
