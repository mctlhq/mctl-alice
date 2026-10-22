import { BrowserTransactions } from "../storage/browser-transactions.js";
import { CredentialDecryptionError } from "../storage/storage-interface.js";
import { getKeyring } from "../storage/crypto.js";
import { VERSION } from "../version.js";
import { isLocalOrigin } from "./origin.js";
import { FORM_BODY_LIMIT, MCP_BODY_LIMIT, PayloadTooLargeError, parseRequestBody, readRequestBody, sendPayloadTooLarge } from "./request-body.js";
import { RateLimiter, clientAddress, rateLimitBucket, resolveRateLimits, trustProxyHopsFromEnv, type RateLimitBucket } from "./rate-limit.js";
import { UpstreamError, UpstreamTimeoutError } from "../client/upstream.js";

export { isLocalOrigin };
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ALICE_TOOLS } from "../tools/definitions.js";
import { handleToolCall, checkScope, validScope, TOOL_SCOPES } from "../tools/handlers.js";
import { StationService } from "../services/station-service.js";
import { YandexIoTClient } from "../client/yandex-api.js";
import { QuasarClient } from "../client/quasar-client.js";
import {
  buildOAuthUrl,
  exchangeCodeForToken,
  saveTokenToEnvFile,
  saveRefreshTokenToEnvFile,
  saveTokenToKeychain,
  getTokenFromKeychain,
  saveCookieToEnvFile,
  saveCookieToKeychain,
  getCookieFromKeychain,
} from "../auth/token-storage.js";
import { getOpenApiSpec } from "./openapi.js";
import { TelemetryStorage, ITelemetryStorage } from "../storage/telemetry-storage.js";
import { TelemetrySampler } from "../services/telemetry-sampler.js";
import { IStorage, createStorage, createTelemetryStorage, OAuthStorage } from "../storage/index.js";
import { OAuthController, OAuthError } from "../auth/oauth-controller.js";
import { initQrAuth, checkQrAuthStatus } from "../auth/yandex-qr-auth.js";
import { fetchYandexProfile } from "../auth/oauth-helper.js";
import { renderAboutPage, renderPrivacyPage, renderTermsPage, renderSecurityPage } from "./pages.js";
import { renderAccountPage } from "./account-page.js";
import { UserRecord, guardedStorage, StorageUnavailableError } from "../storage/storage-interface.js";

/** Maximum JSON-RPC batch length accepted per request. */
const MAX_RPC_BATCH = 20;

const DEFAULT_CLIENT_ID = "c0ebe342af7d48fbbbfcf2d2eedb8f9e";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDirCandidates = [
  path.resolve(process.cwd(), "public"),
  path.resolve(__dirname, "../../public"),
  path.resolve(__dirname, "../public"),
];
const publicDir = publicDirCandidates.find((d) => fs.existsSync(d)) || publicDirCandidates[0];

const STATIC_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/** Static HTML names its asset suffix `?v=__VERSION__`, filled in at serve time. */
function withAssetVersion(html: string): string {
  return html.replaceAll("?v=__VERSION__", `?v=${VERSION}`);
}

function serveStaticFile(
  reqPath: string,
  res: http.ServerResponse,
  fallbackContentType = "application/octet-stream"
): boolean {
  let decoded = reqPath;
  try {
    decoded = decodeURIComponent(reqPath);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request");
    return true;
  }

  // Prevent directory traversal attacks
  const safePath = path.normalize(decoded).replace(/^[/\\]+/, "");
  const filePath = path.resolve(publicDir, safePath);

  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return true;
  }

  if (!fs.existsSync(filePath)) {
    return false;
  }

  try {
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      const indexPath = path.join(filePath, "index.html");
      if (fs.existsSync(indexPath)) {
        const content = withAssetVersion(fs.readFileSync(indexPath, "utf8"));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(content);
        return true;
      }
      return false;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = STATIC_MIME_TYPES[ext] || fallbackContentType;
    const content = ext === ".html" ? withAssetVersion(fs.readFileSync(filePath, "utf8")) : fs.readFileSync(filePath);

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderAuthPage({
  title,
  titleKey,
  contentHtml,
  scriptHtml = "",
}: {
  title: string;
  titleKey?: string;
  contentHtml: string;
  scriptHtml?: string;
}): string {
  return `<!doctype html>
<html lang="ru"${titleKey ? ` data-page-title-key="${escapeHtml(titleKey)}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="/assets/theme-init.js?v=${VERSION}"></script>
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/assets/tokens.css?v=${VERSION}">
<link rel="stylesheet" href="/assets/components.css?v=${VERSION}">
<link rel="stylesheet" href="/assets/pages.css?v=${VERSION}">
</head>
<body>
<header class="wrap topbar">
  <a class="brand" href="/">
    <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <circle class="s-b68d49" cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="2"/>
      <path class="s-b68d49" d="M16 8v16M11 11v10M21 11v10M6 14v4M26 14v4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
    </svg>
    mctl-alice
    <span class="chip-beta">BETA</span>
  </a>
  <nav class="topbar-links">
    <a href="/" data-i18n="nav_home">Главная</a>
    <a href="/account" data-i18n="nav_account">Аккаунт</a>
    <a href="/auth/login" data-i18n="nav_login">Вход (OAuth)</a>
    <a href="/auth/cookie" data-i18n="nav_cookie">Quasar Cookie</a>
    <a href="https://github.com/mctlhq/mctl-alice" target="_blank" rel="noopener" data-i18n="nav_github">GitHub</a>
    <div class="lang-switcher" id="lang-switcher" role="group" aria-label="Выбор языка / Language selection">
      <button class="lang-btn is-active" id="lang-btn-ru" type="button" data-lang="ru" aria-label="Русский">RU</button>
      <button class="lang-btn" id="lang-btn-en" type="button" data-lang="en" aria-label="English">EN</button>
    </div>
    <button class="theme-toggle" id="theme-toggle" type="button" hidden aria-label="Переключить тему оформления">
      <svg class="icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>
      </svg>
      <svg class="icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4"/>
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>
      </svg>
    </button>
  </nav>
</header>
<main class="wrap">
  <div class="form-card">
    ${contentHtml}
  </div>
</main>
<footer class="wrap">
  <div class="footer-row">
    <span data-i18n-html="footer_part">mctl-alice — часть платформы <a href="https://mctl.ai" target="_blank" rel="noopener">mctl</a>.</span>
    <span>
      <a href="/" data-i18n="nav_home">Главная</a> ·
      <a href="/account" data-i18n="footer_account">Личный кабинет</a> ·
      <a href="/about" data-i18n="footer_about">О сервисе</a> ·
      <a href="/privacy" data-i18n="footer_privacy">Конфиденциальность</a> ·
      <a href="/terms" data-i18n="footer_terms">Условия</a> ·
      <a href="/security" data-i18n="footer_security">Безопасность</a> ·
      <a href="https://github.com/mctlhq/mctl-alice" target="_blank" rel="noopener" data-i18n="nav_github">GitHub</a>
    </span>
  </div>
</footer>
<script src="/assets/site.js?v=${VERSION}"></script>
${scriptHtml}
</body>
</html>`;
}

// Pages ship no inline script or style: scripts and styles are files under
// /assets (inline style attributes became classes in pages.css).
export function contentSecurityPolicy(formActionExtra?: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self' https://fonts.googleapis.com",
    "style-src-attr 'none'",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    `form-action 'self'${formActionExtra ? ` ${formActionExtra}` : ""}`,
  ].join("; ");
}

const UNSAFE_FORM_ACTION_SCHEMES = new Set(["javascript:", "data:", "blob:", "file:", "vbscript:", "filesystem:"]);

/**
 * The CSP source a consent form needs so that the redirect back to the client
 * after POST /oauth/authorize is not blocked by form-action. Returns undefined
 * for anything that does not parse into a plain origin or scheme source.
 */
export function formActionSourceFor(redirectUri: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return undefined;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return /^https?:\/\/[A-Za-z0-9.\-\[\]:]+$/.test(parsed.origin) ? parsed.origin : undefined;
  }
  if (UNSAFE_FORM_ACTION_SCHEMES.has(parsed.protocol)) return undefined;
  return /^[a-z][a-z0-9+.\-]*:$/.test(parsed.protocol) ? parsed.protocol : undefined;
}

function setSecurityHeaders(res: http.ServerResponse, formActionExtra?: string): void {
  res.setHeader("Content-Security-Policy", contentSecurityPolicy(formActionExtra));
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
}

// Browser-facing MCP, OAuth and REST endpoints are bearer-authenticated, so
// they may be called cross-origin. Cookie-authenticated pages (/account,
// /auth/*, the consent page) get no CORS headers at all.
const CORS_EXACT_PATHS = new Set([
  "/", "/mcp", "/sse", "/messages", "/mcp/sse", "/mcp/messages",
  "/oauth/register", "/oauth/token", "/oauth/revoke",
  "/openapi.json", "/openapi.yaml",
]);

export function isCorsPath(pathname: string): boolean {
  return CORS_EXACT_PATHS.has(pathname)
    || pathname.startsWith("/.well-known/")
    || pathname.startsWith("/mcp/.well-known/")
    || pathname.startsWith("/api/");
}

const CORS_ALLOW_HEADERS = "Authorization, Content-Type, Accept, Last-Event-ID, Mcp-Session-Id, Mcp-Protocol-Version";
const CORS_EXPOSE_HEADERS = "Mcp-Session-Id, WWW-Authenticate";

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const list: Record<string, string> = {};
  const rc = req.headers.cookie;
  if (!rc) return list;
  rc.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    const key = parts.shift()?.trim();
    if (key) {
      list[key] = decodeURIComponent(parts.join("=").trim());
    }
  });
  return list;
}

async function getSessionUser(req: http.IncomingMessage, storage: IStorage): Promise<UserRecord | null> {
  const cookies = parseCookies(req);
  const sessionId = cookies["mctl_session"];
  if (!sessionId) return null;
  const session = await storage.getWebSession(sessionId);
  if (!session?.userId || ["legacy_user", "usr_local"].includes(session.userId)) return null;
  return storage.getUser(session.userId);
}


export class CookieAccountMismatchError extends Error {
  constructor() {
    super("This Yandex cookie belongs to a different account than the one you signed in with. Sign in to Yandex with the same account and try again.");
  }
}

/**
 * Hosted mode: a Quasar cookie may only be attached to the user whose Yandex
 * UID was verified through OAuth; anything else would let one account drive
 * another account's home.
 */
export async function assertCookieOwnedBy(cookie: string, user: UserRecord | null): Promise<void> {
  const uid = await new QuasarClient({ credentialsMode: "hosted", cookie, useKeychain: false, persistEnv: false }).getAccountUid();
  if (!uid || !user?.yandexUid || uid !== user.yandexUid) throw new CookieAccountMismatchError();
}

export type AuthResult =
  | { authenticated: true; mode: "hosted"; service: StationService; scope: string; userId: string; clientId: string }
  | { authenticated: true; mode: "local"; service: StationService; scope: "*"; userId?: never; clientId?: never }
  | { authenticated: false; service?: never; status: number; error?: "invalid_token" | "invalid_request" | "temporarily_unavailable"; errorMessage: string };

export function buildWwwAuthenticate(baseUrl: string, error?: string): string {
  const metadataUrl = `${baseUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource/mcp`;
  return `Bearer realm="mctl-alice", resource_metadata="${metadataUrl}"${error ? `, error="${error}"` : ""}`;
}

export async function authenticateRequest(
  req: http.IncomingMessage,
  defaultService?: StationService,
  defaultQuasar?: QuasarClient,
  oauthStorage?: IStorage,
  telemetryStorage?: ITelemetryStorage,
  authRequired = false
): Promise<AuthResult> {
  const fail = (errorMessage: string, status = 401): AuthResult => ({
    authenticated: false, status, error: status === 503 ? "temporarily_unavailable" : "invalid_token", errorMessage,
  });
  if (req.headers["x-yandex-cookie"]) return fail("Cookie headers are not supported");
  const header = req.headers.authorization;
  if (!header) {
    if (!authRequired && defaultService) return { authenticated: true, mode: "local", service: defaultService, scope: "*" };
    return { authenticated: false, status: 401, errorMessage: "authentication required" };
  }
  const match = /^Bearer +([a-zA-Z0-9._~+/-]+=*)$/i.exec(header);
  if (!match) return fail("Bearer token required");
  const rawToken = match[1];
  try {
    const record = await oauthStorage?.getToken(rawToken);
    if (record) {
      if (!authRequired && defaultService && record.expiresAt > Date.now() &&
          (!record.userId || ["legacy_user", "usr_local"].includes(record.userId))) {
        return { authenticated: true, mode: "local", service: defaultService, scope: "*" };
      }
      const userId = record.userId;
      if (!userId || ["legacy_user", "usr_local"].includes(userId) || !record.clientId ||
          !Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now() || !validScope(record.scope) ||
          !await oauthStorage!.getUser(userId)) return fail("Invalid token owner or grant");
      const creds = await oauthStorage!.getUserCredentials(userId);
      if (!creds || (!creds.yandexAccessToken && !creds.quasarCookie)) return fail("Reconnect your Yandex account");
      const client = creds.yandexAccessToken ? new YandexIoTClient(creds.yandexAccessToken, {
        credentialsMode: "hosted", refreshToken: creds.yandexRefreshToken,
        onRefresh: async (accessToken, refreshToken, expiresIn) => {
          if (!await oauthStorage!.getUser(userId)) throw new Error("Account deleted");
          const current = await oauthStorage!.getUserCredentials(userId);
          if (!current || current.yandexAccessToken !== creds.yandexAccessToken) throw new Error("Connection changed; retry");
          await oauthStorage!.saveUserCredentials(userId, { ...current, yandexAccessToken: accessToken,
            yandexRefreshToken: refreshToken || undefined,
            yandexExpiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined });
        },
      }) : undefined;
      const quasar = record.scope.split(/\s+/).includes("quasar") && creds.quasarCookie
        ? new QuasarClient({ credentialsMode: "hosted", cookie: creds.quasarCookie, userId, storage: oauthStorage,
          onCookieRefresh: async cookie => {
            const current = await oauthStorage!.getUserCredentials(userId);
            if (!current || current.quasarCookie !== creds.quasarCookie || !await oauthStorage!.getUser(userId)) throw new Error("Quasar connection changed; reconnect");
            await oauthStorage!.saveUserCredentials(userId, { ...current, quasarCookie: cookie });
            creds.quasarCookie = cookie;
          },
        }) : undefined;
      return { authenticated: true, mode: "hosted", userId, clientId: record.clientId, scope: record.scope,
        service: new StationService(client, quasar, telemetryStorage?.forUser(userId), "hosted") };
    }
    if (!authRequired && defaultService) {
      if (rawToken === process.env.YANDEX_OAUTH_TOKEN) return { authenticated: true, mode: "local", service: defaultService, scope: "*" };
      if (/^(y0_|y1_|AQAAAA)/.test(rawToken)) return { authenticated: true, mode: "local", scope: "*",
        service: new StationService(new YandexIoTClient(rawToken, { useKeychain: false, persistEnv: false }), defaultQuasar, telemetryStorage) };
    }
    return fail("Invalid access token");
  } catch {
    return fail("Credential storage unavailable", 503);
  }
}

export async function getAuthenticatedService(
  req: http.IncomingMessage, defaultService?: StationService, defaultQuasar?: QuasarClient,
  oauthStorage?: IStorage, telemetryStorage?: ITelemetryStorage, authRequired = false
): Promise<StationService> {
  const auth = await authenticateRequest(req, defaultService, defaultQuasar, oauthStorage, telemetryStorage, authRequired);
  if (!auth.authenticated) throw new Error(auth.errorMessage);
  return auth.service;
}

export function createMcpServer(
  service: StationService | (() => StationService | Promise<StationService>),
  scope: string = "*"
): Server {
  const getService = typeof service === "function" ? service : () => service;
  const server = new Server(
    {
      name: "mctl-alice",
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ALICE_TOOLS.filter(tool => checkScope(tool.name, scope)),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try { return await handleToolCall(name, args, await getService(), scope); }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Access check failed" }] }; }
  });

  return server;
}

/** 504/502 for a failed Yandex call, otherwise `fallback`. */
function upstreamStatus(err: unknown, fallback: number): number {
  return err instanceof UpstreamTimeoutError || err instanceof UpstreamError ? err.statusCode : fallback;
}

export interface HttpServerOptions {
  clientId?: string;
  clientSecret?: string;
  publicBaseUrl?: string;
  storage?: ITelemetryStorage;
  enableSampler?: boolean;
  oauthStorage?: IStorage;
  yandexCallbackUri?: string;
  authRequired?: boolean;
  /** Per-bucket requests per minute, over RATE_LIMIT_<BUCKET> and the defaults. */
  rateLimits?: Partial<Record<RateLimitBucket, number>>;
  /** Number of trusted proxy hops in X-Forwarded-For; defaults to TRUST_PROXY_HOPS or 0. */
  trustProxyHops?: number;
  /** Overall deadline for Quasar scenario cleanup on account deletion/disconnect (default 20 s). */
  cleanupDeadlineMs?: number;
}

const CLEANUP_DEADLINE_MS = 20_000;

export function createHttpServer(
  port = 8080,
  options: HttpServerOptions = {}
): http.Server {
  const authRequired =
    options.authRequired ?? (process.env.AUTH_REQUIRED === "true");
  const baseUrl = options.publicBaseUrl || process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
  const clientId =
    options.clientId ||
    process.env.YANDEX_CLIENT_ID ||
    getTokenFromKeychain("mctl-alice-client-id") ||
    DEFAULT_CLIENT_ID;
  const clientSecret =
    options.clientSecret ||
    process.env.YANDEX_CLIENT_SECRET ||
    getTokenFromKeychain("mctl-alice-client-secret") ||
    undefined;
  const redirectUri = `${baseUrl}/auth/callback`;
  const yandexCallbackUri =
    options.yandexCallbackUri ||
    process.env.YANDEX_CALLBACK_URL ||
    redirectUri;

  // An inconsistent ENCRYPTION_KEYS / ENCRYPTION_KEY_ID stops startup here
  // rather than on the first credential write.
  getKeyring();
  const oauthStorage = guardedStorage(options.oauthStorage || createStorage());
  const telemetryStorage = options.storage || createTelemetryStorage();
  const oauthController = new OAuthController({
    baseUrl,
    yandexClientId: clientId,
    yandexClientSecret: clientSecret,
    storage: oauthStorage,
    yandexCallbackUri,
    authRequired,
  });

  let quasarClient = authRequired ? undefined : new QuasarClient();
  let stationService = authRequired ? undefined : new StationService(undefined, quasarClient, telemetryStorage);

  let sampler: TelemetrySampler | null = null;
  if (!authRequired && stationService && options.enableSampler !== false) {
    try {
      sampler = new TelemetrySampler(stationService, stationService.getStorage());
      sampler.start();
    } catch (err: any) {
      console.warn(`⚠️ [mctl-alice] Telemetry sampler initialization skipped: ${err.message}`);
    }
  }

  // Keep track of active legacy SSE transports
  const sseTransports = new Map<string, SSEServerTransport>();

  const browserTransactions = new BrowserTransactions<{ browser: string; expires: number }>(oauthStorage, "consent");
  const loginTransactions = new BrowserTransactions<{ browser: string; expires: number; returnTo: string }>(oauthStorage, "login");
  /** The unexpired sign-in `state` names, if this browser started it. */
  async function liveLoginTransaction(state: string | null | undefined, req: http.IncomingMessage) {
    const transaction = state ? await loginTransactions.get(state) : undefined;
    return transaction && transaction.expires > Date.now() && transaction.browser === parseCookies(req).mctl_login ? transaction : undefined;
  }
  const qrOwners = new BrowserTransactions<{ userId: string; browser: string; expires: number }>(oauthStorage, "qr-owner");
  const browserId = (req: http.IncomingMessage) => parseCookies(req).mctl_session || "";
  const sseOwners = new Map<string, { userId?: string; clientId?: string; fingerprint: string }>();
  const fingerprint = (req: http.IncomingMessage) => createHash("sha256").update((req.headers.authorization || "").replace(/^Bearer +/i, "")).digest("hex");
  const limits = resolveRateLimits(options.rateLimits);
  const limiters = Object.fromEntries(
    (Object.keys(limits) as RateLimitBucket[]).map((bucket) => [bucket, new RateLimiter({ limit: limits[bucket], windowMs: 60_000 })]),
  ) as Record<RateLimitBucket, RateLimiter>;
  const proxyHops = options.trustProxyHops ?? trustProxyHopsFromEnv();
  const clearSessionCookie = `mctl_session=; Path=/; HttpOnly; SameSite=Lax; ${authRequired ? "Secure; " : ""}Max-Age=0`;
  async function closeSessions(userId: string, clientId?: string) {
    for (const [id, owner] of sseOwners) {
      if (owner.userId === userId && (!clientId || owner.clientId === clientId)) {
        await sseTransports.get(id)?.close();
        sseOwners.delete(id);
        sseTransports.delete(id);
      }
    }
  }

  // Helper for pure stateless MCP response (supports JSON and SSE format)
  function sendMcpResponse(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    data: any,
    statusCode = 200
  ) {
    const sessionId = (req.headers["mcp-session-id"] as string) || randomUUID();
    res.setHeader("mcp-session-id", sessionId);

    if (statusCode === 202 || data === undefined || data === null) {
      res.writeHead(202);
      res.end();
      return;
    }

    const acceptsSse = req.headers.accept?.includes("text/event-stream");
    if (acceptsSse) {
      res.writeHead(statusCode, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    } else {
      res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(data));
    }
  }

  async function handleSingleRpc(
    rpcReq: any,
    req: http.IncomingMessage,
    svc?: StationService,
    scope?: string
  ): Promise<any | null> {
    if (!rpcReq || typeof rpcReq !== "object") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      };
    }

    const id = rpcReq.id;
    const method = rpcReq.method;

    // Notifications have no id (e.g. notifications/initialized)
    if (id === undefined || id === null) {
      return null;
    }

    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: rpcReq.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mctl-alice", version: VERSION },
        },
      };
    }

    if (method === "ping") {
      return {
        jsonrpc: "2.0",
        id,
        result: {},
      };
    }

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: ALICE_TOOLS.filter(tool => checkScope(tool.name, scope)) },
      };
    }

    if (method === "tools/call") {
      const { name, arguments: args } = rpcReq.params || {};
      try {
        const fresh = await authenticateRequest(req, stationService, quasarClient, oauthStorage, telemetryStorage, authRequired);
        if (!fresh.authenticated) return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: fresh.errorMessage }] } };
        const activeSvc = fresh.service;
        scope = fresh.scope;
        const result = await handleToolCall(name, args, activeSvc, scope);
        return {
          jsonrpc: "2.0",
          id,
          result,
        };
      } catch (err: any) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: err.message || "Tool execution failed",
          },
        };
      }
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
    const url = new URL(req.url || "/", baseUrl);
    if (req.method === "POST" && (url.pathname.startsWith("/account/") || ["/oauth/authorize", "/auth/save-cookie", "/auth/save-token"].includes(url.pathname))) {
      // State-changing forms. Hosted: exactly our origin. Self-hosted: these
      // need no session and rewrite the stored Yandex credentials, so neither
      // a cross-site text/plain form nor an Origin-less non-browser request
      // may reach them; a browser always sends Origin on POST.
      const origin = req.headers.origin;
      const allowed = authRequired ? origin === new URL(baseUrl).origin : origin !== undefined && isLocalOrigin(origin, baseUrl);
      if (!allowed) {
        res.writeHead(403); res.end("Invalid origin"); return;
      }
    }

    setSecurityHeaders(res);

    const corsPath = isCorsPath(url.pathname);
    // Without auth any page the operator visits could drive the local server
    // through CORS, so only this server's own origin or a loopback one may.
    if (!authRequired && corsPath && !isLocalOrigin(req.headers.origin, baseUrl)) {
      res.writeHead(403); res.end("Invalid origin"); return;
    }
    if (corsPath) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
      res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
      res.setHeader("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
      res.setHeader("Access-Control-Max-Age", "600");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(corsPath ? 204 : 405, corsPath ? {} : { Allow: "GET, POST, HEAD" });
      res.end();
      return;
    }

    const bucket = rateLimitBucket(url.pathname, req.method, String(req.headers.accept || ""));
    if (bucket) {
      // Always charge the address bucket: a token is unvalidated here, so it may only add a dimension.
      let verdict = limiters[bucket].hit(`ip:${clientAddress(req, proxyHops)}`);
      if (verdict.allowed && bucket === "mcp" && req.headers.authorization) verdict = limiters[bucket].hit(`token:${fingerprint(req)}`);
      if (!verdict.allowed) {
        res.writeHead(429, { "Content-Type": "application/json; charset=utf-8", "Retry-After": String(verdict.retryAfterSec), "Cache-Control": "no-store" });
        res.end(JSON.stringify(
          bucket === "mcp" && req.method === "POST" && !url.searchParams.has("sessionId")
            ? { jsonrpc: "2.0", id: null, error: { code: -32029, message: "Rate limit exceeded" } }
            : { error: "too_many_requests" },
        ));
        return;
      }
    }

    // A declared oversize body is refused before anything reads it.
    if (req.method === "POST") {
      const declared = req.headers["content-length"];
      const limit = bucket === "mcp" ? MCP_BODY_LIMIT : FORM_BODY_LIMIT;
      if (declared !== undefined && Number(declared) > limit) { sendPayloadTooLarge(res); return; }
    }

    if (url.pathname === "/readyz") {
      try {
        await oauthStorage.getUser("__readiness_probe__");
        await telemetryStorage.getStats();
      } catch {
        res.writeHead(503); res.end(JSON.stringify({ status: "unavailable" })); return;
      }
    }
    // Health check for Kubernetes probes
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "mctl-alice", version: VERSION }));
      return;
    }

    console.log(`[HTTP] ${req.method} ${url.pathname}`);

    // Static assets
    if (url.pathname.startsWith("/assets/") && req.method === "GET") {
      const served = serveStaticFile(url.pathname, res);
      if (served) return;
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    if (
      (url.pathname === "/favicon.svg" ||
        url.pathname === "/favicon.ico" ||
        url.pathname === "/robots.txt") &&
      req.method === "GET"
    ) {
      const served = serveStaticFile(url.pathname, res);
      if (served) return;
    }

    // OpenAPI 3.1 schema for ChatGPT Actions and external integrators
    if (url.pathname === "/openapi.json" || url.pathname === "/openapi.yaml") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getOpenApiSpec(baseUrl), null, 2));
      return;
    }

    // RFC 9728 Protected Resource Metadata (PRM)
    if (
      (url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
        url.pathname === "/mcp/.well-known/oauth-protected-resource") &&
      req.method === "GET"
    ) {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      });
      res.end(JSON.stringify(oauthController.getProtectedResourceMetadata(), null, 2));
      return;
    }

    // RFC 8414 Authorization Server Metadata (ASM) & OIDC Discovery
    if (
      (url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/oauth-authorization-server/mcp" ||
        url.pathname === "/.well-known/openid-configuration") &&
      req.method === "GET"
    ) {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      });
      res.end(JSON.stringify(oauthController.getAuthorizationServerMetadata(), null, 2));
      return;
    }

    // RFC 7591 Dynamic Client Registration
    if (url.pathname === "/oauth/register" && req.method === "POST") {
      try {
        const body = await parseRequestBody(req);
        const clientInfo = await oauthController.registerClient(body);
        res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(clientInfo));
      } catch (err: any) {
        if (err instanceof PayloadTooLargeError) throw err;
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof OAuthError ? err.code : "invalid_request", error_description: err.message }));
      }
      return;
    }

    // OAuth: Authorize Endpoint (GET: Consent screen or auto-approve redirect)
    if (url.pathname === "/oauth/authorize" && req.method === "GET") {
      const sessionIdParam = url.searchParams.get("session_id");
      const actionParam = url.searchParams.get("action");

      // Direct approval / denial via GET query params if session_id is present
      if (sessionIdParam && actionParam && !authRequired) {
        try {
          if (actionParam === "deny") {
            const result = await oauthController.denyAuthorization(sessionIdParam);
            res.writeHead(302, { Location: result.redirectUrl });
            res.end();
            return;
          }
          const user = await getSessionUser(req, oauthStorage);
          const result = await oauthController.approveAuthorization(sessionIdParam, user?.id);
          res.writeHead(302, { Location: result.redirectUrl });
          res.end();
          return;
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderAuthPage({
            title: "mctl-alice — Ошибка сессии",
            contentHtml: `
              <h2>Сессия авторизации не найдена или истекла</h2>
              <p class="s-de799f">${escapeHtml(err.message)}</p>
              <p><a href="/" class="btn btn-secondary">Вернуться на главную</a></p>
            `,
          }));
          return;
        }
      }

      const clientId = url.searchParams.get("client_id") || "";
      const redirectUri = url.searchParams.get("redirect_uri") || "";
      const state = url.searchParams.get("state") || "";
      const autoApprove = url.searchParams.get("auto_approve") === "true";
      const prompt = url.searchParams.get("prompt") || undefined;

      const consentUser = await getSessionUser(req, oauthStorage);
      if (authRequired && !consentUser) {
        res.writeHead(302, { Location: "/auth/login?return_to=" + encodeURIComponent(url.pathname + url.search) }); res.end(); return;
      }
      const result = await oauthController.handleAuthorize({
        userId: consentUser?.id,
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: url.searchParams.get("response_type") || undefined,
        state: state || undefined,
        code_challenge: url.searchParams.get("code_challenge") || undefined,
        code_challenge_method: url.searchParams.get("code_challenge_method") || undefined,
        scope: url.searchParams.get("scope") || undefined,
        auto_approve: autoApprove,
        prompt,
        resource: url.searchParams.get("resource") ?? undefined,
      });

      if ("error" in result) {
        res.writeHead(result.status || 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: result.error, error_description: result.description }));
        return;
      }

      if (result.type === "redirect") {
        res.writeHead(302, { Location: result.redirectUrl });
        res.end();
        return;
      }

      if (authRequired) await browserTransactions.set(result.sessionId, { browser: browserId(req), expires: Date.now() + 600000 });
      setSecurityHeaders(res, formActionSourceFor(result.redirectUri));
      // Render Consent Page
      const clientName = escapeHtml(result.clientName);
      const safeClientId = escapeHtml(result.clientId);
      const safeRedirectUri = escapeHtml(result.redirectUri);
      const sessionId = escapeHtml(result.sessionId);

      const content = `
        <div class="s-4fe212">
          <div class="s-8931b9">
            <svg class="s-b68d49" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <h2 class="s-6e1a2b" data-i18n="oauth_consent_title">Авторизация приложения</h2>
          <p class="s-1ebcf8" data-i18n="oauth_consent_lead">Приложение запрашивает доступ к вашему серверу Alice MCP</p>
        </div>

        <div class="card s-874b5b">
          <div class="s-096cd3">
            <span class="s-818cd7" data-i18n="oauth_app_name">Приложение:</span>
            <span class="s-e694bb">${clientName}</span>
          </div>
          <div class="s-c4e802">
            <span class="s-67130d">${safeClientId}</span>
          </div>
          <div class="s-e8b790">
            <span data-i18n="oauth_redirect_uri">Redirect URI:</span> <span class="s-67130d">${safeRedirectUri}</span>
          </div>
        </div>

        <div class="s-eb4739">
          <div class="s-cd2ba0" data-i18n="oauth_scopes_title">Запрашиваемые права доступа:</div>
          <ul>${result.scope.split(/\s+/).map(scope => `<li><label><input form="consent" type="checkbox" name="scope_${escapeHtml(scope)}" value="yes" checked> ${escapeHtml(scope)}</label></li>`).join("")}</ul>
        </div>

        <div class="alert alert-info s-63b8a5">
          <span data-i18n="oauth_status_connected">Подключение к умному дому Яндекс Алисы активно.</span>
        </div>

        <form class="s-a8904c" id="consent" method="POST" action="/oauth/authorize">
          <input type="hidden" name="session_id" value="${sessionId}">
          <button type="submit" name="action" value="deny" class="btn btn-secondary s-634a28" data-i18n="oauth_btn_deny">Отклонить</button>
          <button type="submit" name="action" value="approve" class="btn btn-primary s-08ec4a" data-i18n="oauth_btn_approve">Разрешить доступ</button>
        </form>
      `;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderAuthPage({
        title: "mctl-alice — Авторизация приложения",
        titleKey: "oauth_consent_title",
        contentHtml: content,
      }));
      return;
    }

    // OAuth: Authorize POST Endpoint (Approve / Deny)
    if (url.pathname === "/oauth/authorize" && req.method === "POST") {
      try {
        const body = await parseRequestBody(req);
        const sessionId = body?.session_id || "";
        const action = body?.action || "approve";

        if (!sessionId) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "invalid_request", error_description: "session_id is required" }));
          return;
        }

        if (authRequired) {
          const transaction = await browserTransactions.get(sessionId);
          const user = await getSessionUser(req, oauthStorage);
          if (!user || !transaction || transaction.expires <= Date.now() || transaction.browser !== browserId(req)) throw new Error("Invalid browser transaction");
          await browserTransactions.delete(sessionId);
        }
        if (action === "deny") {
          const result = await oauthController.denyAuthorization(sessionId);
          res.writeHead(302, { Location: result.redirectUrl });
          res.end();
          return;
        }

        const user = await getSessionUser(req, oauthStorage);
        const result = await oauthController.approveAuthorization(sessionId, user?.id, authRequired ? ["iot:view", "iot:control", "quasar"].filter(scope => body[`scope_${scope}`] === "yes").join(" ") : undefined);
        res.writeHead(302, { Location: result.redirectUrl });
        res.end();
        return;
      } catch (err: any) {
        if (err instanceof PayloadTooLargeError) throw err;
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderAuthPage({
          title: "mctl-alice — Ошибка сессии",
          contentHtml: `
            <h2>Сессия авторизации не найдена или истекла</h2>
            <p class="s-de799f">${escapeHtml(err.message)}</p>
            <p><a href="/" class="btn btn-secondary">Вернуться на главную</a></p>
          `,
        }));
        return;
      }
    }

    // OAuth: Yandex Callback Endpoint
    if (url.pathname === "/oauth/yandex/callback" && req.method === "GET") {
      if (authRequired) { res.writeHead(400); res.end("Use the browser-bound /auth/login flow"); return; }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      try {
        const result = await oauthController.handleYandexCallback({
          code: code || undefined,
          state: state || undefined,
          error: error || undefined,
          error_description: errorDescription || undefined,
        });
        res.writeHead(302, { Location: result.redirectUrl });
        res.end();
      } catch (err: any) {
        res.writeHead(err instanceof StorageUnavailableError ? 503 : 500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"><title>OAuth Error</title><link rel="stylesheet" href="/assets/pages.css?v=${VERSION}"></head>
<body class="s-b84785">
  <h2 class="s-f892ee">Ошибка авторизации Яндекс</h2>
  <p class="s-128036">${escapeHtml(err.message)}</p>
  <p><a class="s-518b09" href="${baseUrl}/auth/login">Попробовать снова</a></p>
</body>
</html>`);
      }
      return;
    }

    // OAuth: Token Endpoint (Authorization Code + PKCE & Refresh Token)
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      try {
        const body = await parseRequestBody(req);
        const tokens = await oauthController.handleToken(body);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          Pragma: "no-cache",
        });
        res.end(JSON.stringify(tokens));
      } catch (err: any) {
        if (err instanceof PayloadTooLargeError) throw err;
        // An unreadable stored grant is a server fault: answering invalid_grant would make
        // clients drop it and re-authorize over ciphertext a corrected key could still read.
        const unavailable = err instanceof StorageUnavailableError || err instanceof CredentialDecryptionError;
        res.writeHead(unavailable ? 503 : 400, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(unavailable
          ? { error: "temporarily_unavailable", error_description: "Authorization storage is temporarily unavailable" }
          : { error: err instanceof OAuthError ? err.code : "invalid_grant", error_description: err.message }));
      }
      return;
    }

    // OAuth: Revocation Endpoint (RFC 7009 - Disconnect in ChatGPT)
    if (url.pathname === "/oauth/revoke" && req.method === "POST") {
      try {
        const body = await parseRequestBody(req);
        const token = body?.token || url.searchParams.get("token") || "";
        const record = await oauthStorage.getToken(token) || await oauthStorage.getTokenByRefreshToken(token);
        await oauthController.handleRevoke(token);
        if (record?.userId) await closeSessions(record.userId, record.clientId);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "ok" }));
      } catch (bodyErr) {
        if (bodyErr instanceof PayloadTooLargeError) throw bodyErr;
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "temporarily_unavailable" }));
      }
      return;
    }

    // Helper to send 401 Unauthorized with RFC 9728 WWW-Authenticate
    const sendUnauthorized = (authError?: string, message = "authentication required", status = 401) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        ...(status === 401 ? { "WWW-Authenticate": buildWwwAuthenticate(baseUrl, authError) } : {}),
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ error: authError || message }));
    };

    // Pure Stateless MCP JSON-RPC endpoint (for ChatGPT Connectors, Claude, Streamable HTTP & direct JSON-RPC)
    const isMcpPost =
      (url.pathname === "/mcp" ||
        url.pathname === "/" ||
        url.pathname === "/sse" ||
        url.pathname === "/mcp/sse") &&
      req.method === "POST" && !url.searchParams.has("sessionId");

    if (isMcpPost) {
      const auth = await authenticateRequest(req, stationService, quasarClient, oauthStorage, telemetryStorage, authRequired);
      if (!auth.authenticated) {
        sendUnauthorized(auth.error, auth.errorMessage, auth.status);
        return;
      }
      const activeSvc = auth.service;

      const body = await readRequestBody(req, { limit: MCP_BODY_LIMIT });
      {
        try {
          if (!body.trim()) {
            sendMcpResponse(req, res, null, 204);
            return;
          }
          const rpcData = JSON.parse(body);
          if (Array.isArray(rpcData)) {
            if (rpcData.length > MAX_RPC_BATCH) {
              sendMcpResponse(
                req,
                res,
                {
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32600, message: `Invalid Request: batch exceeds ${MAX_RPC_BATCH} elements` },
                },
                400
              );
              return;
            }
            const results = [];
            for (const item of rpcData) {
              const resItem = await handleSingleRpc(item, req, activeSvc, auth.scope);
              if (resItem !== null) {
                results.push(resItem);
              }
            }
            if (results.length === 0) {
              sendMcpResponse(req, res, null, 202);
            } else {
              sendMcpResponse(req, res, results);
            }
          } else {
            const result = await handleSingleRpc(rpcData, req, activeSvc, auth.scope);
            if (result === null) {
              sendMcpResponse(req, res, null, 202);
            } else {
              sendMcpResponse(req, res, result);
            }
          }
        } catch (err: any) {
          sendMcpResponse(
            req,
            res,
            {
              jsonrpc: "2.0",
              error: { code: -32700, message: "Parse error: " + err.message },
            },
            400
          );
        }
      }
      return;
    }

    // MCP SSE endpoint for ChatGPT Connectors / remote MCP clients
    // Only upgrade to SSE if:
    // 1) Explicit SSE endpoint path (/sse, /mcp/sse), OR
    // 2) Accept header contains text/event-stream on /mcp or /
    const isExplicitSsePath = url.pathname === "/sse" || url.pathname === "/mcp/sse";
    const acceptsSse = Boolean(req.headers.accept?.includes("text/event-stream"));
    const isSseRequest =
      (isExplicitSsePath || ((url.pathname === "/mcp" || url.pathname === "/") && acceptsSse)) &&
      req.method === "GET";

    if (isSseRequest) {
      const auth = await authenticateRequest(req, stationService, quasarClient, oauthStorage, telemetryStorage, authRequired);
      if (!auth.authenticated) {
        sendUnauthorized(auth.error, auth.errorMessage, auth.status);
        return;
      }

      try {
        const svc = auth.service;
        const transport = new SSEServerTransport("/messages", res);
        const sessionId = transport.sessionId;
        sseTransports.set(sessionId, transport);
        sseOwners.set(sessionId, { userId: auth.userId, clientId: auth.clientId, fingerprint: fingerprint(req) });

        transport.onclose = () => {
          sseTransports.delete(sessionId);
          sseOwners.delete(sessionId);
        };

        const mcpServer = createMcpServer(async () => {
          const fresh = await authenticateRequest(req, stationService, quasarClient, oauthStorage, telemetryStorage, authRequired);
          if (!fresh.authenticated) throw new Error(fresh.errorMessage);
          if (fresh.scope !== auth.scope) throw new Error("Grant changed; reconnect");
          return fresh.service;
        }, auth.scope);
        await mcpServer.connect(transport);
      } catch (err: any) {
        if (!res.headersSent) {
          res.writeHead(err instanceof StorageUnavailableError ? 503 : 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: err.message }));
        }
      }
      return;
    }

    // Standard HTTP GET /mcp (not SSE, e.g. RFC 9728 discovery probe, ping, or client info check)
    if (url.pathname === "/mcp" && req.method === "GET") {
      const auth = await authenticateRequest(req, stationService, quasarClient, oauthStorage, telemetryStorage, authRequired);
      if (!auth.authenticated) {
        sendUnauthorized(auth.error, auth.errorMessage, auth.status);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          service: "mctl-alice",
          endpoint: "/mcp",
          status: "ready",
          transport: "streamable-http",
          protocolVersion: "2024-11-05",
        })
      );
      return;
    }

    // MCP messages endpoint for SSE transport
    const isMessagePost =
      (url.pathname === "/messages" ||
        url.pathname === "/mcp/messages" ||
        (url.pathname === "/mcp" && url.searchParams.has("sessionId"))) &&
      req.method === "POST";

    if (isMessagePost) {
      const sessionId = url.searchParams.get("sessionId");
      const transport = sessionId ? sseTransports.get(sessionId) : undefined;
      if (!transport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found or expired" }));
        return;
      }
      const auth = await authenticateRequest(req, stationService, quasarClient, oauthStorage, telemetryStorage, authRequired);
      if (!auth.authenticated) { sendUnauthorized(auth.error, auth.errorMessage, auth.status); return; }
      const owner = sseOwners.get(sessionId!);
      if (!owner || owner.userId !== auth.userId || owner.clientId !== auth.clientId || owner.fingerprint !== fingerprint(req)) {
        sendUnauthorized("invalid_token", "Session owner mismatch"); return;
      }
      const raw = await readRequestBody(req, { limit: MCP_BODY_LIMIT });
      let parsed: unknown = raw;
      try { parsed = JSON.parse(raw); } catch { /* the transport answers 400 for an unparsable body */ }
      try {
        await transport.handlePostMessage(req, res, parsed ?? raw);
      } catch (err: any) {
        if (!res.headersSent) {
          res.writeHead(err instanceof StorageUnavailableError ? 503 : 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
      return;
    }

    const restTools: Record<string, string> = {
      "/api/devices": "alice_list_devices", "/api/say": "alice_say_phrase", "/api/command": "alice_send_command",
      "/api/volume": "alice_set_volume", "/api/media": "alice_media_control", "/api/scenarios/trigger": "alice_trigger_scenario",
    };
    async function getRestService(): Promise<StationService> {
      const auth = await authenticateRequest(req, stationService, quasarClient, oauthStorage, telemetryStorage, authRequired);
      if (!auth.authenticated) {
        if (auth.status === 401) res.setHeader("WWW-Authenticate", buildWwwAuthenticate(baseUrl, auth.error));
        throw Object.assign(new Error(auth.errorMessage), { statusCode: auth.status });
      }
      const tool = restTools[url.pathname];
      if (tool && !checkScope(tool, auth.scope)) {
        res.setHeader("WWW-Authenticate", buildWwwAuthenticate(baseUrl, "insufficient_scope") + `, scope="${TOOL_SCOPES[tool].join(" ")}"`);
        throw Object.assign(new Error("insufficient_scope"), { statusCode: 403 });
      }
      return auth.service;
    }
    // Reject unauthorized requests before reading their body. Each operation
    // revalidates after reading it, using this same hosted access policy.
    if (url.pathname.startsWith("/api/") && url.pathname !== "/api/info") {
      try { await getRestService(); } catch (error) {
        const err = error as Error & { statusCode?: number };
        res.writeHead(err.statusCode || 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message })); return;
      }
    }

    // REST API: List Devices
    if (url.pathname === "/api/devices" && req.method === "GET") {
      try {
        const onlySpeakers = url.searchParams.get("only_speakers") === "true";
        const svc = await getRestService();
        const result = await svc.listDevices(onlySpeakers);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", ...result }));
      } catch (err: any) {
        const status = err.statusCode || 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // REST API: Speak Phrase (TTS)
    if (url.pathname === "/api/say" && req.method === "POST") {
      try {
        const body = await parseRequestBody(req, { limit: MCP_BODY_LIMIT });
        const phrase = String(body?.phrase || "").trim();
        if (!phrase) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: "Parameter 'phrase' is required" }));
          return;
        }
        const svc = await getRestService();
        const result = await svc.sayPhrase(phrase, body.device);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...result }));
      } catch (err: any) {
        if (err instanceof PayloadTooLargeError) throw err;
        const status = err.statusCode || 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // REST API: Send Voice Command
    if (url.pathname === "/api/command" && req.method === "POST") {
      try {
        const body = await parseRequestBody(req, { limit: MCP_BODY_LIMIT });
        const command = String(body?.command || "").trim();
        if (!command) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: "Parameter 'command' is required" }));
          return;
        }
        const svc = await getRestService();
        const result = await svc.sendCommand(command, body.device);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...result }));
      } catch (err: any) {
        if (err instanceof PayloadTooLargeError) throw err;
        const status = err.statusCode || 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // REST API: Set Volume
    if (url.pathname === "/api/volume" && req.method === "POST") {
      try {
        const body = await parseRequestBody(req, { limit: MCP_BODY_LIMIT });
        const level = Number(body?.level);
        if (isNaN(level) || level < 1 || level > 10) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "error",
              message: "Parameter 'level' must be an integer between 1 and 10",
            })
          );
          return;
        }
        const svc = await getRestService();
        const result = await svc.setVolume(level, body.device);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...result }));
      } catch (err: any) {
        if (err instanceof PayloadTooLargeError) throw err;
        const status = err.statusCode || 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // REST API: Media Control
    if (url.pathname === "/api/media" && req.method === "POST") {
      try {
        const body = await parseRequestBody(req, { limit: MCP_BODY_LIMIT });
        const action = body?.action as any;
        if (!action || !["play", "pause", "stop", "next", "prev"].includes(action)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "error",
              message: "Parameter 'action' must be one of: play, pause, stop, next, prev",
            })
          );
          return;
        }
        const svc = await getRestService();
        const result = await svc.mediaControl(action, body.device);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...result }));
      } catch (err: any) {
        if (err instanceof PayloadTooLargeError) throw err;
        const status = err.statusCode || 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // REST API: Trigger Scenario
    if (url.pathname === "/api/scenarios/trigger" && req.method === "POST") {
      try {
        const body = await parseRequestBody(req, { limit: MCP_BODY_LIMIT });
        const scenario = String(body?.scenario || "").trim();
        if (!scenario) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: "Parameter 'scenario' is required" }));
          return;
        }
        const svc = await getRestService();
        const result = await svc.triggerScenario(scenario);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...result }));
      } catch (err: any) {
        if (err instanceof PayloadTooLargeError) throw err;
        const status = err.statusCode || 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // Public Informational & Legal Pages
    if (url.pathname === "/about" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderAuthPage({
          title: "mctl-alice — О сервисе",
          titleKey: "about_title",
          contentHtml: renderAboutPage(baseUrl),
        })
      );
      return;
    }

    if (url.pathname === "/privacy" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderAuthPage({
          title: "mctl-alice — Политика конфиденциальности",
          titleKey: "privacy_title",
          contentHtml: renderPrivacyPage(baseUrl),
        })
      );
      return;
    }

    if (url.pathname === "/terms" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderAuthPage({
          title: "mctl-alice — Условия использования",
          titleKey: "terms_title",
          contentHtml: renderTermsPage(baseUrl),
        })
      );
      return;
    }

    if (url.pathname === "/security" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderAuthPage({
          title: "mctl-alice — Безопасность",
          titleKey: "security_title",
          contentHtml: renderSecurityPage(baseUrl),
        })
      );
      return;
    }

    // Account Management Dashboard
    if (url.pathname === "/account" && req.method === "GET") {
      const user = await getSessionUser(req, oauthStorage);
      let creds = null;
      let credentialError = false;
      if (user) {
        try { creds = await oauthStorage.getUserCredentials(user.id); }
        catch (error) { if (!(error instanceof CredentialDecryptionError)) throw error; credentialError = true; }
      }
      const grants = user && oauthStorage.listUserGrants ? await oauthStorage.listUserGrants(user.id) : [];

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderAuthPage({
          title: "mctl-alice — Личный кабинет",
          titleKey: "account_title",
          contentHtml: (credentialError ? '<div class="alert alert-error">Saved credentials cannot be decrypted. <a href="/auth/login">Reconnect your Yandex account</a>.</div>' : '') + renderAccountPage({
            user,
            creds,
            grants,
            escapeHtml,
            baseUrl,
          }),
        })
      );
      return;
    }

    // "/account/delete-all" is what account pages rendered before 2.2.3 post to.
    // Deletes the proxy scenarios this user created in their Yandex account.
    // Returns false when that could not be done, so the caller can say so.
    const removeProxyScenarios = async (userId: string): Promise<boolean> => {
      let cookie: string | undefined;
      try { cookie = (await oauthStorage.getUserCredentials(userId))?.quasarCookie; }
      catch (error) { if (!(error instanceof CredentialDecryptionError)) throw error; }
      if (!cookie) return (await oauthStorage.listQuasarScenarios(userId)).length === 0;
      try {
        await new QuasarClient({ credentialsMode: authRequired ? "hosted" : "local", cookie, userId, storage: oauthStorage, useKeychain: false, persistEnv: false, signal: AbortSignal.timeout(options.cleanupDeadlineMs ?? CLEANUP_DEADLINE_MS) }).cleanupAllProxyScenarios();
        return true;
      } catch (error) {
        if (error instanceof StorageUnavailableError) throw error;
        console.warn(`[Account] Could not remove proxy scenarios for ${userId}:`, (error as Error).message);
        return false;
      }
    };

    if ((url.pathname === "/account/delete" || url.pathname === "/account/delete-all") && req.method === "POST") {
      const user = await getSessionUser(req, oauthStorage);
      let scenariosLeft = false;
      if (user) {
        scenariosLeft = !(await removeProxyScenarios(user.id));
        await telemetryStorage.forUser(user.id).deleteOwnerSamples();
        await oauthStorage.deleteUser(user.id);
        await closeSessions(user.id);
      }
      res.writeHead(302, {
        "Set-Cookie": clearSessionCookie,
        Location: scenariosLeft ? "/?deleted=true&scenarios_left=true" : "/?deleted=true",
      });
      res.end();
      return;
    }

    if (url.pathname === "/account/logout" && req.method === "POST") {
      const sessionId = parseCookies(req)["mctl_session"];
      if (sessionId) await oauthStorage.deleteWebSession(sessionId);
      res.writeHead(302, { "Set-Cookie": clearSessionCookie, Location: "/" });
      res.end();
      return;
    }

    if (url.pathname === "/account/disconnect-quasar" && req.method === "POST") {
      const user = await getSessionUser(req, oauthStorage);
      let scenariosLeft = false;
      if (user) {
        scenariosLeft = !(await removeProxyScenarios(user.id));
        let creds = null;
        try { creds = await oauthStorage.getUserCredentials(user.id); }
        catch (error) { if (!(error instanceof CredentialDecryptionError)) throw error; }
        if (creds) {
          await oauthStorage.saveUserCredentials(user.id, {
            ...creds,
            quasarCookie: undefined,
            quasarUpdatedAt: undefined,
          });
        }
        // On failure keep the recorded ids, so a later reconnect can still
        // find and remove the scenarios that were left behind.
        if (!scenariosLeft) await oauthStorage.deleteQuasarScenarios(user.id);
      }
      res.writeHead(302, { Location: scenariosLeft ? "/account?quasar_disconnected=true&scenarios_left=true" : "/account?quasar_disconnected=true" });
      res.end();
      return;
    }

    if (url.pathname === "/account/revoke-grant" && req.method === "POST") {
      const user = await getSessionUser(req, oauthStorage);
      const body = await parseRequestBody(req);
      const clientIdParam = body?.client_id;
      if (user && clientIdParam) {
        await oauthStorage.revokeUserGrant(user.id, clientIdParam);
        await closeSessions(user.id, clientIdParam);
      }
      res.writeHead(302, { Location: "/account?grant_revoked=true" });
      res.end();
      return;
    }

    // Auth login redirect
    if (url.pathname === "/auth/login") {
      const responseType = clientSecret ? "code" : "token";
      if (authRequired && !clientSecret) { res.writeHead(503); res.end("OAuth application not configured"); return; }
      // Every sign-in is a transaction bound to this browser, self-hosted
      // too: there the callback writes the server's own credentials, so a
      // page that sends the operator's browser to /auth/callback with its
      // own code or #access_token must not be able to complete one.
      const state = randomUUID();
      const browser = randomUUID();
      const requestedReturn = url.searchParams.get("return_to") || "/account";
      const returnTo = requestedReturn.startsWith("/oauth/authorize?") ? requestedReturn : "/account";
      await loginTransactions.set(state, { browser, expires: Date.now() + 600000, returnTo });
      res.setHeader("Set-Cookie", `mctl_login=${browser}; Path=/; ${baseUrl.startsWith("https:") ? "Secure; " : ""}HttpOnly; SameSite=Lax; Max-Age=600`);
      const oauthUrl = buildOAuthUrl(clientId, redirectUri, responseType, state);
      res.writeHead(302, { Location: oauthUrl });
      res.end();
      return;
    }

    // Auth callback HTML / Code exchange
    if (url.pathname === "/auth/callback") {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      let loginReturnTo: string | undefined;
      // Self-hosted, the implicit flow returns its state in the fragment, so
      // only a code is checked here; /auth/save-token checks the fragment's.
      if (authRequired || (code && !(state && await oauthStorage.getPendingAuth(state)))) {
        const transaction = await liveLoginTransaction(state, req);
        if (!transaction) {
          res.writeHead(400); res.end("Invalid login transaction; sign in again"); return;
        }
        await loginTransactions.delete(state!);
        loginReturnTo = transaction.returnTo;
      }
      const isPending = Boolean(state && await oauthStorage.getPendingAuth(state));

      if (state && await oauthStorage.getPendingAuth(state)) {
        try {
          const result = await oauthController.handleYandexCallback({
            code: code || undefined,
            state,
            error: error || undefined,
            error_description: url.searchParams.get("error_description") || undefined,
          });
          res.writeHead(302, { Location: result.redirectUrl });
          res.end();
          return;
        } catch (err: any) {
          res.writeHead(err instanceof StorageUnavailableError ? 503 : 500, { "Content-Type": "text/html; charset=utf-8" });
          const content = `
            <h2 data-i18n="callback_error_title">Ошибка авторизации Яндекс</h2>
            <div class="alert alert-error">❌ ${escapeHtml(err.message)}</div>
            <div class="s-4ef6bf">
              <a href="${baseUrl}/auth/login" class="btn btn-primary" data-i18n="callback_btn_retry">Попробовать снова</a>
              <a href="/" class="btn btn-secondary" data-i18n="callback_btn_home">На главную</a>
            </div>
          `;
          res.end(renderAuthPage({ title: "mctl-alice — Ошибка авторизации", titleKey: "callback_error_page_title", contentHtml: content }));
          return;
        }
      }

      if (code && clientSecret) {
        try {
          const tokens = await exchangeCodeForToken({
            code,
            clientId,
            clientSecret,
            redirectUri,
          });

          // Verify with Yandex API
          const client = new YandexIoTClient(tokens.access_token, {
            credentialsMode: authRequired ? "hosted" : "local",
            useKeychain: false,
            persistEnv: false,
            refreshToken: tokens.refresh_token,
            clientId,
            clientSecret,
          });
          const userService = new StationService(client, undefined, undefined, authRequired ? "hosted" : "local");
          const devices = await userService.listDevices(true);
          const speakerNames = devices.speakers.map((s) => `${s.name} (${s.room})`);

          // Single-user (local) mode only, like the token, QR and cookie
          // handlers: with AUTH_REQUIRED the credentials belong to one user
          // and are stored per user below, so they must not become the
          // process-wide default service or land in a shared .env file
          // (which is also read-only in the cluster).
          if (!authRequired) {
            stationService = userService;
            saveTokenToEnvFile(tokens.access_token);
            saveTokenToKeychain(tokens.access_token, "mctl-alice");

            if (tokens.refresh_token) {
              saveRefreshTokenToEnvFile(tokens.refresh_token);
              saveTokenToKeychain(tokens.refresh_token, "mctl-alice-refresh-token");
            }
          }

          let userId = "usr_local";
          try {
            const profile = await fetchYandexProfile(tokens.access_token, authRequired);
            userId = profile.id;
            await oauthStorage.saveUser({
              id: userId,
              yandexUid: profile.yandexUid,
              login: profile.login,
              displayName: profile.displayName,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          } catch {
            if (authRequired) throw new Error("Yandex profile verification failed; reconnect");
            await oauthStorage.saveUser({
              id: userId,
              yandexUid: "local_uid",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }

          // Only a newly verified Yandex login may replace unreadable credentials.
          try { await oauthStorage.getUserCredentials(userId); }
          catch (error) {
            if (!(error instanceof CredentialDecryptionError)) throw error;
            await oauthStorage.deleteUserCredentials(userId);
          }
          await oauthStorage.saveUserCredentials(userId, {
            yandexAccessToken: tokens.access_token,
            yandexRefreshToken: tokens.refresh_token,
            yandexExpiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
          });

          const webSessionId = randomUUID();
          await oauthStorage.saveWebSession(webSessionId, userId, Date.now() + 30 * 86400 * 1000);
          res.setHeader("Set-Cookie", `mctl_session=${webSessionId}; Path=/; HttpOnly; SameSite=Lax; ${authRequired ? "Secure; " : ""}Max-Age=2592000`);

          if (loginReturnTo) { res.writeHead(302, { Location: loginReturnTo }); res.end(); return; }
          const speakerHtml =
            speakerNames.length > 0
              ? `<div class="speakers s-c57e59"><strong data-i18n="callback_speakers_found">Найденные колонки:</strong><br>${speakerNames.map((s) => "• " + escapeHtml(s)).join("<br>")}</div>`
              : `<div class="speakers s-02b10e"><em data-i18n="callback_no_speakers">Колонки не найдены в умном доме, но токен успешно получен и сохранен.</em></div>`;

          const content = `
            <h2 data-i18n="callback_success_title">mctl-alice — Успешный вход</h2>
            <div class="alert alert-success" data-i18n="callback_success_msg">✅ Авторизация успешна! Получен постоянный Refresh-токен для автообновления.</div>
            ${speakerHtml}
            <div class="s-4ef6bf">
              <a href="/" class="btn btn-primary" data-i18n="callback_btn_home">На главную</a>
              <a href="/auth/cookie" class="btn btn-secondary" data-i18n="callback_btn_cookie">Настроить Quasar Cookie</a>
            </div>
          `;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderAuthPage({ title: "mctl-alice — Авторизация успешна", titleKey: "callback_success_page_title", contentHtml: content }));
          return;
        } catch (err: any) {
          res.writeHead(err instanceof StorageUnavailableError ? 503 : 500, { "Content-Type": "text/html; charset=utf-8" });
          const content = `
            <h2 data-i18n="callback_error_title">mctl-alice — Ошибка авторизации</h2>
            <div class="alert alert-error">❌ Ошибка обмена кода: ${escapeHtml(err.message)}</div>
            <div class="s-4ef6bf">
              <a href="${baseUrl}/auth/login" class="btn btn-primary" data-i18n="callback_btn_retry">Попробовать снова</a>
              <a href="/" class="btn btn-secondary" data-i18n="callback_btn_home">На главную</a>
            </div>
          `;
          res.end(renderAuthPage({ title: "mctl-alice — Ошибка", titleKey: "callback_error_page_title", contentHtml: content }));
          return;
        }
      }

      const content = `
        <h2 data-i18n="callback_success_title">mctl-alice — Успешный вход</h2>
        <div id="status" class="alert alert-info" data-i18n="callback_status_obtaining">Получение токена...</div>
        <div id="speakers" class="speakers s-fdd932"></div>
        <div class="s-ce02ff" id="actions">
          <a href="/" class="btn btn-primary" data-i18n="callback_btn_home">На главную</a>
          <a href="/auth/cookie" class="btn btn-secondary" data-i18n="callback_btn_cookie">Настроить Quasar Cookie</a>
        </div>
      `;
      const script = `<script src="/assets/auth-callback.js?v=${VERSION}"></script>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderAuthPage({ title: "mctl-alice — Авторизация", titleKey: "callback_success_page_title", contentHtml: content, scriptHtml: script }));
      return;

    }

    // Save token endpoint
    if (url.pathname === "/auth/save-token" && req.method === "POST") {
      const body = await readRequestBody(req, { limit: FORM_BODY_LIMIT });
      {
        try {
          const data = JSON.parse(body);
          const token = data.token?.trim();
          const refreshToken = data.refreshToken?.trim();
          if (!token) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "error", message: "Token missing" }));
            return;
          }
          // The token must come back through a sign-in this browser started:
          // the callback page posts the fragment's state alongside it.
          const state = typeof data.state === "string" ? data.state : undefined;
          if (!await liveLoginTransaction(state, req)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "error", message: "Invalid login transaction; sign in again" }));
            return;
          }
          await loginTransactions.delete(state!);

          // Verify with Yandex API
          const client = new YandexIoTClient(token, { credentialsMode: authRequired ? "hosted" : "local", useKeychain: false, persistEnv: false });
          const userService = new StationService(client, authRequired ? undefined : quasarClient, undefined, authRequired ? "hosted" : "local");
          const devices = await userService.listDevices(true);
          const speakerNames = devices.speakers.map((s) => `${s.name} (${s.room})`);

          if (!authRequired) {
            stationService = userService;
            saveTokenToEnvFile(token);
            saveTokenToKeychain(token, "mctl-alice");

            if (refreshToken) {
              saveRefreshTokenToEnvFile(refreshToken);
              saveTokenToKeychain(refreshToken, "mctl-alice-refresh-token");
            }
          }

          let userId = "usr_local";
          try {
            const profile = await fetchYandexProfile(token, authRequired);
            userId = profile.id;
            await oauthStorage.saveUser({
              id: userId,
              yandexUid: profile.yandexUid,
              login: profile.login,
              displayName: profile.displayName,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          } catch {
            if (authRequired) throw new Error("Yandex profile verification failed; reconnect");
            await oauthStorage.saveUser({
              id: userId,
              yandexUid: "local_uid",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }

          await oauthStorage.saveUserCredentials(userId, {
            yandexAccessToken: token,
            yandexRefreshToken: refreshToken,
            yandexExpiresAt: Date.now() + 30 * 86400 * 1000,
          });

          const webSessionId = randomUUID();
          await oauthStorage.saveWebSession(webSessionId, userId, Date.now() + 30 * 86400 * 1000);
          res.setHeader("Set-Cookie", `mctl_session=${webSessionId}; Path=/; HttpOnly; SameSite=Lax; ${authRequired ? "Secure; " : ""}Max-Age=2592000`);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", speakers: speakerNames }));
        } catch (err: any) {
          res.writeHead(err instanceof StorageUnavailableError ? 503 : upstreamStatus(err, 500), { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: err.message }));
        }
      }
      return;
    }

    // Quasar Cookie Setup Page
    if (url.pathname === "/auth/cookie" && req.method === "GET") {
      if (authRequired) {
        const user = await getSessionUser(req, oauthStorage);
        if (!user) {
          res.writeHead(302, { Location: "/auth/login" });
          res.end();
          return;
        }
      }

      const content = `
        <h2 data-i18n="cookie_title">mctl-alice — Настройка Quasar (Динамический голос и команды)</h2>
        <p class="s-fe289b" data-i18n-html="cookie_lead">
          Официальный IoT API Яндекса не позволяет произвольно воспроизводить текст (TTS) или выполнять динамические текстовые команды на колонках Алиса без заранее созданных вручную сценариев.<br>
          Quasar API подключается через веб-сессию Яндекса и разблокирует прямой синтез речи и произвольные команды на всех ваших колонках.
        </p>

        <div class="qr-card">
          <h3 class="s-49f975" data-i18n="cookie_qr_title">Быстрая настройка через QR-код (Рекомендуется)</h3>
          <p class="s-855e12" data-i18n="cookie_qr_desc">
            Отсканируйте QR-код камерой телефона или приложением Яндекс. Сессия будет настроена автоматически без ручного поиска кук.
          </p>
          <div class="qr-frame" id="qr-frame">
            <div class="qr-spinner" id="qr-spinner"></div>
          </div>
          <div id="qr-status" class="alert alert-info s-15aa3d" data-i18n="cookie_qr_waiting">
            Ожидание сканирования QR-кода...
          </div>
          <div class="s-8cb777">
            <a id="qr-mobile-btn" href="#" target="_blank" rel="noopener" class="btn btn-primary s-5790ff" data-i18n="cookie_qr_mobile_btn">Открыть в приложении Яндекс</a>
            <button id="qr-refresh-btn" type="button" class="btn btn-secondary s-5790ff" data-i18n="cookie_qr_refresh">Обновить QR-код</button>
            <a id="qr-home-btn" href="/" class="btn btn-primary s-5790ff" data-i18n="cookie_btn_home">Вернуться на главную</a>
          </div>
        </div>

        <details class="faq-item s-339f95">
          <summary class="s-81a067" data-i18n="cookie_manual_toggle">Или настроить вручную через DevTools...</summary>
          <div class="s-4c0544">
            <h4 class="s-49f975" data-i18n="cookie_instructions_title">Инструкция по настройке:</h4>
            <ol class="steps s-05854e">
              <li data-i18n-html="cookie_step1">Откройте <a href="https://yandex.ru/quasar" target="_blank" rel="noopener">yandex.ru/quasar</a> или <a href="https://yandex.ru" target="_blank" rel="noopener">yandex.ru</a> в браузере под вашим аккаунтом Яндекса.</li>
              <li data-i18n-html="cookie_step2">Откройте консоль разработчика DevTools (нажмите <code>F12</code> или <code>Cmd + Option + I</code> на Mac).</li>
              <li data-i18n-html="cookie_step3">Перейдите на вкладку <strong>Application</strong> (или <strong>Storage</strong>) → <strong>Cookies</strong> → <code>https://yandex.ru</code>.</li>
              <li data-i18n-html="cookie_step4">Найдите строку с куки <code>Session_id</code> и скопируйте её значение (или скопируйте всю строку заголовка Cookie).</li>
              <li data-i18n-html="cookie_step5">Вставьте в поле ввода ниже и нажмите <strong>Сохранить и проверить</strong>.</li>
            </ol>
            <div class="alert alert-warning s-5380fd">
              <strong>⚠️ Важно о приватности и хранении команд:</strong><br>
              <span data-i18n="cookie_scenario_disclosure">
                Воспроизведение произвольного текста (TTS) и выполнение голосовых команд через Quasar происходит путём создания сценариев в вашем умном доме Яндекс. Текст и параметры команды передаются на серверы Яндекса и сохраняются в истории сценариев вашего аккаунта. mctl-alice изолирует сценарии по пользователям и удаляет сценарий сразу после выполнения.
              </span>
              <div class="s-e5a6d3">
                <label class="s-d3ef24">
                  <input class="s-2d067f" type="checkbox" id="scenarioAckCheckbox" required>
                  <span data-i18n="cookie_scenario_ack">Я понимаю, что команды Quasar сохраняются в истории сценариев Яндекс</span>
                </label>
              </div>
            </div>
            <form class="s-4c0544" id="cookieForm">
              <label class="s-d81573" for="cookieInput" data-i18n="cookie_label">Значение Cookie (Session_id):</label>
              <textarea id="cookieInput" class="form-textarea" placeholder="Session_id=3:17... или значение Session_id" data-i18n-placeholder="cookie_placeholder" required spellcheck="false"></textarea>
              <div class="s-b12d12">
                <button type="submit" id="saveBtn" class="btn btn-primary" data-i18n="cookie_btn_save">Сохранить и проверить</button>
                <a href="/" class="btn btn-secondary" data-i18n="cookie_btn_home">Вернуться на главную</a>
              </div>
            </form>
            <div id="status" class="alert s-46936a"></div>
          </div>
        </details>
      `;

      const script = `<script src="/assets/auth-cookie.js?v=${VERSION}"></script>`;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderAuthPage({ title: "mctl-alice — Настройка Quasar Cookie", titleKey: "cookie_page_title", contentHtml: content, scriptHtml: script }));
      return;
    }

    // QR Code generation endpoint
    if (url.pathname === "/auth/qr-code" && req.method === "GET") {
      try {
        const user = await getSessionUser(req, oauthStorage);
        if (authRequired && !user) { res.writeHead(401); res.end("Sign in required"); return; }
        const qrData = await initQrAuth(authRequired ? oauthStorage : undefined);
        if (authRequired && user) await qrOwners.set(qrData.sessionId, { userId: user.id, browser: browserId(req), expires: Date.now() + 600000 });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", ...qrData }));
      } catch (err: any) {
        res.writeHead(err instanceof StorageUnavailableError ? 503 : upstreamStatus(err, 500), { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // QR Code status check endpoint
    if (url.pathname === "/auth/qr-status" && req.method === "GET") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: "sessionId missing" }));
        return;
      }
      try {
        if (authRequired) {
          const owner = await qrOwners.get(sessionId);
          const user = await getSessionUser(req, oauthStorage);
          if (!owner || owner.expires <= Date.now() || !user || user.id !== owner.userId || browserId(req) !== owner.browser) {
            res.writeHead(401); res.end("Invalid QR owner"); return;
          }
        }
        const result = await checkQrAuthStatus(sessionId, authRequired ? oauthStorage : undefined);
        if (result.status === "ok" && result.cookie) {
          const cookie = result.cookie;
          await qrOwners.delete(sessionId);

          const user = await getSessionUser(req, oauthStorage);
          if (authRequired) await assertCookieOwnedBy(cookie, user);
          if (user) {
            const existingCreds = (await oauthStorage.getUserCredentials(user.id)) || { yandexAccessToken: "" };
            await oauthStorage.saveUserCredentials(user.id, {
              ...existingCreds,
              quasarCookie: cookie,
              quasarUpdatedAt: Date.now(),
            });
          }

          if (!authRequired) {
            saveCookieToEnvFile(cookie);
            saveCookieToKeychain(cookie);

            quasarClient = new QuasarClient({ cookie, useKeychain: true, persistEnv: true, userId: user?.id, storage: oauthStorage });
            stationService = new StationService(undefined, quasarClient);
          }
        }
        const { cookie: _unused, ...safeResult } = result;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(safeResult));
      } catch (err: any) {
        res.writeHead(err instanceof StorageUnavailableError ? 503 : err instanceof CookieAccountMismatchError ? 403 : upstreamStatus(err, 500), { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // Save Quasar Cookie Endpoint
    if (url.pathname === "/auth/save-cookie" && req.method === "POST") {
      const body = await readRequestBody(req, { limit: FORM_BODY_LIMIT });
      {
        try {
          const user = await getSessionUser(req, oauthStorage);
          if (authRequired && !user) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "error", message: "Unauthorized: Web session required" }));
            return;
          }

          const data = JSON.parse(body);
          const cookie = data.cookie?.trim();
          if (!cookie) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "error", message: "Cookie missing" }));
            return;
          }

          // Test verification with Quasar
          const testQuasar = new QuasarClient({ credentialsMode: authRequired ? "hosted" : "local", cookie, useKeychain: false, persistEnv: false, userId: user?.id, storage: oauthStorage });
          await testQuasar.getCsrfToken();
          if (authRequired) await assertCookieOwnedBy(cookie, user);

          if (!authRequired) {
            saveCookieToEnvFile(cookie);
            saveCookieToKeychain(cookie);

            quasarClient = new QuasarClient({ credentialsMode: authRequired ? "hosted" : "local", cookie, useKeychain: false, persistEnv: false, userId: user?.id, storage: oauthStorage });
            stationService = new StationService(undefined, quasarClient);
          }

          if (user) {
            const existingCreds = (await oauthStorage.getUserCredentials(user.id)) || { yandexAccessToken: "" };
            await oauthStorage.saveUserCredentials(user.id, {
              ...existingCreds,
              quasarCookie: cookie,
              quasarUpdatedAt: Date.now(),
            });
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", message: "Cookie saved and verified successfully" }));
        } catch (err: any) {
          res.writeHead(err instanceof StorageUnavailableError ? 503 : err instanceof CookieAccountMismatchError ? 403 : upstreamStatus(err, 500), { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: err.message }));
        }
      }
      return;
    }

    // Web Landing Page
    if (url.pathname === "/" && req.method === "GET") {
      const accept = req.headers.accept || "";
      const prefersJson = accept.includes("application/json") && !accept.includes("text/html");
      if (!prefersJson) {
        const served = serveStaticFile("index.html", res);
        if (served) return;
      }
    }

    // Default info (JSON) for root / or /api/info
    if (url.pathname === "/" || url.pathname === "/api/info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          service: "mctl-alice",
          description: "Yandex Alice Smart Speaker MCP & REST Server for ChatGPT",
          version: VERSION,
          endpoints: {
            openapi: "/openapi.json",
            sse: "/sse",
            messages: "/messages",
            mcp: "/mcp",
            healthz: "/healthz",
            oauth_prm: "/.well-known/oauth-protected-resource",
            oauth_asm: "/.well-known/oauth-authorization-server",
            auth: "/auth/login",
            auth_cookie: "/auth/cookie",
            api: {
              devices: "GET /api/devices",
              say: "POST /api/say",
              command: "POST /api/command",
              volume: "POST /api/volume",
              media: "POST /api/media",
              triggerScenario: "POST /api/scenarios/trigger",
            },
          },
        })
      );
      return;
    }

    // 404 Not Found for any unmatched route
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", message: "Route not found" }));
    } catch (err) {
      if (err instanceof PayloadTooLargeError) { sendPayloadTooLarge(res); return; }
      if (err instanceof UpstreamTimeoutError || err instanceof UpstreamError) {
        if (!res.headersSent) { res.writeHead(err.statusCode, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "upstream_error", message: err.message })); }
        else res.end();
        return;
      }
      if (!res.headersSent) { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "temporarily_unavailable" })); }
      else res.end();
    }
  });

  server.on("close", () => {
    for (const transport of sseTransports.values()) void transport.close();
    if (sampler) sampler.stop();
    if (!options.storage) void telemetryStorage.close();
  });

  return server;
}
