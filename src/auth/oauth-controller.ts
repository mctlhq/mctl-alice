import crypto from "node:crypto";
import { IStorage } from "../storage/storage-interface.js";
import { exchangeCodeForToken, refreshAccessToken } from "./token-storage.js";

export interface OAuthControllerOptions {
  baseUrl: string;
  yandexClientId: string;
  yandexClientSecret?: string;
  storage: IStorage;
  yandexCallbackUri?: string;
}

export type AuthorizeResult =
  | {
      type: "consent";
      sessionId: string;
      clientName: string;
      clientId: string;
      redirectUri: string;
      scope: string;
      clientState?: string;
      userId?: string;
    }
  | {
      type: "redirect";
      redirectUrl: string;
    }
  | {
      error: string;
      description: string;
      status: number;
    };

/**
 * Validates that an HTTPS URL does not point to loopback, private, link-local, or cloud metadata ranges.
 */
function isSafePublicHttpsUrl(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host === "127.0.0.1" ||
      host.startsWith("127.") ||
      host.startsWith("169.254.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export class OAuthController {
  private baseUrl: string;
  private yandexClientId: string;
  private yandexClientSecret?: string;
  private storage: IStorage;
  private yandexCallbackUri: string;

  constructor(options: OAuthControllerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.yandexClientId = options.yandexClientId;
    this.yandexClientSecret = options.yandexClientSecret;
    this.storage = options.storage;
    this.yandexCallbackUri =
      options.yandexCallbackUri ||
      process.env.YANDEX_CALLBACK_URL ||
      `${this.baseUrl}/auth/callback`;
  }

  getStorage(): IStorage {
    return this.storage;
  }

  /**
   * RFC 9728 Protected Resource Metadata (PRM)
   * Advertises resource and authorization servers
   */
  getProtectedResourceMetadata(resourceUri?: string) {
    return {
      resource: resourceUri || `${this.baseUrl}/mcp`,
      authorization_servers: [this.baseUrl],
      scopes_supported: ["iot:view", "iot:control", "quasar"],
      bearer_methods_supported: ["header"],
      resource_name: "Yandex Alice Smart Home",
      resource_documentation: `${this.baseUrl}/about`,
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
      scopes_supported: ["iot:view", "iot:control", "quasar"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  /**
   * RFC 7591 Dynamic Client Registration
   */
  async registerClient(body: {
    client_name?: string;
    redirect_uris?: string[];
    client_id?: string;
  }) {
    // Generate server-issued client ID to prevent impersonation or overwrites
    const requestedId = body.client_id;
    let clientId: string;

    if (requestedId && !(await this.storage.getClient(requestedId) as any)) {
      clientId = requestedId;
    } else {
      clientId = `chatgpt_${crypto.randomUUID().replace(/-/g, "")}`;
    }

    const clientSecret = crypto.randomUUID().replace(/-/g, "");
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    const clientName = body.client_name || "ChatGPT Client";

    await this.storage.saveClient({
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
  async isAllowedRedirectUri(redirectUri: string, clientId?: string): Promise<boolean> {
    if (!redirectUri) return false;

    try {
      const u = new URL(redirectUri);
      // Allow OpenAI / ChatGPT and Anthropic / Claude domains
      if (
        u.hostname === "chatgpt.com" ||
        u.hostname.endsWith(".chatgpt.com") ||
        u.hostname === "chat.openai.com" ||
        u.hostname === "platform.openai.com" ||
        u.hostname === "claude.ai" ||
        u.hostname.endsWith(".claude.ai") ||
        u.hostname === "anthropic.com" ||
        u.hostname.endsWith(".anthropic.com") ||
        u.hostname === "localhost" ||
        u.hostname === "127.0.0.1"
      ) {
        return true;
      }

      // If client_id is a URL, redirectUri must have the same origin
      if (clientId && (clientId.startsWith("https://") || clientId.startsWith("http://"))) {
        try {
          const clientUrl = new URL(clientId);
          if (clientUrl.origin === u.origin) {
            return true;
          }
        } catch {}
      }
    } catch {
      return false;
    }

    if (clientId) {
      const client = (await this.storage.getClient(clientId)) as any;
      if (client && client.redirectUris && client.redirectUris.includes(redirectUri)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Resolve and cache Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document)
   * if clientId is an HTTPS URL. Protects against SSRF.
   */
  async resolveClientMetadata(clientId: string): Promise<boolean> {
    if (!clientId.startsWith("https://")) return false;

    // Check if already in storage
    const existing = await this.storage.getClient(clientId);
    if (existing) return true;

    // Fast-path known clients like Claude and Codex to avoid remote network latency
    if (clientId === "https://claude.ai/oauth/mcp-oauth-client-metadata") {
      await this.storage.saveClient({
        clientId,
        clientSecret: "",
        clientName: "Claude",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        createdAt: Date.now(),
      });
      return true;
    }
    if (clientId === "https://chatgpt.com/oauth/codex/client.json") {
      await this.storage.saveClient({
        clientId,
        clientSecret: "",
        clientName: "Codex",
        redirectUris: ["http://127.0.0.1/callback", "http://localhost/callback"],
        createdAt: Date.now(),
      });
      return true;
    }

    // SSRF protection
    if (!isSafePublicHttpsUrl(clientId)) {
      console.warn(`[OAuth] Blocked metadata fetch for unsafe URL: ${clientId}`);
      return false;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(clientId, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) return false;
      const data = (await res.json()) as any;
      if (data && typeof data === "object") {
        const redirectUris = Array.isArray(data.redirect_uris) ? data.redirect_uris : [];
        const clientName = data.client_name || "Remote MCP Client";
        await this.storage.saveClient({
          clientId,
          clientSecret: "",
          clientName,
          redirectUris,
          createdAt: Date.now(),
        });
        return true;
      }
    } catch (err: any) {
      console.warn(`[OAuth] Failed to resolve client metadata document for ${clientId}:`, err.message);
    }
    return false;
  }

  async getClientDisplayName(clientId: string): Promise<string> {
    const client = (await this.storage.getClient(clientId)) as any;
    if (client?.clientName) return client.clientName;
    if (clientId.includes("codex")) return "Codex";
    if (clientId.includes("claude")) return "Claude";
    if (clientId.includes("chatgpt")) return "ChatGPT";
    if (clientId.startsWith("https://") || clientId.startsWith("http://")) {
      try {
        return new URL(clientId).hostname;
      } catch {}
    }
    return clientId;
  }

  /**
   * Handle /oauth/authorize from MCP clients (Codex, Claude, ChatGPT)
   */
  async handleAuthorize(params: {
    client_id: string;
    redirect_uri: string;
    response_type?: string;
    state?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    scope?: string;
    auto_approve?: boolean;
    prompt?: string;
    userId?: string;
  }): Promise<AuthorizeResult> {
    if (!params.client_id) {
      return { error: "invalid_request", description: "client_id is required", status: 400 };
    }

    if (params.client_id.startsWith("https://")) {
      await this.resolveClientMetadata(params.client_id);
    }

    if (!params.redirect_uri || !(await this.isAllowedRedirectUri(params.redirect_uri, params.client_id))) {
      return { error: "invalid_request", description: "redirect_uri is invalid or not allowed", status: 400 };
    }

    if (params.response_type && params.response_type !== "code") {
      return { error: "unsupported_response_type", description: "Only response_type=code is supported", status: 400 };
    }

    const sessionId = crypto.randomUUID();
    const clientState = params.state || "";
    const scope = params.scope || "iot:view iot:control";

    await this.storage.savePendingAuth({
      state: sessionId,
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      clientState,
      codeChallenge: params.code_challenge,
      codeChallengeMethod: params.code_challenge_method || "S256",
      scope,
      userId: params.userId,
      yandexCallbackUri: this.yandexCallbackUri,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    });

    // Auto-approve is only honored when explicitly requested or enabled in non-production
    if (params.auto_approve || (process.env.AUTH_REQUIRED !== "true" && (params.prompt === "none" || process.env.OAUTH_AUTO_APPROVE === "true"))) {
      const approval = await this.approveAuthorization(sessionId, params.userId);
      return { type: "redirect", redirectUrl: approval.redirectUrl };
    }

    const clientName = await this.getClientDisplayName(params.client_id);
    return {
      type: "consent",
      sessionId,
      clientName,
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      scope,
      clientState: params.state,
      userId: params.userId,
    };
  }

  /**
   * User approves authorization on the consent screen
   */
  async approveAuthorization(sessionId: string, userId?: string, approvedScope?: string): Promise<{ redirectUrl: string }> {
    const pending = (await this.storage.getPendingAuth(sessionId)) as any;
    if (!pending) {
      throw new Error("Authorization session expired or was already used. Please try again.");
    }
    await this.storage.deletePendingAuth(sessionId);

    const targetUserId = userId || pending.userId || "legacy_user";
    const scope = approvedScope || pending.scope;

    // Retrieve user credentials if available
    const userCreds = (await this.storage.getUserCredentials(targetUserId)) as any;

    const code = `code_${crypto.randomUUID().replace(/-/g, "")}`;
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes TTL

    await this.storage.saveAuthCode({
      code,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      userId: targetUserId,
      yandexAccessToken: userCreds?.yandexAccessToken || "",
      yandexRefreshToken: userCreds?.yandexRefreshToken,
      yandexExpiresAt: userCreds?.yandexExpiresAt,
      scope,
      createdAt: Date.now(),
      expiresAt,
    });

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (pending.clientState) {
      redirectUrl.searchParams.set("state", pending.clientState);
    }
    redirectUrl.searchParams.set("iss", this.baseUrl);

    return { redirectUrl: redirectUrl.toString() };
  }

  /**
   * User denies authorization on the consent screen
   */
  async denyAuthorization(sessionId: string): Promise<{ redirectUrl: string }> {
    const pending = (await this.storage.getPendingAuth(sessionId)) as any;
    if (!pending) {
      throw new Error("Authorization session expired or was already used. Please try again.");
    }
    await this.storage.deletePendingAuth(sessionId);

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set("error", "access_denied");
    redirectUrl.searchParams.set("error_description", "User denied access");
    if (pending.clientState) {
      redirectUrl.searchParams.set("state", pending.clientState);
    }
    redirectUrl.searchParams.set("iss", this.baseUrl);

    return { redirectUrl: redirectUrl.toString() };
  }

  /**
   * Handle callback from Yandex OAuth
   */
  async handleYandexCallback(query: {
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  }): Promise<{ redirectUrl: string; userId?: string }> {
    if (!query.state) {
      throw new Error("Missing state parameter in Yandex callback");
    }

    const pending = await this.storage.getPendingAuth(query.state);
    if (!pending) {
      throw new Error("Authorization session expired or was already used. Please try again.");
    }
    await this.storage.deletePendingAuth(query.state);

    if (query.error) {
      const errUrl = new URL(pending.redirectUri);
      errUrl.searchParams.set("error", query.error);
      if (query.error_description) errUrl.searchParams.set("error_description", query.error_description);
      if (pending.clientState) errUrl.searchParams.set("state", pending.clientState);
      errUrl.searchParams.set("iss", this.baseUrl);
      return { redirectUrl: errUrl.toString() };
    }

    if (!query.code) {
      throw new Error("Missing authorization code in Yandex callback");
    }

    if (!this.yandexClientSecret) {
      throw new Error("Yandex client_secret is not configured on server");
    }

    const callbackUri = pending.yandexCallbackUri || this.yandexCallbackUri;
    const yandexTokens = await exchangeCodeForToken({
      code: query.code,
      clientId: this.yandexClientId,
      clientSecret: this.yandexClientSecret,
      redirectUri: callbackUri,
    });

    const targetUserId = pending.userId || `usr_${crypto.randomUUID().slice(0, 12)}`;

    // Save encrypted credentials
    await this.storage.saveUserCredentials(targetUserId, {
      yandexAccessToken: yandexTokens.access_token,
      yandexRefreshToken: yandexTokens.refresh_token,
      yandexExpiresAt: Date.now() + (yandexTokens.expires_in || 2592000) * 1000,
    });

    const chatgptCode = `code_${crypto.randomUUID().replace(/-/g, "")}`;
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes TTL

    await this.storage.saveAuthCode({
      code: chatgptCode,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      userId: targetUserId,
      yandexAccessToken: yandexTokens.access_token,
      yandexRefreshToken: yandexTokens.refresh_token,
      yandexExpiresAt: Date.now() + (yandexTokens.expires_in || 2592000) * 1000,
      scope: pending.scope,
      createdAt: Date.now(),
      expiresAt,
    });

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set("code", chatgptCode);
    if (pending.clientState) {
      redirectUrl.searchParams.set("state", pending.clientState);
    }
    redirectUrl.searchParams.set("iss", this.baseUrl);

    return { redirectUrl: redirectUrl.toString(), userId: targetUserId };
  }

  /**
   * Verify PKCE S256 code verifier
   */
  verifyPkce(verifier: string, challenge: string): boolean {
    const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
    return computed === challenge;
  }

  /**
   * Handle /oauth/token from ChatGPT / Claude / Codex
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

      const authCode = await this.storage.consumeAuthCode(body.code);
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

      // Optional redirect_uri validation (RFC 6749 section 4.1.3)
      if (body.redirect_uri && authCode.redirectUri && body.redirect_uri !== authCode.redirectUri) {
        throw new Error("Parameter 'redirect_uri' does not match the authorization request");
      }

      // Issue Bearer tokens
      const accessToken = `mctl_at_${crypto.randomUUID().replace(/-/g, "")}`;
      const refreshToken = `mctl_rt_${crypto.randomUUID().replace(/-/g, "")}`;
      const expiresIn = 2592000; // 30 days

      await this.storage.saveToken({
        accessToken,
        refreshToken,
        clientId: authCode.clientId,
        userId: authCode.userId,
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

      const existing = await this.storage.getTokenByRefreshToken(body.refresh_token);
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
      await this.storage.revokeToken(existing.accessToken);
      const newAccessToken = `mctl_at_${crypto.randomUUID().replace(/-/g, "")}`;
      const newRefreshToken = `mctl_rt_${crypto.randomUUID().replace(/-/g, "")}`;
      const expiresIn = 2592000;

      await this.storage.saveToken({
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        clientId: existing.clientId,
        userId: existing.userId,
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
  async handleRevoke(token: string): Promise<{ status: string }> {
    if (token) {
      await this.storage.revokeToken(token);
    }
    return { status: "ok" };
  }

  /**
   * Get the active Yandex callback URI
   */
  getYandexCallbackUri(): string {
    return this.yandexCallbackUri;
  }
}
