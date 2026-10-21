import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorage } from "../src/storage/index.js";

describe("createStorage", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(["MINIO_ENDPOINT", "MINIO_ACCESS_KEY"])("refuses to start on an empty SQLite store when only %s is configured", name => {
    vi.stubEnv("DATABASE_URL", ""); vi.stubEnv("PGHOST", ""); vi.stubEnv(name, "x");
    expect(() => createStorage(":memory:")).toThrow("DATABASE_URL");
  });
  it("uses local SQLite when no remote storage is configured", () => {
    vi.stubEnv("DATABASE_URL", ""); vi.stubEnv("PGHOST", ""); vi.stubEnv("MINIO_ENDPOINT", ""); vi.stubEnv("MINIO_ACCESS_KEY", "");
    const storage = createStorage(":memory:");
    expect(storage.constructor.name).toBe("OAuthStorage");
    storage.close?.();
  });
});
