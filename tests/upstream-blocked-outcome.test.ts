import { describe, it, expect, afterEach, vi } from "vitest";
import { upstreamFetch } from "../src/client/upstream.js";
import { outcomeForStatus, renderMetrics } from "../src/metrics.js";

afterEach(() => vi.unstubAllGlobals());

const count = (text: string, upstream: string, outcome: string) => {
  const m = text.match(new RegExp(`mctl_alice_upstream_requests_total\\{upstream="${upstream}",outcome="${outcome}"\\} (\\d+)`));
  return m ? Number(m[1]) : 0;
};

describe("blocked upstream outcome", () => {
  it("classifies 429 and challenge redirects as blocked", () => {
    expect(outcomeForStatus(429)).toBe("blocked");
    expect(outcomeForStatus(302, "https://passport.yandex.ru/showcaptcha?retpath=x")).toBe("blocked");
    expect(outcomeForStatus(303, "https://example.test/CAPTCHA")).toBe("blocked");
  });

  it("keeps ordinary refusals and redirects in their own classes", () => {
    expect(outcomeForStatus(403)).toBe("4xx"); // Quasar CSRF expiry, retried by the client
    expect(outcomeForStatus(401)).toBe("4xx");
    expect(outcomeForStatus(302, "https://passport.yandex.ru/auth")).toBe("3xx");
    expect(outcomeForStatus(302, null)).toBe("3xx");
    expect(outcomeForStatus(200)).toBe("ok");
    expect(outcomeForStatus(503)).toBe("5xx");
  });

  it("records a 429 from upstreamFetch under the blocked label", async () => {
    const before = count(renderMetrics(), "iot", "blocked");
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status: 429 })));
    await upstreamFetch("https://x.test/", {}, { upstream: "Yandex IoT" });
    expect(count(renderMetrics(), "iot", "blocked")).toBe(before + 1);
  });

  it("records a captcha redirect from upstreamFetch under the blocked label", async () => {
    const before = count(renderMetrics(), "passport", "blocked");
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 302, headers: { location: "https://passport.yandex.ru/showcaptcha" } })));
    await upstreamFetch("https://x.test/", { redirect: "manual" }, { upstream: "Yandex Passport" });
    expect(count(renderMetrics(), "passport", "blocked")).toBe(before + 1);
  });
});
