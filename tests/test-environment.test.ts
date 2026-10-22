import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTelemetryStorage } from "../src/storage/index.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";

describe("test environment", () => {
  it("gives every default telemetry store its own in-memory database", async () => {
    // With a file database (./data/telemetry.db) the second store would see the
    // first one's sample.
    const deviceId = `probe-${randomUUID()}`;
    const first = createTelemetryStorage();
    const second = createTelemetryStorage();
    try {
      await first.saveSamples([{ deviceId, deviceName: "probe", metric: "power", value: 1, timestamp: Date.now() }]);
      expect((await first.queryHistory({ deviceId, from: 0, to: Date.now() })).count).toBe(1);
      expect((await second.queryHistory({ deviceId, from: 0, to: Date.now() })).count).toBe(0);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("gives every default OAuth store its own in-memory database", () => {
    // With the default file (./data/oauth.db) the second store would see the first one's user.
    const id = `probe-${randomUUID()}`;
    const first = new OAuthStorage();
    const second = new OAuthStorage();
    try {
      first.saveUser({ id, yandexUid: "1", displayName: "probe", createdAt: Date.now(), updatedAt: Date.now() });
      expect(first.getUser(id)).not.toBeNull();
      expect(second.getUser(id)).toBeNull();
    } finally {
      first.close();
      second.close();
    }
  });

  it("refuses fetches that leave loopback", async () => {
    await expect(fetch("https://yandex.ru/quasar")).rejects.toThrow("tests may not reach yandex.ru");
  });
});
