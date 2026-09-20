import crypto from "node:crypto";
import { OAuthStorage } from "../storage/oauth-storage.js";
import { exchangeCodeForToken, refreshAccessToken } from "./token-storage.js";

export interface OAuthControllerOptions {
  baseUrl: string;
  yandexClientId: string;
  yandexClientSecret?: string;
  storage: OAuthStorage;
}

export class OAuthController {
  private baseUrl: string;
  private yandexClientId: string;
  private yandexClientSecret?: string;
  private storage: OAuthStorage;

  constructor(options: OAuthControllerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.yandexClientId = options.yandexClientId;
    this.yandexClientSecret = options.yandexClientSecret;
    this.storage = options.storage;
  }

  /**
   * RFC 9728 Protected Resource Metadata (PRM)
   * Advertises resource and authorization servers
   */
  getProtectedResourceMetadata() {
    return {
      resource: `${this.baseUrl}/mcp`,
      authorization_servers: [this.baseUrl],
      scopes_supported: ["iot:view", "iot:control"],
      bearer_methods_supported: ["header"],
      resource_name: "Yandex Alice Smart Home",
      resource_documentation: `${this.baseUrl}/healthz`,
    };
  }

  /**
   * RFC 8414 Authorization Server Metadata (ASM)
   * Advertises endpoints, grant types, and PKCE methods
   */
  getAuthorizationServerMetadata() {
    return {
      issuer: this.baseUrl,
      authorization_endpoint: `${this.baseUrl}/oauth/authorize`,
      token_endpoint: `${this.baseUrl}/oauth/token`,
      revocation_endpoint: `${this.baseUrl}/oauth/revoke`,
      registration_endpoint: `${this.baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
      scopes_supported: ["iot:view", "iot:control"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  /**
   * RFC 7591 Dynamic Client Registration
   */
  registerClient(body: {
    client_name?: string;
    redirect_uris?: string[];
    client_id?: string;
  }) {
    const clientId = body.client_id || `chatgpt_${crypto.randomUUID().replace(/-/g, "")}`;
    const clientSecret = crypto.randomUUID().replace(/-/g, "");
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    const clientName = body.client_name || "ChatGPT Client";

    this.storage.saveClient({
      clientId,
      clientSecret,
      clientName,
      redirectUris,
      createdAt: Date.now(),
    });

    return {
      client_id: clientId,
      client_secret: clientSecret,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /**
   * Check whether a redirect URI is permissible
   */
  isAllowedRedirectUri(redirectUri: string, clientId?: string): boolean {
    if (!redirectUri) return false;

    try {
      const u = new URL(redirectUri);
      // Allow OpenAI / ChatGPT domains
      if (
        u.hostname === "chatgpt.com" ||
        u.hostname.endsWith(".chatgpt.com") ||
        u.hostname === "chat.openai.com" ||
        u.hostname === "platform.openai.com" ||
        u.hostname === "localhost" ||
        u.hostname === "127.0.0.1"
      ) {
        return true;
      }
    } catch {
      return false;
    }

    if (clientId) {
      const client = this.storage.getClient(clientId);
      if (client && client.redirectUris.includes(redirectUri)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Handle /oauth/authorize from ChatGPT
   * Returns redirect URL to Yandex OAuth
   */
  handleAuthorize(params: {
    client_id: string;
    redirect_uri: string;
    response_type?: string;
    state?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    scope?: string;
  }): { redirectUrl: string } | { error: string; description: string; status: number } {
    if (!params.client_id) {
      return { error: "invalid_request", description: "client_id is required", status: 400 };
    }

    if (!params.redirect_uri || !this.isAllowedRedirectUri(params.redirect_uri, params.client_id)) {
      return { error: "invalid_request", description: "redirect_uri is invalid or not allowed", status: 400 };
    }

    const state = crypto.randomUUID();
    const clientState = params.state || "";
    const scope = params.scope || "iot:view iot:control";

    this.storage.savePendingAuth({
      state,
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      clientState,
      codeChallenge: params.code_challenge,
      codeChallengeMethod: params.code_challenge_method || "S256",
      scope,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    });

    const yandexCallbackUri = `${this.baseUrl}/oauth/yandex/callback`;
    const yandexAuthUrl =
      `https://oauth.yandex.ru/authorize?response_type=code` +
      `&client_id=${encodeURIComponent(this.yandexClientId)}` +
      `&redirect_uri=${encodeURIComponent(yandexCallbackUri)}` +
      `&state=${encodeURIComponent(state)}` +
      `&force_confirm=no`;

    return { redirectUrl: yandexAuthUrl };
  }

  /**
   * Handle callback from Yandex OAuth
   */
  async handleYandexCallback(query: {
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  }): Promise<{ redirectUrl: string }> {
    if (!query.state) {
      throw new Error("Missing state parameter in Yandex callback");
    }

    const pending = this.storage.getPendingAuth(query.state);
    if (!pending) {
      throw new Error("Authorization session expired or was already used. Please try again.");
    }
    this.storage.deletePendingAuth(query.state);

    if (query.error) {
      const errUrl = new URL(pending.redirectUri);
      errUrl.searchParams.set("error", query.error);
      if (query.error_description) errUrl.searchParams.set("error_description", query.error_description);
      if (pending.clientState) errUrl.searchParams.set("state", pending.clientState);
      return { redirectUrl: errUrl.toString() };
    }

    if (!query.code) {
      throw new Error("Missing authorization code in Yandex callback");
    }

    if (!this.yandexClientSecret) {
      throw new Error("Yandex client_secret is not configured on server");
    }

    // Exchange Yandex code for Yandex tokens
    const yandexCallbackUri = `${this.baseUrl}/oauth/yandex/callback`;
    const yandexTokens = await exchangeCodeForToken({
      code: query.code,
      clientId: this.yandexClientId,
      clientSecret: this.yandexClientSecret,
      redirectUri: yandexCallbackUri,
    });

    // Generate ChatGPT authorization code
    const chatgptCode = `code_${crypto.randomUUID().replace(/-/g, "")}`;
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes TTL

    this.storage.saveAuthCode({
      code: chatgptCode,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      yandexAccessToken: yandexTokens.access_token,
      yandexRefreshToken: yandexTokens.refresh_token,
      yandexExpiresAt: Date.now() + (yandexTokens.expires_in || 2592000) * 1000,
      scope: pending.scope,
      createdAt: Date.now(),
      expiresAt,
    });

    // Redirect user back to ChatGPT
    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set("code", chatgptCode);
    if (pending.clientState) {
      redirectUrl.searchParams.set("state", pending.clientState);
    }

    return { redirectUrl: redirectUrl.toString() };
  }

  /**
   * Verify PKCE S256 code verifier
   */
  verifyPkce(verifier: string, challenge: string): boolean {
    const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
    return computed === challenge;
  }

  /**
   * Handle /oauth/token from ChatGPT
   */
  async handleToken(body: {
    grant_type?: string;
    code?: string;
    redirect_uri?: string;
    client_id?: string;
    code_verifier?: string;
    refresh_token?: string;
  }): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
    scope?: string;
  }> {
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      if (!body.code) {
        throw new Error("Parameter 'code' is required for authorization_code grant");
      }

      const authCode = this.storage.consumeAuthCode(body.code);
      if (!authCode) {
        throw new Error("Invalid or expired authorization code");
      }

      // PKCE verification
      if (authCode.codeChallenge) {
        if (!body.code_verifier) {
          throw new Error("Parameter 'code_verifier' is required for PKCE verification");
        }
        if (!this.verifyPkce(body.code_verifier, authCode.codeChallenge)) {
          throw new Error("PKCE verification failed: code_verifier does not match code_challenge");
        }
      }

      // Issue Bearer tokens
      const accessToken = `mctl_at_${crypto.randomUUID().replace(/-/g, "")}`;
      const refreshToken = `mctl_rt_${crypto.randomUUID().replace(/-/g, "")}`;
      const expiresIn = 2592000; // 30 days

      this.storage.saveToken({
        accessToken,
        refreshToken,
        clientId: authCode.clientId,
        yandexAccessToken: authCode.yandexAccessToken,
        yandexRefreshToken: authCode.yandexRefreshToken,
        yandexExpiresAt: authCode.yandexExpiresAt,
        scope: authCode.scope,
        createdAt: Date.now(),
        expiresAt: Date.now() + expiresIn * 1000,
      });

      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        refresh_token: refreshToken,
        scope: authCode.scope,
      };
    }

    if (grantType === "refresh_token") {
      if (!body.refresh_token) {
        throw new Error("Parameter 'refresh_token' is required");
      }

      const existing = this.storage.getTokenByRefreshToken(body.refresh_token);
      if (!existing) {
        throw new Error("Invalid refresh_token");
      }

      let yandexAccessToken = existing.yandexAccessToken;
      let yandexRefreshToken = existing.yandexRefreshToken;
      let yandexExpiresAt = existing.yandexExpiresAt;

      // Refresh Yandex access token if needed and refresh token is present
      if (yandexRefreshToken && this.yandexClientSecret) {
        try {
          const refreshed = await refreshAccessToken({
            refreshToken: yandexRefreshToken,
            clientId: this.yandexClientId,
            clientSecret: this.yandexClientSecret,
          });
          yandexAccessToken = refreshed.access_token;
          if (refreshed.refresh_token) yandexRefreshToken = refreshed.refresh_token;
          if (refreshed.expires_in) yandexExpiresAt = Date.now() + refreshed.expires_in * 1000;
        } catch (err: any) {
          console.warn(`⚠️ Failed to refresh Yandex access token: ${err.message}`);
        }
      }

      // Rotate tokens
      this.storage.revokeToken(existing.accessToken);
      const newAccessToken = `mctl_at_${crypto.randomUUID().replace(/-/g, "")}`;
      const newRefreshToken = `mctl_rt_${crypto.randomUUID().replace(/-/g, "")}`;
      const expiresIn = 2592000;

      this.storage.saveToken({
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        clientId: existing.clientId,
        yandexAccessToken,
        yandexRefreshToken,
        yandexExpiresAt,
        scope: existing.scope,
        createdAt: Date.now(),
        expiresAt: Date.now() + expiresIn * 1000,
      });

      return {
        access_token: newAccessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        refresh_token: newRefreshToken,
        scope: existing.scope,
      };
    }

    throw new Error(`Unsupported grant_type: ${grantType}`);
  }

  /**
   * RFC 7009 Revoke token (Disconnect)
   */
  handleRevoke(token: string) {
    if (token) {
      this.storage.revokeToken(token);
    }
    return { status: "ok" };
  }
}
