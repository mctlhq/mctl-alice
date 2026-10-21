import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import { startAuthServer } from "../src/auth/oauth-helper.js";

describe("CLI auth helper", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("accepts a token only from its own page", async () => {
    const created: http.Server[] = [];
    const create = http.createServer;
    vi.spyOn(http, "createServer").mockImplementation(((...args: Parameters<typeof create>) => {
      const server = create(...args); created.push(server); return server;
    }) as typeof create);
    const port = 20000 + Math.floor(Math.random() * 20000);
    void startAuthServer({ port, clientId: "client" }).catch(() => {});
    try {
      await new Promise<void>(resolve => created[0].listening ? resolve() : created[0].once("listening", () => resolve()));
      const send = (origin: string) => fetch(`http://127.0.0.1:${port}/save-token`, {
        method: "POST", headers: { Origin: origin, "Content-Type": "text/plain" }, body: '{"token":""}',
      });
      expect((await send("https://evil.example")).status).toBe(403);
      // Its own page passes the origin check and reaches the token validation.
      expect((await send(`http://localhost:${port}`)).status).toBe(400);
    } finally {
      created[0].closeAllConnections();
      await new Promise<void>(resolve => created[0].close(() => resolve()));
    }
  });
});
