import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const exec = vi.hoisted(() => ({ execFileSync: vi.fn(() => "stored\n"), execSync: vi.fn() }));
vi.mock("node:child_process", () => exec);

import { saveTokenToKeychain, getTokenFromKeychain } from "../src/auth/token-storage.js";

describe("keychain access never goes through a shell", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => { Object.defineProperty(process, "platform", { value: "darwin" }); vi.clearAllMocks(); });
  afterEach(() => { Object.defineProperty(process, "platform", platform); });

  it("passes the token as one argument, shell metacharacters included", () => {
    const token = `y0_"; touch /tmp/pwned; echo "$(id)`;
    expect(saveTokenToKeychain(token, "svc", "acct")).toBe(true);
    expect(exec.execSync).not.toHaveBeenCalled();
    expect(exec.execFileSync).toHaveBeenCalledWith(
      "security", ["add-generic-password", "-a", "acct", "-s", "svc", "-w", token, "-U"], expect.any(Object));
  });

  it("reads with an argument array too", () => {
    expect(getTokenFromKeychain(`svc"; id; "`)).toBe("stored");
    expect(exec.execSync).not.toHaveBeenCalled();
    expect(exec.execFileSync).toHaveBeenCalledWith(
      "security", ["find-generic-password", "-s", `svc"; id; "`, "-w"], expect.any(Object));
  });
});
