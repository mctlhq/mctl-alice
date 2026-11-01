import { describe, it, expect, afterAll, beforeAll } from "vitest";
import http from "node:http";
import { createHttpServer } from "../src/server/http-server.js";
import { renderMetrics } from "../src/metrics.js";

const gauge = () => Number(/^mctl_alice_sse_streams_open (\d+)$/m.exec(renderMetrics())?.[1] ?? NaN);
const until = async (cond: () => boolean) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); };

describe("mctl_alice_sse_streams_open", () => {
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    server = createHttpServer(0, { publicBaseUrl: "http://localhost", enableSampler: false });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  it("tracks streams as they open and close, and renders as a gauge", async () => {
    expect(gauge()).toBe(0);
    expect(renderMetrics()).toContain("# TYPE mctl_alice_sse_streams_open gauge");

    const ctrls = [new AbortController(), new AbortController(), new AbortController()];
    for (const c of ctrls) {
      const res = await fetch(`${base}/sse`, { signal: c.signal, headers: { Accept: "text/event-stream" } });
      expect(res.status).toBe(200);
      void res.body!.getReader().read().catch(() => {});
    }
    await until(() => gauge() === 3);
    expect(gauge()).toBe(3);

    ctrls[0].abort();
    await until(() => gauge() === 2);
    expect(gauge()).toBe(2);

    ctrls[1].abort(); ctrls[2].abort();
    await until(() => gauge() === 0);
    expect(gauge()).toBe(0);
  });
});
