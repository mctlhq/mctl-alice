import { describe, it, expect, vi, afterEach } from "vitest";
import { CredentialDecryptionError, StorageUnavailableError, guardedStorage } from "../src/storage/storage-interface.js";

afterEach(() => vi.restoreAllMocks());

describe("guardedStorage failure trace", () => {
  it("logs method, error class and code, never the message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = Object.assign(new Error("SELECT secret FROM users WHERE id = 'usr_1' timed out"), { code: "ETIMEDOUT" });
    const st = guardedStorage({ getUser: async () => { throw boom; } } as any);
    await expect(st.getUser("usr_1")).rejects.toBeInstanceOf(StorageUnavailableError);
    const line = String(spy.mock.calls[0][0]);
    expect(line).toBe("[storage-failure] op=getUser error=Error code=ETIMEDOUT");
    expect(line).not.toMatch(/secret|usr_1|SELECT/);
  });

  it("does not log a decrypt failure and still rethrows it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const st = guardedStorage({ getUser: async () => { throw new CredentialDecryptionError(); } } as any);
    await expect(st.getUser("u")).rejects.toBeInstanceOf(CredentialDecryptionError);
    expect(spy).not.toHaveBeenCalled();
  });
});
