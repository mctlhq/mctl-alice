import { EventEmitter } from "node:events";
import dns from "node:dns";
import https from "node:https";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { METADATA_DEADLINE_MS, OAuthController, fetchMetadataDocument, publicOnlyLookup } from "../src/auth/oauth-controller.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";

const metadataUrl = "https://client.example/oauth/client.json";

// A stand-in for https.get: records the call, hands back a controllable
// request, and lets the test drive the response.
function fakeHttpsGet() {
  const calls: Array<{ url: string; options: any }> = [];
  const requests: Array<EventEmitter & { timeoutMs?: number; onTimeout?: () => void; destroyed: boolean; destroy(err?: Error): void; setTimeout(ms: number, cb: () => void): void }> = [];
  let respond: ((res: PassThrough & { statusCode?: number; headers: Record<string, string> }) => void) | undefined;
  vi.spyOn(https, "get").mockImplementation(((url: string, options: any, callback: (res: any) => void) => {
    calls.push({ url, options });
    const req = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy(err?: Error) { this.destroyed = true; if (err) this.emit("error", err); },
      setTimeout(ms: number, cb: () => void) { this.timeoutMs = ms; this.onTimeout = cb; },
    }) as any;
    requests.push(req);
    respond = callback;
    return req;
  }) as any);
  const response = (status: number, headers: Record<string, string>) => {
    const res = Object.assign(new PassThrough(), { statusCode: status, headers });
    respond!(res);
    return res;
  };
  return { calls, requests, response };
}

describe("client metadata document fetch guards", () => {
  afterEach(() => vi.restoreAllMocks());

  it("connects only through the public-only resolver and never follows a redirect", async () => {
    const { calls, response } = fakeHttpsGet();
    const pending = fetchMetadataDocument(metadataUrl);
    const res = response(302, { location: "https://169.254.169.254/latest/meta-data/", "content-type": "text/html" });
    res.end();
    expect(await pending).toMatchObject({ status: 302 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(metadataUrl);
    expect(calls[0].options.lookup).toBe(publicOnlyLookup);
  });

  it("refuses a declared oversized document without reading the body", async () => {
    const { response } = fakeHttpsGet();
    const pending = fetchMetadataDocument(metadataUrl);
    const res = response(200, { "content-type": "application/json", "content-length": String(16 * 1024 + 1) });
    res.end('{"client_id":"x"}');
    await expect(pending).rejects.toThrow("too large");
    expect(res.destroyed).toBe(true);
  });

  it("aborts an undeclared body as soon as it exceeds 16 KiB", async () => {
    const { response } = fakeHttpsGet();
    const pending = fetchMetadataDocument(metadataUrl);
    const res = response(200, { "content-type": "application/json" });
    res.write(Buffer.alloc(16 * 1024, 32));
    res.end(Buffer.from("{}"));
    await expect(pending).rejects.toThrow("too large");
    expect(res.destroyed).toBe(true);
  });

  it("gives up on a silent server after 4 seconds", async () => {
    const { requests } = fakeHttpsGet();
    const pending = fetchMetadataDocument(metadataUrl);
    expect(requests[0].timeoutMs).toBe(4000);
    requests[0].onTimeout!();
    await expect(pending).rejects.toThrow("timed out");
    expect(requests[0].destroyed).toBe(true);
  });
});

describe("client metadata document overall deadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("aborts a server that keeps trickling bytes once the deadline passes", async () => {
    const { calls, requests, response } = fakeHttpsGet();
    const pending = fetchMetadataDocument(metadataUrl);
    const outcome = pending.then(() => "resolved", (err: Error) => err.message);
    const res = response(200, { "content-type": "application/json" });
    // Each byte arrives well inside the 4 s idle timeout.
    for (let elapsed = 0; elapsed < METADATA_DEADLINE_MS - 1000; elapsed += 1000) {
      res.write("{");
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(calls[0].options.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toContain("deadline");
    expect(calls[0].options.signal.aborted).toBe(true);
    expect(requests[0].destroyed).toBe(true);
    expect(res.destroyed).toBe(true);
  });

  it("clears the deadline once the document has arrived", async () => {
    const { response } = fakeHttpsGet();
    const pending = fetchMetadataDocument(metadataUrl);
    response(200, { "content-type": "application/json" }).end("{}");
    expect(await pending).toMatchObject({ status: 200, body: "{}" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("public-only resolver", () => {
  const resolve = (answer: Array<{ address: string; family: number }>, all = false) => {
    vi.spyOn(dns.promises, "lookup").mockResolvedValueOnce(answer as never);
    return new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((done) =>
      publicOnlyLookup("client.example", { all }, (err, address) => done({ err, address })));
  };
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["loopback", "127.0.0.1", 4],
    ["10/8", "10.20.30.40", 4],
    ["cloud metadata", "169.254.169.254", 4],
    ["IPv6 loopback", "::1", 6],
    ["IPv4-mapped IPv6", "::ffff:10.0.0.1", 6],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254", 6],
    ["unique local IPv6", "fd12:3456::1", 6],
  ])("refuses a name that resolves to %s", async (_label, address, family) => {
    const { err } = await resolve([{ address, family }]);
    expect(err?.message).toContain("non-public");
  });

  it("refuses an empty answer", async () => {
    expect((await resolve([], true)).err?.message).toContain("non-public");
  });

  it("hands back every vetted address when asked for all", async () => {
    const answer = [{ address: "93.184.215.14", family: 4 }, { address: "2606:4700::1111", family: 6 }];
    expect(await resolve(answer, true)).toEqual({ err: null, address: answer });
  });
});

describe("metadata URL screening before any fetch", () => {
  let storage: OAuthStorage;
  let fetcher: ReturnType<typeof vi.fn>;
  let controller: OAuthController;
  beforeEach(() => {
    storage = new OAuthStorage(":memory:");
    fetcher = vi.fn(async () => { throw new Error("unexpected metadata fetch"); });
    controller = new OAuthController({ baseUrl: "https://alice.mctl.ai", yandexClientId: "app", storage, authRequired: true, fetchMetadataDocument: fetcher });
  });
  afterEach(() => storage.close());

  it.each([
    "https://10.0.0.1/c.json",
    "https://192.168.1.10/c.json",
    "https://172.16.5.4/c.json",
    "https://[::ffff:127.0.0.1]/c.json",
    "https://[::ffff:169.254.169.254]/c.json",
    "https://[fe80::1]/c.json",
    // Alternative IPv4 spellings that URL parsing normalizes to loopback.
    "https://2130706433/c.json",
    "https://0x7f000001/c.json",
    "https://127.1/c.json",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://printer.local/c.json",
    "https://app.localhost/c.json",
    "https://user:pass@client.example/c.json",
    "https://client.example:444/c.json",
  ])("refuses %s", async (url) => {
    expect(await controller.resolveClientMetadata(url)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await storage.getClient(url)).toBeNull();
  });

  it("does fetch a public https URL on the default port", async () => {
    fetcher.mockResolvedValueOnce({ status: 200, contentType: "application/json", body: JSON.stringify({ client_id: "https://client.example:443/c.json", redirect_uris: ["https://client.example/cb"] }) });
    await controller.resolveClientMetadata("https://client.example:443/c.json");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
