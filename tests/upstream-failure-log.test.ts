import { describe, it, expect, afterEach, vi } from "vitest";
import { upstreamFetch, userRef } from "../src/client/upstream.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const failureLines = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[upstream-failure]"));

describe("upstream failure log line", () => {
  it("names the network cause and the user tag, and nothing secret", async () => {
    const err = new TypeError("fetch failed https://api.iot.yandex.net/v1.0/user/info?token=SECRET", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    vi.stubGlobal("fetch", () => Promise.reject(err));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      upstreamFetch("https://api.iot.yandex.net/v1.0/user/info?token=SECRET", { headers: { Authorization: "Bearer SECRET" } }, { upstream: "Yandex IoT", userRef: userRef("usr_1") }),
    ).rejects.toThrow();

    const lines = failureLines(spy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('upstream="Yandex IoT"');
    expect(lines[0]).toContain("outcome=error");
    expect(lines[0]).toContain("error=TypeError");
    expect(lines[0]).toContain("cause=ECONNRESET");
    expect(lines[0]).toContain(`user=${userRef("usr_1")}`);
    expect(lines[0]).not.toMatch(/SECRET|usr_1|yandex\.net|fetch failed/);
  });

  it("logs a deadline as a timeout", async () => {
    vi.stubGlobal("fetch", (_i: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason), { once: true })));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(upstreamFetch("https://x.test/", {}, { upstream: "Yandex IoT", timeoutMs: 20 })).rejects.toThrow();

    const lines = failureLines(spy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("outcome=timeout");
    expect(lines[0]).toContain("user=-");
  });

  it("stays silent on success", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status: 200 })));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await upstreamFetch("https://x.test/", {}, { upstream: "Yandex IoT" });
    expect(failureLines(spy)).toHaveLength(0);
  });

  it("userRef is stable, short and does not contain the id", () => {
    expect(userRef("usr_1")).toBe(userRef("usr_1"));
    expect(userRef("usr_1")).toMatch(/^[0-9a-f]{8}$/);
    expect(userRef("usr_1")).not.toBe(userRef("usr_2"));
  });
});
