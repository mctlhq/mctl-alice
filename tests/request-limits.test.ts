import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";

const PORT = 8301;
const baseUrl = `http://127.0.0.1:${PORT}`;
const KiB = 1024;

/** POSTs `chunks` with no Content-Length (chunked), resolving with the status once answered. */
function chunkedPost(pathname: string, headers: Record<string, string>, chunks: Buffer[]): Promise<{ status: number; connection?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: pathname, method: "POST", headers: { "Transfer-Encoding": "chunked", ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, connection: res.headers.connection as string | undefined, body }));
    });
    req.on("error", (err) => {
      // The server may close the socket once it has answered 413.
      reject(err);
    });
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

describe("request body limits", () => {
  let server: http.Server;
  let storage: OAuthStorage;

  beforeAll(async () => {
    storage = new OAuthStorage(":memory:");
    server = createHttpServer(PORT, { publicBaseUrl: baseUrl, authRequired: false, enableSampler: false, oauthStorage: storage, rateLimits: { register: 1000, token: 1000, authorize: 1000, mcp: 1000 } });
    await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
  });

  const formRoutes = ["/oauth/register", "/oauth/token", "/oauth/authorize", "/account/revoke-grant"];

  for (const route of formRoutes) {
    it(`rejects a declared oversize body on ${route} with 413`, async () => {
      const res = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ pad: "x".repeat(65 * KiB) }),
      });
      expect(res.status).toBe(413);
    });

    it(`rejects a streamed oversize body on ${route} with 413 and closes the connection`, async () => {
      const chunk = Buffer.alloc(16 * KiB, "a");
      const res = await chunkedPost(route, { "Content-Type": "application/json", Origin: baseUrl }, [chunk, chunk, chunk, chunk, chunk]);
      expect(res.status).toBe(413);
      expect(res.connection).toBe("close");
    });

    it(`still parses an in-limit JSON body on ${route}`, async () => {
      const res = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ pad: "x".repeat(KiB) }),
        redirect: "manual",
      });
      expect(res.status).not.toBe(413);
    });
  }

  it("parses in-limit form bodies as before", async () => {
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "bogus" }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeDefined();
  });

  it("rejects an MCP body above 1 MiB with 413 and accepts one below", async () => {
    const big = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(1024 * KiB + 1) });
    expect(big.status).toBe(413);
    const streamed = await chunkedPost("/mcp", { "Content-Type": "application/json" }, [Buffer.alloc(1024 * KiB, "a"), Buffer.from("a")]);
    expect(streamed.status).toBe(413);
    const ok = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(ok.status).toBe(200);
  });

  it("reads /messages through the shared helper and never reaches the transport on overflow", async () => {
    const handle = vi.spyOn(SSEServerTransport.prototype, "handlePostMessage");
    let sse: http.ClientRequest | undefined;
    try {
      const sessionId = await new Promise<string>((resolve, reject) => {
        const req = sse = http.get(`${baseUrl}/sse`, { headers: { Accept: "text/event-stream" } }, (res) => {
          res.setEncoding("utf8");
          res.on("data", (data: string) => {
            const m = data.match(/sessionId=([^\s&]+)/);
            if (m) resolve(m[1]);
          });
        });
        req.on("error", reject);
        setTimeout(() => reject(new Error("no SSE session")), 3000);
      });

      const over = await chunkedPost(`/messages?sessionId=${sessionId}`, { "Content-Type": "application/json" }, [Buffer.alloc(1024 * KiB, "a"), Buffer.from("a")]);
      expect(over.status).toBe(413);
      expect(handle).not.toHaveBeenCalled();

      const ok = await fetch(`${baseUrl}/messages?sessionId=${sessionId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
      expect(ok.status).toBe(202);
      expect(handle).toHaveBeenCalledTimes(1);
      expect(typeof handle.mock.calls[0][2]).toBe("object");
    } finally {
      handle.mockRestore();
      sse?.destroy();
    }
  });
});

describe("single body reader", () => {
  it("leaves no raw req.on(\"data\") reader under src/", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (full.endsWith(".ts") && !full.endsWith(path.join("server", "request-body.ts")) && /\breq\.on\(\s*["']data["']/.test(fs.readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    walk(path.join(__dirname, "..", "src"));
    expect(offenders).toEqual([]);
  });
});
