import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildOAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
} from "../src/auth/token-storage.js";

describe("OAuth and Token Storage Helper", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should build OAuth URL for implicit flow by default", () => {
    const url = buildOAuthUrl("client-123", "http://localhost:8085/callback", "token");
    expect(url).toContain("https://oauth.yandex.ru/authorize");
    expect(url).toContain("response_type=token");
    expect(url).toContain("client_id=client-123");
    expect(url).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Fcallback");
  });

  it("should build OAuth URL for code flow", () => {
    const url = buildOAuthUrl("client-123", "http://localhost:8085/callback", "code");
    expect(url).toContain("response_type=code");
  });

  it("should exchange code for access and refresh tokens", async () => {
    const mockResponse = {
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      token_type: "bearer",
      expires_in: 31536000,
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await exchangeCodeForToken({
      code: "auth-code-xyz",
      clientId: "client-123",
      clientSecret: "secret-456",
      redirectUri: "http://localhost:8085/callback",
    });

    expect(result.access_token).toBe("new-access-token");
    expect(result.refresh_token).toBe("new-refresh-token");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://oauth.yandex.ru/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
        }),
      })
    );
  });

  it("should refresh access token using refresh_token", async () => {
    const mockResponse = {
      access_token: "refreshed-access-token",
      refresh_token: "refreshed-refresh-token",
      token_type: "bearer",
      expires_in: 31536000,
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await refreshAccessToken({
      refreshToken: "old-refresh-token",
      clientId: "client-123",
      clientSecret: "secret-456",
    });

    expect(result.access_token).toBe("refreshed-access-token");
    expect(result.refresh_token).toBe("refreshed-refresh-token");
  });

  it("should throw error if token refresh fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error_description: "Invalid refresh token" }),
    });

    await expect(
      refreshAccessToken({
        refreshToken: "bad-token",
        clientId: "client-123",
        clientSecret: "secret-456",
      })
    ).rejects.toThrow("Invalid refresh token");
  });
});
