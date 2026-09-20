import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { OAuthController } from "../src/auth/oauth-controller.js";

describe("OAuthController", () => {
  let storage: OAuthStorage;
  let controller: OAuthController;
  const baseUrl = "https://alice.mctl.ai";
  const yandexClientId = "yandex_mock_client_id";
  const yandexClientSecret = "yandex_mock_client_secret";

  beforeEach(() => {
    storage = new OAuthStorage(":memory:");
    controller = new OAuthController({
      baseUrl,
      yandexClientId,
      yandexClientSecret,
      storage,
    });
  });

  describe("RFC 9728: Protected Resource Metadata", () => {
    it("should return compliant protected resource metadata", () => {
      const prm = controller.getProtectedResourceMetadata();
      expect(prm.resource).toBe("https://alice.mctl.ai/mcp");
      expect(prm.authorization_servers).toEqual(["https://alice.mctl.ai"]);
      expect(prm.scopes_supported).toContain("iot:view");
      expect(prm.scopes_supported).toContain("iot:control");
      expect(prm.bearer_methods_supported).toEqual(["header"]);
    });
  });

  describe("RFC 8414: Authorization Server Metadata", () => {
    it("should advertise correct endpoints, grant types, and PKCE support", () => {
      const asm = controller.getAuthorizationServerMetadata();
      expect(asm.issuer).toBe("https://alice.mctl.ai");
      expect(asm.authorization_endpoint).toBe("https://alice.mctl.ai/oauth/authorize");
      expect(asm.token_endpoint).toBe("https://alice.mctl.ai/oauth/token");
      expect(asm.revocation_endpoint).toBe("https://alice.mctl.ai/oauth/revoke");
      expect(asm.registration_endpoint).toBe("https://alice.mctl.ai/oauth/register");
      expect(asm.response_types_supported).toEqual(["code"]);
      expect(asm.grant_types_supported).toContain("authorization_code");
      expect(asm.grant_types_supported).toContain("refresh_token");
      expect(asm.code_challenge_methods_supported).toEqual(["S256"]);
    });
  });

  describe("RFC 7591: Dynamic Client Registration", () => {
    it("should register new client and persist in storage", async () => {
      const reg = await controller.registerClient({
        client_name: "ChatGPT OpenAI Connector",
        redirect_uris: ["https://chatgpt.com/aip/oauth/callback"],
      });

      expect(reg.client_id).toBeDefined();
      expect(reg.client_secret).toBeDefined();
      expect(reg.client_name).toBe("ChatGPT OpenAI Connector");
      expect(reg.redirect_uris).toEqual(["https://chatgpt.com/aip/oauth/callback"]);

      const stored = storage.getClient(reg.client_id);
      expect(stored).toBeDefined();
      expect(stored?.clientId).toBe(reg.client_id);
    });
  });

  describe("Redirect URI validation", () => {
    it("should allow ChatGPT, OpenAI, and Claude / Anthropic redirect URLs", async () => {
      expect(await controller.isAllowedRedirectUri("https://chatgpt.com/aip/g-xyz/oauth/callback")).toBe(true);
      expect(await controller.isAllowedRedirectUri("https://chat.openai.com/aip/oauth/callback")).toBe(true);
      expect(await controller.isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
      expect(await controller.isAllowedRedirectUri("https://sub.claude.ai/callback")).toBe(true);
      expect(await controller.isAllowedRedirectUri("https://anthropic.com/oauth/callback")).toBe(true);
      expect(await controller.isAllowedRedirectUri("http://localhost:3000/callback")).toBe(true);
    });

    it("should allow same-origin redirect_uri when client_id is an HTTPS URL", async () => {
      expect(
        await controller.isAllowedRedirectUri(
          "https://custom-mcp.org/auth/callback",
          "https://custom-mcp.org/oauth/metadata.json"
        )
      ).toBe(true);
    });

    it("should disallow arbitrary untrusted domains when not registered", async () => {
      expect(await controller.isAllowedRedirectUri("https://evil-attacker.com/oauth/callback")).toBe(false);
    });
  });

  describe("PKCE Verification (RFC 7636)", () => {
    it("should successfully verify standard S256 verifier against challenge", () => {
      // RFC 7636 appendix B example:
      // verifier = dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
      // SHA-256 base64url challenge = E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

      expect(controller.verifyPkce(verifier, challenge)).toBe(true);
    });

    it("should reject mismatched code verifier", () => {
      const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
      const wrongVerifier = "wrong_verifier_string_123456789012345678901234567890";

      expect(controller.verifyPkce(wrongVerifier, challenge)).toBe(false);
    });
  });

  describe("OAuth Authorize and Token Exchange Flow", () => {
    it("should validate /oauth/authorize request, create consent session and approve", async () => {
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

      const res = await controller.handleAuthorize({
        client_id: "chatgpt_client_1",
        redirect_uri: "https://chatgpt.com/aip/oauth/callback",
        response_type: "code",
        state: "client_state_123",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });

      expect(res.type).toBe("consent");
      if (res.type === "consent") {
        expect(res.sessionId).toBeDefined();
        expect(res.clientId).toBe("chatgpt_client_1");
        expect(res.redirectUri).toBe("https://chatgpt.com/aip/oauth/callback");
        expect(res.scope).toBe("iot:view iot:control");

        // Verify pending auth record in SQLite
        const pending = storage.getPendingAuth(res.sessionId);
        expect(pending).toBeDefined();
        expect(pending?.clientId).toBe("chatgpt_client_1");
        expect(pending?.codeChallenge).toBe(challenge);

        // Approve authorization
        const approval = await controller.approveAuthorization(res.sessionId);
        expect(approval.redirectUrl).toBeDefined();
        const u = new URL(approval.redirectUrl);
        expect(u.origin).toBe("https://chatgpt.com");
        expect(u.pathname).toBe("/aip/oauth/callback");
        expect(u.searchParams.get("code")).toMatch(/^code_/);
        expect(u.searchParams.get("state")).toBe("client_state_123");
        expect(u.searchParams.get("iss")).toBe(baseUrl);

        // Verify pending session was cleaned up
        expect(storage.getPendingAuth(res.sessionId)).toBeNull();

        // Verify code can be exchanged for tokens with PKCE
        const code = u.searchParams.get("code")!;
        const tokenRes = await controller.handleToken({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://chatgpt.com/aip/oauth/callback",
          code_verifier: verifier,
        });

        expect(tokenRes.access_token).toMatch(/^mctl_at_/);
        expect(tokenRes.refresh_token).toMatch(/^mctl_rt_/);
        expect(tokenRes.token_type).toBe("Bearer");
      }
    });

    it("should handle denial on consent screen", async () => {
      const res = await controller.handleAuthorize({
        client_id: "chatgpt_client_1",
        redirect_uri: "https://chatgpt.com/aip/oauth/callback",
        response_type: "code",
        state: "state_to_deny",
      });

      expect(res.type).toBe("consent");
      if (res.type === "consent") {
        const denial = await controller.denyAuthorization(res.sessionId);
        const u = new URL(denial.redirectUrl);
        expect(u.searchParams.get("error")).toBe("access_denied");
        expect(u.searchParams.get("state")).toBe("state_to_deny");
        expect(u.searchParams.get("iss")).toBe(baseUrl);
      }
    });

    it("should handle auto_approve: true directly on /oauth/authorize", async () => {
      const challenge = "wKx7ew8l8PQpLQAtHKOakwngFXcHnYqX78awGHoHErE";
      const res = await controller.handleAuthorize({
        client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        response_type: "code",
        state: "claude_state_456",
        code_challenge: challenge,
        code_challenge_method: "S256",
        auto_approve: true,
      });

      expect(res.type).toBe("redirect");
      if (res.type === "redirect") {
        const u = new URL(res.redirectUrl);
        expect(u.origin).toBe("https://claude.ai");
        expect(u.pathname).toBe("/api/mcp/auth_callback");
        expect(u.searchParams.get("code")).toMatch(/^code_/);
        expect(u.searchParams.get("state")).toBe("claude_state_456");
        expect(u.searchParams.get("iss")).toBe(baseUrl);
      }
    });

    it("should fast-path Codex client metadata", async () => {
      const res = await controller.handleAuthorize({
        client_id: "https://chatgpt.com/oauth/codex/client.json",
        redirect_uri: "http://127.0.0.1/callback",
        response_type: "code",
        state: "codex_state_789",
      });

      expect(res.type).toBe("consent");
      if (res.type === "consent") {
        expect(res.clientName).toBe("Codex");
      }
    });

    it("should reject authorize with invalid redirect_uri", async () => {
      const res = await controller.handleAuthorize({
        client_id: "chatgpt_client_1",
        redirect_uri: "https://malicious.com/steal_tokens",
      });

      expect("error" in res).toBe(true);
      if ("error" in res) {
        expect(res.error).toBe("invalid_request");
      }
    });

    it("should exchange authorization code with PKCE for tokens", async () => {
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
      const authCode = "code_test_exchange_123";

      storage.saveAuthCode({
        code: authCode,
        clientId: "chatgpt_client_1",
        redirectUri: "https://chatgpt.com/aip/oauth/callback",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        yandexAccessToken: "yandex_access_token_mock",
        yandexRefreshToken: "yandex_refresh_token_mock",
        yandexExpiresAt: Date.now() + 3600000,
        scope: "iot:view iot:control",
        createdAt: Date.now(),
        expiresAt: Date.now() + 300000,
      });

      // Token request with matching PKCE verifier
      const tokenResult = await controller.handleToken({
        grant_type: "authorization_code",
        code: authCode,
        client_id: "chatgpt_client_1",
        redirect_uri: "https://chatgpt.com/aip/oauth/callback",
        code_verifier: verifier,
      });

      expect(tokenResult.access_token).toBeDefined();
      expect(tokenResult.access_token.startsWith("mctl_at_")).toBe(true);
      expect(tokenResult.refresh_token).toBeDefined();
      expect(tokenResult.refresh_token?.startsWith("mctl_rt_")).toBe(true);
      expect(tokenResult.token_type).toBe("Bearer");

      // Verify token record in SQLite
      const tokenRecord = storage.getToken(tokenResult.access_token);
      expect(tokenRecord).toBeDefined();
      expect(tokenRecord?.yandexAccessToken).toBe("yandex_access_token_mock");
    });

    it("should fail token exchange if PKCE verifier does not match", async () => {
      const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
      const authCode = "code_test_pkce_fail";

      storage.saveAuthCode({
        code: authCode,
        clientId: "chatgpt_client_1",
        redirectUri: "https://chatgpt.com/aip/oauth/callback",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        yandexAccessToken: "yandex_access_token_mock",
        scope: "iot:view",
        createdAt: Date.now(),
        expiresAt: Date.now() + 300000,
      });

      await expect(
        controller.handleToken({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: "wrong_verifier_value",
        })
      ).rejects.toThrow("PKCE verification failed");
    });

    it("should revoke token when handleRevoke is called", async () => {
      const token = "mctl_at_to_be_revoked";
      storage.saveToken({
        accessToken: token,
        refreshToken: "mctl_rt_to_be_revoked",
        clientId: "chatgpt_client_1",
        yandexAccessToken: "yandex_tok",
        scope: "iot:view",
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      });

      expect(storage.getToken(token)).toBeDefined();
      await controller.handleRevoke(token);
      expect(storage.getToken(token)).toBeNull();
    });
  });
});
