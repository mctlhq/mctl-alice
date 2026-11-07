import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { readFileSync } from "node:fs";
import { CONNECT_ATTEMPT_TIMEOUT_MS, applyNetDefaults } from "../src/client/net-defaults.js";

const original = net.getDefaultAutoSelectFamilyAttemptTimeout();
afterEach(() => net.setDefaultAutoSelectFamilyAttemptTimeout(original));

describe("net defaults", () => {
  it("gives each connect attempt time for SYN retransmits", () => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(250); // the Node 24 default that failed calls in 0.26 s
    applyNetDefaults();
    // Linux retransmits a lost SYN after 1 s and again after 3 s.
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_TIMEOUT_MS);
    expect(CONNECT_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(3_000);
    // and leaves room under undici's 10 s connect timeout.
    expect(CONNECT_ATTEMPT_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it("is applied at startup", () => {
    // index.ts runs the server on import, so check the wiring in its source.
    const main = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8").match(/async function main\(\) \{([\s\S]*?)\n\}/);
    expect(main?.[1]).toMatch(/^\s*applyNetDefaults\(\);/);
  });
});
