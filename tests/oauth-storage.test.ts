import { describe, it, expect, beforeEach } from "vitest";
import { OAuthStorage } from "../src/storage/oauth-storage.js";

describe("OAuthStorage", () => {
  let storage: OAuthStorage;

  beforeEach(() => {
    // In-memory sqlite database for fast, isolated tests
    storage = new OAuthStorage(":memory:");
  });

  describe("Dynamic Client Registration & Management", () => {
    it("should save and retrieve client registration", () => {
      storage.saveClient({
        clientId: "client_chatgpt_123",
        clientSecret: "secret_456",
        clientName: "ChatGPT Test Client",
        redirectUris: ["https://chatgpt.com/aip/oauth/callback"],
        createdAt: Date.now(),
      });

      const client = storage.getClient("client_chatgpt_123");
      expect(client).toBeDefined();
      expect(client?.clientId).toBe("client_chatgpt_123");
      expect(client?.clientSecret).toBe("secret_456");
      expect(client?.clientName).toBe("ChatGPT Test Client");
      expect(client?.redirectUris).toEqual(["https://chatgpt.com/aip/oauth/callback"]);
    });

    it("should return null for non-existent client", () => {
      const client = storage.getClient("non_existent");
      expect(client).toBeNull();
    });
  });

  describe("Pending Authorization Flow", () => {
    it("should save, retrieve, and delete pending auth requests", () => {
      const state = "state_random_uuid";
      storage.savePendingAuth({
        state,
        clientId: "client_chatgpt_123",
        redirectUri: "https://chatgpt.com/aip/oauth/callback",
        clientState: "chatgpt_orig_state",
        codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        codeChallengeMethod: "S256",
        scope: "iot:view iot:control",
        yandexCallbackUri: "https://alice.mctl.ai/auth/callback",
        createdAt: Date.now(),
        expiresAt: Date.now() + 600000,
      });

      const pending = storage.getPendingAuth(state);
      expect(pending).toBeDefined();
      expect(pending?.clientId).toBe("client_chatgpt_123");
      expect(pending?.clientState).toBe("chatgpt_orig_state");
      expect(pending?.codeChallengeMethod).toBe("S256");
      expect(pending?.yandexCallbackUri).toBe("https://alice.mctl.ai/auth/callback");

      storage.deletePendingAuth(state);
      const afterDelete = storage.getPendingAuth(state);
      expect(afterDelete).toBeNull();
    });
  });

  describe("Authorization Codes (One-Time Use)", () => {
    it("should save auth code and consume it exactly once", () => {
      const code = "code_single_use_abc";
      storage.saveAuthCode({
        code,
        clientId: "client_chatgpt_123",
        redirectUri: "https://chatgpt.com/aip/oauth/callback",
        codeChallenge: "challenge_xyz",
        codeChallengeMethod: "S256",
        yandexAccessToken: "yandex_at_token",
        yandexRefreshToken: "yandex_rt_token",
        yandexExpiresAt: Date.now() + 3600000,
        scope: "iot:view iot:control",
        createdAt: Date.now(),
        expiresAt: Date.now() + 300000,
      });

      // First consume should succeed
      const consumed = storage.consumeAuthCode(code);
      expect(consumed).toBeDefined();
      expect(consumed?.code).toBe(code);
      expect(consumed?.yandexAccessToken).toBe("yandex_at_token");

      // Second consume must return null (one-time use guarantee)
      const secondConsume = storage.consumeAuthCode(code);
      expect(secondConsume).toBeNull();
    });

    it("should not return expired authorization codes", () => {
      const code = "code_expired_123";
      storage.saveAuthCode({
        code,
        clientId: "client_chatgpt_123",
        redirectUri: "https://chatgpt.com/aip/oauth/callback",
        yandexAccessToken: "yandex_at_token",
        scope: "iot:view",
        createdAt: Date.now() - 600000,
        expiresAt: Date.now() - 1000, // already expired
      });

      const consumed = storage.consumeAuthCode(code);
      expect(consumed).toBeNull();
    });
  });

  describe("Tokens and Revocation (RFC 7009)", () => {
    it("should save and retrieve token by access token", () => {
      const accessToken = "mctl_at_user123";
      const refreshToken = "mctl_rt_user123";

      storage.saveToken({
        accessToken,
        refreshToken,
        clientId: "client_chatgpt_123",
        yandexAccessToken: "yandex_access_token_val",
        yandexRefreshToken: "yandex_refresh_token_val",
        yandexExpiresAt: Date.now() + 3600000,
        scope: "iot:view iot:control",
        createdAt: Date.now(),
        expiresAt: Date.now() + 2592000000,
      });

      const tokenRecord = storage.getToken(accessToken);
      expect(tokenRecord).toBeDefined();
      expect(tokenRecord?.accessToken).toBe(accessToken);
      expect(tokenRecord?.yandexAccessToken).toBe("yandex_access_token_val");

      const byRefresh = storage.getTokenByRefreshToken(refreshToken);
      expect(byRefresh).toBeDefined();
      expect(byRefresh?.accessToken).toBe(accessToken);
    });

    it("should revoke token and prevent further access", () => {
      const accessToken = "mctl_at_revoke_test";
      const refreshToken = "mctl_rt_revoke_test";

      storage.saveToken({
        accessToken,
        refreshToken,
        clientId: "client_chatgpt_123",
        yandexAccessToken: "yandex_token",
        scope: "iot:view",
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      });

      expect(storage.getToken(accessToken)).toBeDefined();

      // Revoke by access token
      storage.revokeToken(accessToken);
      expect(storage.getToken(accessToken)).toBeNull();
      expect(storage.getTokenByRefreshToken(refreshToken)).toBeNull();
    });

    it("should revoke token when passed refresh token", () => {
      const accessToken = "mctl_at_revoke_rt";
      const refreshToken = "mctl_rt_revoke_rt";

      storage.saveToken({
        accessToken,
        refreshToken,
        clientId: "client_chatgpt_123",
        yandexAccessToken: "yandex_token",
        scope: "iot:view",
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      });

      // Revoke using refresh token
      storage.revokeToken(refreshToken);
      expect(storage.getToken(accessToken)).toBeNull();
      expect(storage.getTokenByRefreshToken(refreshToken)).toBeNull();
    });
  });
});
