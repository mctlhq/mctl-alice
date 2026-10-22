import { readBodyCapped } from "../server/request-body.js";
import { validScope } from "../tools/handlers.js";
import crypto from "node:crypto";
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { IStorage } from "../storage/storage-interface.js";
import { exchangeCodeForToken, refreshAccessToken } from "./token-storage.js";

/** An OAuth error carrying the RFC error code the endpoint should return. */
export class OAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface MetadataResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface OAuthControllerOptions {
  /** Fetches a client metadata document; replaceable in tests. */
  fetchMetadataDocument?: (url: string) => Promise<MetadataResponse>;
  authRequired?: boolean;
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

const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_METADATA_BYTES = 16 * 1024;
/** Bounds the whole metadata exchange; the 4 s idle timeout alone resets on every byte. */
export const METADATA_DEADLINE_MS = 5000;
/**
 * How long a redeemed authorization code is remembered to detect its reuse:
 * the 10-minute code lifetime plus a margin; longer adds no detection value.
 */
const SPENT_CODE_TTL_MS = 60 * 60 * 1000;
/**
 * A rotated refresh token presented again within this window is refused
 * without revoking its grant: a client retrying a refresh whose response it
 * lost, or a duplicate request in flight, is not evidence of theft. Requests
 * that lose a simultaneous refresh never reach the reuse check at all.
 */
export const REFRESH_REUSE_GRACE_MS = 10 * 1000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const FORBIDDEN_REDIRECT_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);

/**
 * True for addresses that must never be fetched server-side: loopback, private,
 * CGNAT, link-local (incl. cloud metadata), unspecified, multicast and reserved.
 */
export function isNonPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isNonPublicAddress(mapped[1]);
  // URL parsing rewrites IPv4-mapped literals to hex, e.g. [::ffff:10.0.0.1] -> [::ffff:a00:1].
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const [hi, lo] = mappedHex.slice(1).map((h) => parseInt(h, 16));
    return isNonPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    // 6to4 (2002::/16), Teredo (2001:0::/32), IPv4-translated (::ffff:0:0/96)
    // and IPv4-compatible (::/96) addresses embed an IPv4 address: never public here.
    if (/^2002:/.test(ip) || /^2001:0?:/.test(ip) || ip.startsWith("::ffff:0:") || /^::[0-9a-f]{1,4}(:[0-9a-f]{1,4})?$/.test(ip)) return true;
    return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith("ff") || ip.startsWith("64:ff9b:") || ip.startsWith("2001:db8:");
  }
  return true;
}

/**
 * Static checks on a client metadata URL: HTTPS on 443, no userinfo, and not a
 * local name or a non-public IP literal. Hostnames are vetted at connect time
 * by publicOnlyLookup.
 */
function isAcceptableMetadataUrl(urlString: string): boolean {
  let u: URL;
  try {
    u = new URL(urlString);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  const bare = host.replace(/^\[|\]$/g, "");
  return !net.isIP(bare) || !isNonPublicAddress(bare);
}

/**
 * dns.lookup replacement for outbound metadata requests. The connection uses
 * exactly the addresses vetted here, so a rebinding answer between a check and
 * the connect cannot slip through.
 */
export function publicOnlyLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.promises.lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
    if (!addresses.length || addresses.some((a) => isNonPublicAddress(a.address))) {
      callback(Object.assign(new Error(`Refusing non-public address for ${hostname}`), { code: "ENOTFOUND" }), []);
    } else if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  }, (err) => callback(err, []));
}

/** Concatenates a body stream, failing as soon as it exceeds the limit. */
export async function readCapped(stream: NodeJS.ReadableStream, limit: number): Promise<string> {
  return (await readBodyCapped(stream, limit, "Client metadata document is too large")).toString("utf8");
}

/** GET a metadata document: no redirects, public addresses only, 4 s idle and 5 s overall, size-capped. */
export function fetchMetadataDocument(url: string): Promise<MetadataResponse> {
  return new Promise<MetadataResponse>((resolveFetch, rejectFetch) => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), METADATA_DEADLINE_MS);
    const resolve = (value: MetadataResponse) => { clearTimeout(timer); resolveFetch(value); };
    const reject = (err: unknown) => { clearTimeout(timer); rejectFetch(err); };
    let response: import("node:http").IncomingMessage | undefined;
    const req = https.get(url, { lookup: publicOnlyLookup as any, signal: deadline.signal, headers: { Accept: "application/json", "User-Agent": "mctl-alice" } }, (res) => {
      response = res;
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) {
        res.destroy();
        reject(new Error("Client metadata document is too large"));
        return;
      }
      readCapped(res, MAX_METADATA_BYTES).then(
        (body) => resolve({ status: res.statusCode || 0, contentType: String(res.headers["content-type"] || ""), body }),
        (err) => { res.destroy(); reject(err); },
      );
    });
    req.setTimeout(4000, () => req.destroy(new Error("Client metadata request timed out")));
    deadline.signal.addEventListener("abort", () => {
      const err = new Error("Client metadata request exceeded its deadline");
      response?.destroy();
      req.destroy(err);
      reject(err);
    });
    req.on("error", reject);
  });
}

function isLoopbackHttp(u: URL): boolean {
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * Exact redirect URI matching, with the RFC 8252 section 7.3 exception that a
 * loopback redirect may use any port.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  try {
    const r = new URL(registered);
    const p = new URL(presented);
    return isLoopbackHttp(r) && isLoopbackHttp(p) && r.hostname === p.hostname &&
      r.pathname === p.pathname && r.search === p.search && !p.hash && !p.username && !p.password;
  } catch {
    return false;
  }
}

/** Returns the normalized redirect URI list, or throws when any entry is unacceptable. */
export function validateRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a non-empty array");
  if (value.length > MAX_REDIRECT_URIS) throw new OAuthError("invalid_redirect_uri", `At most ${MAX_REDIRECT_URIS} redirect_uris are allowed`);
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry || entry.length > MAX_URI_LENGTH) throw new OAuthError("invalid_redirect_uri", "Invalid redirect_uri");
    let u: URL;
    try {
      u = new URL(entry);
    } catch {
      throw new OAuthError("invalid_redirect_uri", "redirect_uri must be an absolute URI");
    }
    if (u.hash || entry.includes("#")) throw new OAuthError("invalid_redirect_uri", "redirect_uri must not contain a fragment");
    if (FORBIDDEN_REDIRECT_SCHEMES.has(u.protocol)) throw new OAuthError("invalid_redirect_uri", "redirect_uri scheme is not allowed");
    if (u.username || u.password) throw new OAuthError("invalid_redirect_uri", "redirect_uri must not contain credentials");
    return entry;
  });
}

function sanitizeClientName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return name ? name.slice(0, MAX_CLIENT_NAME_LENGTH) : fallback;
}

export class OAuthController {
  private authRequired: boolean;
  private baseUrl: string;
  private yandexClientId: string;
  private yandexClientSecret?: string;
  private storage: IStorage;
  private yandexCallbackUri: string;
  private fetchMetadata: (url: string) => Promise<MetadataResponse>;

  constructor(options: OAuthControllerOptions) {
    this.authRequired = options.authRequired ?? false;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.yandexClientId = options.yandexClientId;
    this.yandexClientSecret = options.yandexClientSecret;
    this.storage = options.storage;
    this.fetchMetadata = options.fetchMetadataDocument ?? fetchMetadataDocument;
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

    if (!this.authRequired && requestedId && !(await this.storage.getClient(requestedId))) {
      clientId = requestedId;
    } else {
      clientId = `chatgpt_${crypto.randomUUID().replace(/-/g, "")}`;
    }

    const clientSecret = crypto.randomUUID().replace(/-/g, "");
    const redirectUris = validateRedirectUris(body.redirect_uris);
    const clientName = sanitizeClientName(body.client_name, "MCP Client");

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
   * RFC 8707: the only protected resource this server issues tokens for is
   * itself, under any of the MCP endpoints it serves.
   */
  isOwnResource(resource: string): boolean {
    const normalized = resource.replace(/\/+$/, "");
    return ["", "/mcp", "/sse", "/mcp/sse", "/messages", "/mcp/messages"].some((path) => normalized === `${this.baseUrl}${path}`);
  }

  /**
   * Check whether a redirect URI is permissible
   */
  async isAllowedRedirectUri(redirectUri: string, clientId?: string): Promise<boolean> {
    if (!redirectUri) return false;

    // Hosted mode: only URIs registered for this exact client (DCR or client metadata document).
    if (this.authRequired) {
      if (!clientId) return false;
      const client = await this.storage.getClient(clientId);
      return !!client && client.redirectUris.some((registered) => redirectUriMatches(registered, redirectUri));
    }

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
      const client = (await this.storage.getClient(clientId));
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
    if (!isAcceptableMetadataUrl(clientId)) {
      console.warn(`[OAuth] Blocked metadata fetch for unsafe URL: ${clientId}`);
      return false;
    }

    try {
      const res = await this.fetchMetadata(clientId);
      if (res.status !== 200) return false;
      if (!res.contentType.toLowerCase().includes("json")) return false;
      const data = JSON.parse(res.body) as { client_id?: unknown; redirect_uris?: unknown; client_name?: unknown };
      // draft-ietf-oauth-client-id-metadata-document: the document must name itself.
      if (!data || typeof data !== "object" || data.client_id !== clientId) return false;
      await this.storage.saveClient({
        clientId,
        clientSecret: "",
        clientName: sanitizeClientName(data.client_name, new URL(clientId).hostname),
        redirectUris: validateRedirectUris(data.redirect_uris),
        createdAt: Date.now(),
      });
      return true;
    } catch (err: any) {
      console.warn(`[OAuth] Failed to resolve client metadata document for ${clientId}:`, err.message);
    }
    return false;
  }

  async getClientDisplayName(clientId: string): Promise<string> {
    const client = (await this.storage.getClient(clientId));
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
    resource?: string;
  }): Promise<AuthorizeResult> {
    if (!params.client_id) {
      return { error: "invalid_request", description: "client_id is required", status: 400 };
    }
    if (params.resource !== undefined && !this.isOwnResource(params.resource)) {
      return { error: "invalid_target", description: "resource does not identify this server", status: 400 };
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

    if (this.authRequired && (!params.userId || ["legacy_user", "usr_local"].includes(params.userId) || !await this.storage.getUser(params.userId))) {
      return { error: "login_required", description: "Sign in before approving access", status: 401 };
    }
    if (params.scope !== undefined && !validScope(params.scope)) return { error: "invalid_scope", description: "Invalid scopes", status: 400 };
    if (this.authRequired && (params.code_challenge_method !== "S256" || !params.code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge))) {
      return { error: "invalid_request", description: "PKCE S256 code_challenge is required", status: 400 };
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
    if (!this.authRequired && (params.auto_approve || params.prompt === "none" || process.env.OAUTH_AUTO_APPROVE === "true")) {
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
    const pending = (await this.storage.getPendingAuth(sessionId));
    if (!pending) {
      throw new Error("Authorization session expired or was already used. Please try again.");
    }
    if (pending.expiresAt <= Date.now()) throw new Error("Authorization expired");
    if (this.authRequired && (!userId || userId !== pending.userId || ["legacy_user", "usr_local"].includes(userId) || !await this.storage.getUser(userId))) throw new Error("Invalid authorization owner");

    const targetUserId = userId || pending.userId || "legacy_user";
    const scope = approvedScope ?? pending.scope;
    if (!validScope(scope) || !validScope(pending.scope) || scope.split(/\s+/).some(s => !pending.scope.split(/\s+/).includes(s))) throw new Error("Invalid scope selection");
    await this.storage.deletePendingAuth(sessionId);

    // Retrieve user credentials if available
    const userCreds = await this.storage.getUserCredentials(targetUserId);
    if (this.authRequired && (!userCreds || (!userCreds.yandexAccessToken && !userCreds.quasarCookie))) throw new Error("Reconnect your Yandex account");

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
    const pending = (await this.storage.getPendingAuth(sessionId));
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

    if (this.authRequired) throw new Error("Use browser-bound login before granting access");
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

    if (this.authRequired && (!pending.userId || !await this.storage.getUser(pending.userId) || !validScope(pending.scope))) throw new Error("Invalid authorization owner");
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
    scope?: string;
    resource?: string;
  }): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
    scope?: string;
  }> {
    const grantType = body.grant_type;
    if (body.resource !== undefined && !this.isOwnResource(body.resource)) throw new OAuthError("invalid_target", "resource does not identify this server");

    if (grantType === "authorization_code") {
      if (!body.code) {
        throw new Error("Parameter 'code' is required for authorization_code grant");
      }

      // RFC 9700 section 4.14 / OAuth 2.1: a code presented again revokes the
      // tokens already issued from it. Deliberately keyed on the code alone, as
      // the spec prescribes; only a presentation for another client is ignored.
      const grantId = crypto.randomUUID();
      const authCode = await this.storage.consumeAuthCode(body.code, { grantId, keepUntil: Date.now() + SPENT_CODE_TTL_MS });
      if (!authCode) {
        const spent = await this.storage.flagSpentSecretReuse(body.code);
        if (spent?.kind === "code" && spent.clientId === body.client_id) await this.storage.revokeGrantFamily(spent.grantId);
        throw new Error("Invalid or expired authorization code");
      }

      if (this.authRequired) {
        if (!authCode.userId || ["legacy_user", "usr_local"].includes(authCode.userId) || !await this.storage.getUser(authCode.userId) || !validScope(authCode.scope)) throw new Error("Invalid grant");
        if (body.client_id !== authCode.clientId || body.redirect_uri !== authCode.redirectUri) throw new Error("Client or redirect mismatch");
      }
      if (this.authRequired && (!authCode.codeChallenge || authCode.codeChallengeMethod !== "S256")) throw new Error("PKCE S256 is required");
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
        grantId,
      });
      // A replay that arrived while these tokens were being issued flagged the
      // code before revoking, so either it revoked them or this check sees it.
      if ((await this.storage.getSpentSecret(body.code))?.reusedAt) {
        await this.storage.revokeGrantFamily(grantId);
        throw new Error("Authorization code was reused");
      }

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
        // Already rotated when presented: reuse revokes the grant, past a short
        // grace for retries (see REFRESH_REUSE_GRACE_MS).
        const spent = await this.storage.getSpentSecret(body.refresh_token);
        if (spent?.kind === "refresh" && Date.now() - spent.spentAt > REFRESH_REUSE_GRACE_MS) await this.storage.revokeGrantFamily(spent.grantId);
        throw new Error("Invalid refresh_token");
      }

      if (this.authRequired && (!existing.userId || ["legacy_user", "usr_local"].includes(existing.userId) || !await this.storage.getUser(existing.userId) || !validScope(existing.scope) || (body.client_id !== undefined && body.client_id !== existing.clientId))) throw new Error("Invalid grant");
      if (body.scope !== undefined && (!validScope(body.scope) || body.scope.split(/\s+/).some(s => !existing.scope.split(/\s+/).includes(s)))) throw new Error("Invalid scope");
      const current = this.authRequired ? await this.storage.getUserCredentials(existing.userId!) : null;
      if (this.authRequired && (!current || (!current.yandexAccessToken && !current.quasarCookie))) throw new Error("Reconnect your Yandex account");
      let yandexAccessToken = this.authRequired ? current!.yandexAccessToken : existing.yandexAccessToken;
      let yandexRefreshToken = this.authRequired ? current!.yandexRefreshToken : existing.yandexRefreshToken;
      let yandexExpiresAt = this.authRequired ? current!.yandexExpiresAt : existing.yandexExpiresAt;

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
          throw new Error("Yandex refresh failed; reconnect your account");
        }
      }

      if (this.authRequired && current) {
        const latest = await this.storage.getUserCredentials(existing.userId!);
        if (!latest || latest.yandexAccessToken !== current.yandexAccessToken || !await this.storage.getUser(existing.userId!)) throw new Error("Connection changed; retry");
        if (!await this.storage.getTokenByRefreshToken(body.refresh_token)) throw new Error("Grant revoked");
        await this.storage.saveUserCredentials(existing.userId!, { ...latest, yandexAccessToken, yandexRefreshToken, yandexExpiresAt });
      }
      // Rotate tokens
      // Revoke by the presented refresh token: storage only knows the access
      // token as a digest, so existing.accessToken is an opaque handle here.
      // Losing this race to a simultaneous refresh is not reuse: no revocation.
      if (!await this.storage.revokeToken(body.refresh_token)) throw new Error("Grant already revoked or rotated");
      const grantId = existing.grantId || crypto.randomUUID();
      const expiresIn = 2592000;
      // Kept as long as the successor it protects, not just the rest of the
      // rotated token's own life, which may be seconds.
      await this.storage.recordSpentSecret(body.refresh_token, {
        kind: "refresh", grantId, clientId: existing.clientId, userId: existing.userId, spentAt: Date.now(),
        expiresAt: Math.max(existing.expiresAt, Date.now() + expiresIn * 1000),
      });
      const newAccessToken = `mctl_at_${crypto.randomUUID().replace(/-/g, "")}`;
      const newRefreshToken = `mctl_rt_${crypto.randomUUID().replace(/-/g, "")}`;

      await this.storage.saveToken({
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        clientId: existing.clientId,
        userId: existing.userId,
        yandexAccessToken,
        yandexRefreshToken,
        yandexExpiresAt,
        scope: body.scope ?? existing.scope,
        createdAt: Date.now(),
        expiresAt: Date.now() + expiresIn * 1000,
        grantId,
      });

      return {
        access_token: newAccessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        refresh_token: newRefreshToken,
        scope: body.scope ?? existing.scope,
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
