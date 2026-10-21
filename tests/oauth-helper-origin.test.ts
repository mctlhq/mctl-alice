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
    const started = startAuthServer({ port, clientId: "client", clientSecret: "secret", state: "flow-state" });
    try {
      await Promise.race([
        new Promise<void>(resolve => created[0].listening ? resolve() : created[0].once("listening", () => resolve())),
        started.then(() => { throw new Error("helper finished before listening"); }),
      ]);
      // Nothing beyond this machine can reach it.
      expect((created[0].address() as import("node:net").AddressInfo).address).toBe("127.0.0.1");
      const own = `http://localhost:${port}`;
      const send = (origin?: string, state: string | null = "flow-state") => fetch(`http://127.0.0.1:${port}/save-token`, {
        method: "POST", headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": "text/plain" }, body: JSON.stringify({ token: "", state }),
      });
      expect((await send("https://evil.example")).status).toBe(403);
      expect((await send()).status).toBe(403);
      // Its own page loaded with someone else's fragment carries no matching
      // state, however valid the Origin.
      expect((await send(own, null)).status).toBe(403);
      expect((await send(own, "other-state")).status).toBe(403);
      // A code this flow did not ask for is refused the same way.
      expect((await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=other-state`)).status).toBe(403);
      // The helper's pages cannot be framed.
      expect((await fetch(`http://127.0.0.1:${port}/callback`)).headers.get("x-frame-options")).toBe("DENY");
      // Its own page with the flow's state reaches the token validation.
      expect((await send(own)).status).toBe(400);
    } finally {
      created[0].closeAllConnections();
      await new Promise<void>(resolve => created[0].close(() => resolve()));
    }
  });
});
