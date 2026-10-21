import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import { startAuthServer } from "../src/auth/oauth-helper.js";

describe("CLI auth helper", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("accepts a token only from its own page", async () => {
    // A port the OS just handed out, so the helper (which needs an explicit
    // port for its redirect URI) does not collide with another worker.
    const probe = http.createServer();
    await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as import("node:net").AddressInfo).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const created: http.Server[] = [];
    const create = http.createServer;
    vi.spyOn(http, "createServer").mockImplementation(((...args: Parameters<typeof create>) => {
      const server = create(...args); created.push(server); return server;
    }) as typeof create);
    const started = startAuthServer({ port, clientId: "client" });
    try {
      await Promise.race([
        new Promise<void>(resolve => created[0].listening ? resolve() : created[0].once("listening", () => resolve())),
        started.then(() => { throw new Error("helper finished before listening"); }),
      ]);
      // Nothing beyond this machine can reach it.
      expect((created[0].address() as import("node:net").AddressInfo).address).toBe("127.0.0.1");
      const send = (origin?: string) => fetch(`http://127.0.0.1:${port}/save-token`, {
        method: "POST", headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": "text/plain" }, body: '{"token":""}',
      });
      expect((await send("https://evil.example")).status).toBe(403);
      expect((await send()).status).toBe(403);
      // Its own page passes the origin check and reaches the token validation.
      expect((await send(`http://localhost:${port}`)).status).toBe(400);
    } finally {
      created[0].closeAllConnections();
      await new Promise<void>(resolve => created[0].close(() => resolve()));
    }
  });
});
