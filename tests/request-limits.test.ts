import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";

// Assigned once the server listens on an ephemeral port, so parallel runs cannot collide.
let PORT = 0;
let baseUrl = "";
const KiB = 1024;

type Answer = { status: number; connection?: string; body: string; reset?: boolean };

/**
 * POSTs `chunks` with no Content-Length (chunked), resolving with the status
 * once answered. The server answers 413 and closes the connection while the
 * upload may still be in flight; the unread bytes can turn that close into a
 * reset that reaches the client before the 413 does. That is reported as
 * `reset` rather than failing the test.
 */
function chunkedPost(pathname: string, headers: Record<string, string>, chunks: Buffer[]): Promise<Answer> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request({ host: "127.0.0.1", port: PORT, path: pathname, method: "POST", headers: { "Transfer-Encoding": "chunked", ...headers } }, (res) => {
      answered = true;
      let body = "";
      const done = () => resolve({ status: res.statusCode || 0, connection: res.headers.connection as string | undefined, body });
      res.on("data", (c) => (body += c));
      res.on("end", done);
      res.on("error", done);
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (answered) return;
      if (err.code === "ECONNRESET" || err.code === "EPIPE") resolve({ status: 0, body: "", reset: true });
      else reject(err);
    });
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

/** Declares `length` bytes but sends none, so only the declared size can trigger the answer. */
function declaredPost(pathname: string, headers: Record<string, string>, length: number): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: pathname, method: "POST", headers: { ...headers, "Content-Length": String(length) } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { req.destroy(); resolve({ status: res.statusCode || 0, connection: res.headers.connection as string | undefined, body }); });
    });
    req.on("error", reject);
    req.flushHeaders();
  });
}

/** A streamed oversize body is refused: 413 with Connection: close, or a reset mid-upload. */
function expectRefused(res: Answer) {
  if (res.reset) return;
  expect(res.status).toBe(413);
  expect(res.connection).toBe("close");
}

describe("request body limits", () => {
  let server: http.Server;
  let storage: OAuthStorage;

  beforeAll(async () => {
    storage = new OAuthStorage(":memory:");
    server = createHttpServer(0, { publicBaseUrl: "http://127.0.0.1", authRequired: false, enableSampler: false, oauthStorage: storage, rateLimits: { register: 1000, token: 1000, authorize: 1000, mcp: 1000 } });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    PORT = (server.address() as import("node:net").AddressInfo).port;
    baseUrl = `http://127.0.0.1:${PORT}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
  });

  const formRoutes = ["/oauth/register", "/oauth/token", "/oauth/authorize", "/account/revoke-grant"];

  for (const route of formRoutes) {
    it(`rejects a declared oversize body on ${route} with 413`, async () => {
      const res = await declaredPost(route, { "Content-Type": "application/json", Origin: baseUrl }, 65 * KiB);
      expect(res.status).toBe(413);
    });

    it(`rejects a streamed oversize body on ${route} with 413 and closes the connection`, async () => {
      const chunk = Buffer.alloc(16 * KiB, "a");
      expectRefused(await chunkedPost(route, { "Content-Type": "application/json", Origin: baseUrl }, [chunk, chunk, chunk, chunk, chunk]));
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
    const big = await declaredPost("/mcp", { "Content-Type": "application/json" }, 1024 * KiB + 1);
    expect(big.status).toBe(413);
    expectRefused(await chunkedPost("/mcp", { "Content-Type": "application/json" }, [Buffer.alloc(1024 * KiB, "a"), Buffer.from("a")]));
    const ok = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(ok.status).toBe(200);
  });

  it("rejects a JSON-RPC batch longer than the element bound", async () => {
    const batch = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
    const headers = { "Content-Type": "application/json" };
    const res = await fetch(`${baseUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(batch) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
    const ok = await fetch(`${baseUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(batch.slice(0, 20)) });
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

      expectRefused(await chunkedPost(`/messages?sessionId=${sessionId}`, { "Content-Type": "application/json" }, [Buffer.alloc(1024 * KiB, "a"), Buffer.from("a")]));
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
