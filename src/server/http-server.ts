import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ALICE_TOOLS } from "../tools/definitions.js";
import { handleToolCall } from "../tools/handlers.js";
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
import { OAuthController } from "../auth/oauth-controller.js";
import { initQrAuth, checkQrAuthStatus } from "../auth/yandex-qr-auth.js";
import { fetchYandexProfile } from "../auth/oauth-helper.js";
import { renderAboutPage, renderPrivacyPage, renderTermsPage, renderSecurityPage } from "./pages.js";
import { renderAccountPage } from "./account-page.js";
import { UserRecord } from "../storage/storage-interface.js";

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
        const content = fs.readFileSync(indexPath);
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
    const content = fs.readFileSync(filePath);

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

function parseRequestBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      const contentType = req.headers["content-type"] || "";
      if (contentType.includes("application/x-www-form-urlencoded")) {
        try {
          const params = new URLSearchParams(body);
          return resolve(Object.fromEntries(params.entries()));
        } catch {
          return reject(new Error("Invalid form-urlencoded body"));
        }
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        try {
          const params = new URLSearchParams(body);
          if (Array.from(params.keys()).length > 0) {
            return resolve(Object.fromEntries(params.entries()));
          }
        } catch {
          // ignore
        }
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const parseJsonBody = parseRequestBody;

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
<script>
try {
  var t = localStorage.getItem("alice-theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  var l = localStorage.getItem("alice-lang");
  if (l === "ru" || l === "en") document.documentElement.setAttribute("lang", l);
} catch(e) {}
</script>
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/assets/tokens.css?v=2.0.0">
<link rel="stylesheet" href="/assets/components.css?v=2.0.0">
</head>
<body>
<header class="wrap topbar">
  <a class="brand" href="/">
    <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent)"/>
      <path d="M16 8v16M11 11v10M21 11v10M6 14v4M26 14v4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="color: var(--accent)"/>
    </svg>
    mctl-alice
    <span class="chip-beta">BETA</span>
  </a>
  <nav class="topbar-links">
    <a href="/" data-i18n="nav_home">Главная</a>
    <a href="/account">Аккаунт</a>
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
      <a href="/account">Личный кабинет</a> ·
      <a href="/about">О сервисе</a> ·
      <a href="/privacy">Конфиденциальность</a> ·
      <a href="/terms">Условия</a> ·
      <a href="/security">Безопасность</a> ·
      <a href="https://github.com/mctlhq/mctl-alice" target="_blank" rel="noopener" data-i18n="nav_github">GitHub</a>
    </span>
  </div>
</footer>
<script src="/assets/site.js?v=2.0.0"></script>
${scriptHtml}
</body>
</html>`;
}

function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
}

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
  if (!session?.userId) return null;
  return storage.getUser(session.userId);
}


export interface AuthResult {
  authenticated: boolean;
  service?: StationService;
  error?: "invalid_token" | "invalid_request";
  errorMessage?: string;
  userId?: string;
  scope?: string;
}

export function buildWwwAuthenticate(baseUrl: string, error?: "invalid_token" | "invalid_request"): string {
  const metadataUrl = `${baseUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource/mcp`;
  let challenge = `Bearer realm="mctl-alice", resource_metadata="${metadataUrl}"`;
  if (error) {
    challenge += `, error="${error}"`;
  }
  return challenge;
}

export function authenticateRequest(
  req: http.IncomingMessage,
  defaultService: StationService,
  defaultQuasar?: QuasarClient,
  oauthStorage?: IStorage,
  telemetryStorage?: ITelemetryStorage,
  authRequired = false
): AuthResult {
  const authHeader = req.headers.authorization;
  const cookieHeader = req.headers["x-yandex-cookie"] as string | undefined;

  let customQuasar = defaultQuasar;
  if (cookieHeader) {
    customQuasar = new QuasarClient({ cookie: cookieHeader, useKeychain: false, persistEnv: false });
  }

  if (authHeader) {
    if (!authHeader.startsWith("Bearer ") && !authHeader.startsWith("bearer ")) {
      return { authenticated: false, error: "invalid_request", errorMessage: "Bearer scheme required" };
    }
    const rawToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!rawToken) {
      return { authenticated: false, error: "invalid_request", errorMessage: "Token is empty" };
    }

    // 1. Check if rawToken is an issued OAuth Bearer token in oauthStorage
    if (oauthStorage) {
      const tokenRecord = oauthStorage.getToken(rawToken) as any;
      if (tokenRecord) {
        if (tokenRecord.expiresAt && tokenRecord.expiresAt < Date.now()) {
          return { authenticated: false, error: "invalid_token", errorMessage: "The access token has expired" };
        }
        try {
          let client: YandexIoTClient | null = null;
          let userQuasar: QuasarClient | undefined = undefined;

          if (tokenRecord.userId) {
            const creds = oauthStorage.getUserCredentials(tokenRecord.userId) as any;
            if (creds?.yandexAccessToken) {
              client = new YandexIoTClient(creds.yandexAccessToken, {
                useKeychain: false,
                persistEnv: false,
                refreshToken: creds.yandexRefreshToken,
              });
            }
            if (creds?.quasarCookie) {
              userQuasar = new QuasarClient({
                cookie: creds.quasarCookie,
                useKeychain: false,
                persistEnv: false,
                userId: tokenRecord.userId,
              });
            }
          }

          if (!client && tokenRecord.yandexAccessToken) {
            client = new YandexIoTClient(tokenRecord.yandexAccessToken, {
              useKeychain: false,
              persistEnv: false,
              refreshToken: tokenRecord.yandexRefreshToken,
            });
          }

          if (!client && !authRequired) {
            try {
              client = new YandexIoTClient(undefined, { useKeychain: false, persistEnv: false });
            } catch {
              client = null;
            }
          }

          return {
            authenticated: true,
            service: new StationService(client || undefined, userQuasar || customQuasar, telemetryStorage),
            userId: tokenRecord.userId,
            scope: tokenRecord.scope,
          };
        } catch (err: any) {
          return { authenticated: false, error: "invalid_token", errorMessage: err.message };
        }
      }
    }

    // Direct token fallbacks ONLY allowed when authRequired is false
    if (!authRequired) {
      if (process.env.YANDEX_OAUTH_TOKEN && rawToken === process.env.YANDEX_OAUTH_TOKEN) {
        return { authenticated: true, service: defaultService, scope: "*" };
      }

      const isDirectYandexToken =
        rawToken.startsWith("y0_") || rawToken.startsWith("y1_") || rawToken.startsWith("AQAAAA");
      if (isDirectYandexToken) {
        try {
          const client = new YandexIoTClient(rawToken, { useKeychain: false, persistEnv: false });
          return {
            authenticated: true,
            service: new StationService(client, customQuasar, telemetryStorage),
            scope: "*",
          };
        } catch {
          return { authenticated: false, error: "invalid_token", errorMessage: "Invalid access token" };
        }
      }
    }

    return { authenticated: false, error: "invalid_token", errorMessage: "Invalid access token" };
  }

  if (cookieHeader && customQuasar && customQuasar !== defaultQuasar) {
    return {
      authenticated: true,
      service: new StationService(undefined, customQuasar, telemetryStorage),
    };
  }

  if (authRequired) {
    return { authenticated: false, errorMessage: "authentication required" };
  }

  return { authenticated: true, service: defaultService };
}

export function getAuthenticatedService(
  req: http.IncomingMessage,
  defaultService: StationService,
  defaultQuasar?: QuasarClient,
  oauthStorage?: IStorage,
  telemetryStorage?: ITelemetryStorage
): StationService {
  const auth = authenticateRequest(req, defaultService, defaultQuasar, oauthStorage, telemetryStorage, false);
  return auth.service || defaultService;
}

const getServiceForRequest = getAuthenticatedService;

export function createMcpServer(
  service: StationService | (() => StationService),
  scope?: string
): Server {
  const getService = typeof service === "function" ? service : () => service;
  const server = new Server(
    {
      name: "mctl-alice",
      version: "2.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ALICE_TOOLS,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, args, getService(), scope);
  });

  return server;
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
}

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

  const oauthStorage = options.oauthStorage || createStorage();
  const oauthController = new OAuthController({
    baseUrl,
    yandexClientId: clientId,
    yandexClientSecret: clientSecret,
    storage: oauthStorage,
    yandexCallbackUri,
  });

  let quasarClient = new QuasarClient();
  let stationService = new StationService(undefined, quasarClient, options.storage);

  let sampler: TelemetrySampler | null = null;
  if (options.enableSampler !== false) {
    try {
      sampler = new TelemetrySampler(stationService, stationService.getStorage());
      sampler.start();
    } catch (err: any) {
      console.warn(`⚠️ [mctl-alice] Telemetry sampler initialization skipped: ${err.message}`);
    }
  }

  // Keep track of active legacy SSE transports
  const sseTransports = new Map<string, SSEServerTransport>();

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
          serverInfo: { name: "mctl-alice", version: "2.0.0" },
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
        result: { tools: ALICE_TOOLS },
      };
    }

    if (method === "tools/call") {
      const { name, arguments: args } = rpcReq.params || {};
      try {
        const activeSvc = svc || (await getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage));
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
    const url = new URL(req.url || "/", baseUrl);

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Expose-Headers", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check for Kubernetes probes
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "mctl-alice", version: "2.0.0" }));
      return;
    }

    console.log(`[HTTP] ${req.method} ${url.pathname}${url.search}`);

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
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "invalid_request", error_description: err.message }));
      }
      return;
    }

    // OAuth: Authorize Endpoint (GET: Consent screen or auto-approve redirect)
    if (url.pathname === "/oauth/authorize" && req.method === "GET") {
      const sessionIdParam = url.searchParams.get("session_id");
      const actionParam = url.searchParams.get("action");

      // Direct approval / denial via GET query params if session_id is present
      if (sessionIdParam && actionParam) {
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
              <p style="color: var(--surface-fg-muted);">${escapeHtml(err.message)}</p>
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
      console.log(`[OAuth] /oauth/authorize client_id=${clientId}, redirect_uri=${redirectUri}, state=${state}`);

      const result = await oauthController.handleAuthorize({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: url.searchParams.get("response_type") || undefined,
        state: state || undefined,
        code_challenge: url.searchParams.get("code_challenge") || undefined,
        code_challenge_method: url.searchParams.get("code_challenge_method") || undefined,
        scope: url.searchParams.get("scope") || undefined,
        auto_approve: autoApprove,
        prompt,
      });

      if ("error" in result) {
        console.warn(`[OAuth] /oauth/authorize rejected: error=${result.error}, desc=${result.description}`);
        res.writeHead(result.status || 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: result.error, error_description: result.description }));
        return;
      }

      if (result.type === "redirect") {
        console.log(`[OAuth] /oauth/authorize auto-approved, redirecting: ${result.redirectUrl}`);
        res.writeHead(302, { Location: result.redirectUrl });
        res.end();
        return;
      }

      // Render Consent Page
      const clientName = escapeHtml(result.clientName);
      const safeClientId = escapeHtml(result.clientId);
      const safeRedirectUri = escapeHtml(result.redirectUri);
      const sessionId = escapeHtml(result.sessionId);

      const content = `
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="display: inline-flex; align-items: center; justify-content: center; width: 56px; height: 56px; border-radius: 50%; background: var(--surface-elevated); border: 1px solid var(--surface-line-strong); margin-bottom: 16px;">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent);">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <h2 style="margin: 0 0 8px 0;" data-i18n="oauth_consent_title">Авторизация приложения</h2>
          <p style="color: var(--surface-fg-muted); margin: 0; font-size: 15px;" data-i18n="oauth_consent_lead">Приложение запрашивает доступ к вашему серверу Alice MCP</p>
        </div>

        <div class="card" style="background: var(--surface-elevated); border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md); padding: 18px; margin-bottom: 20px;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
            <span style="font-size: 13px; color: var(--surface-fg-muted);" data-i18n="oauth_app_name">Приложение:</span>
            <span style="font-weight: 600; font-size: 15px; color: var(--surface-fg);">${clientName}</span>
          </div>
          <div style="font-size: 12px; color: var(--surface-fg-muted); word-break: break-all; margin-bottom: 6px;">
            <span style="font-family: var(--font-mono);">${safeClientId}</span>
          </div>
          <div style="font-size: 12px; color: var(--surface-fg-muted); word-break: break-all;">
            <span data-i18n="oauth_redirect_uri">Redirect URI:</span> <span style="font-family: var(--font-mono);">${safeRedirectUri}</span>
          </div>
        </div>

        <div style="margin-bottom: 24px;">
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;" data-i18n="oauth_scopes_title">Запрашиваемые права доступа:</div>
          <ul style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px;">
            <li style="display: flex; align-items: flex-start; gap: 10px; font-size: 14px;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #22c55e; flex-shrink: 0; margin-top: 2px;">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <div>
                <strong style="font-family: var(--font-mono); font-size: 13px;">iot:view</strong>
                <div style="color: var(--surface-fg-muted); font-size: 13px;" data-i18n="oauth_scope_view">Просмотр списка комнат, устройств, датчиков и их состояния</div>
              </div>
            </li>
            <li style="display: flex; align-items: flex-start; gap: 10px; font-size: 14px;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color: #22c55e; flex-shrink: 0; margin-top: 2px;">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <div>
                <strong style="font-family: var(--font-mono); font-size: 13px;">iot:control</strong>
                <div style="color: var(--surface-fg-muted); font-size: 13px;" data-i18n="oauth_scope_control">Управление устройствами, симуляция голосовых команд и воспроизведение речи</div>
              </div>
            </li>
          </ul>
        </div>

        <div class="alert alert-info" style="margin-bottom: 24px; font-size: 13px;">
          <span data-i18n="oauth_status_connected">Подключение к умному дому Яндекс Алисы активно.</span>
        </div>

        <form method="POST" action="/oauth/authorize" style="display: flex; gap: 12px; justify-content: flex-end;">
          <input type="hidden" name="session_id" value="${sessionId}">
          <button type="submit" name="action" value="deny" class="btn btn-secondary" style="flex: 1;" data-i18n="oauth_btn_deny">Отклонить</button>
          <button type="submit" name="action" value="approve" class="btn btn-primary" style="flex: 2;" data-i18n="oauth_btn_approve">Разрешить доступ</button>
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
        console.log(`[OAuth] /oauth/authorize POST action=${action}, session_id=${sessionId}`);

        if (!sessionId) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "invalid_request", error_description: "session_id is required" }));
          return;
        }

        if (action === "deny") {
          const result = await oauthController.denyAuthorization(sessionId);
          console.log(`[OAuth] /oauth/authorize denied, redirecting: ${result.redirectUrl}`);
          res.writeHead(302, { Location: result.redirectUrl });
          res.end();
          return;
        }

        const user = await getSessionUser(req, oauthStorage);
        const result = await oauthController.approveAuthorization(sessionId, user?.id);
        console.log(`[OAuth] /oauth/authorize approved, redirecting: ${result.redirectUrl}`);
        res.writeHead(302, { Location: result.redirectUrl });
        res.end();
        return;
      } catch (err: any) {
        console.error(`[OAuth] /oauth/authorize POST error: ${err.message}`);
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderAuthPage({
          title: "mctl-alice — Ошибка сессии",
          contentHtml: `
            <h2>Сессия авторизации не найдена или истекла</h2>
            <p style="color: var(--surface-fg-muted);">${escapeHtml(err.message)}</p>
            <p><a href="/" class="btn btn-secondary">Вернуться на главную</a></p>
          `,
        }));
        return;
      }
    }

    // OAuth: Yandex Callback Endpoint
    if (url.pathname === "/oauth/yandex/callback" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      console.log(`[OAuth] /oauth/yandex/callback code=${code ? "present" : "missing"}, state=${state}, error=${error || "none"}`);

      try {
        const result = await oauthController.handleYandexCallback({
          code: code || undefined,
          state: state || undefined,
          error: error || undefined,
          error_description: errorDescription || undefined,
        });
        console.log(`[OAuth] /oauth/yandex/callback success, redirecting to: ${result.redirectUrl}`);
        res.writeHead(302, { Location: result.redirectUrl });
        res.end();
      } catch (err: any) {
        console.error(`[OAuth] /oauth/yandex/callback failed: ${err.message}`);
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"><title>OAuth Error</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 40px; max-width: 600px; margin: auto;">
  <h2 style="color: #0f172a;">Ошибка авторизации Яндекс</h2>
  <p style="color: #dc2626;">${err.message}</p>
  <p><a href="${baseUrl}/auth/login" style="color: #2563eb;">Попробовать снова</a></p>
</body>
</html>`);
      }
      return;
    }

    // OAuth: Token Endpoint (Authorization Code + PKCE & Refresh Token)
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      try {
        const body = await parseRequestBody(req);
        console.log(`[OAuth] /oauth/token grant_type=${body?.grant_type}, client_id=${body?.client_id}`);
        const tokens = await oauthController.handleToken(body);
        console.log(`[OAuth] /oauth/token issued tokens successfully`);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          Pragma: "no-cache",
        });
        res.end(JSON.stringify(tokens));
      } catch (err: any) {
        console.error(`[OAuth] /oauth/token error: ${err.message}`);
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: err.message }));
      }
      return;
    }

    // OAuth: Revocation Endpoint (RFC 7009 - Disconnect in ChatGPT)
    if (url.pathname === "/oauth/revoke" && req.method === "POST") {
      try {
        const body = await parseRequestBody(req);
        const token = body?.token || url.searchParams.get("token") || "";
        console.log(`[OAuth] /oauth/revoke token=${token ? "present" : "missing"}`);
        await oauthController.handleRevoke(token);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "ok" }));
      } catch (err: any) {
        console.error(`[OAuth] /oauth/revoke error: ${err.message}`);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "ok" }));
      }
      return;
    }

    // Helper to send 401 Unauthorized with RFC 9728 WWW-Authenticate
    const sendUnauthorized = (authError?: "invalid_token" | "invalid_request", message = "authentication required") => {
      res.writeHead(401, {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": buildWwwAuthenticate(baseUrl, authError),
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
      req.method === "POST";

    if (isMcpPost) {
      const auth = await authenticateRequest(req, stationService, quasarClient, oauthStorage, options.storage, authRequired);
      if (!auth.authenticated) {
        sendUnauthorized(auth.error, auth.errorMessage);
        return;
      }
      const activeSvc = auth.service || stationService;

      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          if (!body.trim()) {
            sendMcpResponse(req, res, null, 204);
            return;
          }
          const rpcData = JSON.parse(body);
          if (Array.isArray(rpcData)) {
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
      });
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
      const auth = await authenticateRequest(req, stationService, quasarClient, oauthStorage, options.storage, authRequired);
      if (!auth.authenticated) {
        sendUnauthorized(auth.error, auth.errorMessage);
        return;
      }

      try {
        const svc = auth.service || stationService;
        const transport = new SSEServerTransport("/messages", res);
        const sessionId = transport.sessionId;
        sseTransports.set(sessionId, transport);

        transport.onclose = () => {
          sseTransports.delete(sessionId);
        };

        const mcpServer = createMcpServer(svc, auth.scope);
        await mcpServer.connect(transport);
      } catch (err: any) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: err.message }));
        }
      }
      return;
    }

    // Standard HTTP GET /mcp (not SSE, e.g. RFC 9728 discovery probe, ping, or client info check)
    if (url.pathname === "/mcp" && req.method === "GET") {
      const auth = await authenticateRequest(req, stationService, quasarClient, oauthStorage, options.storage, authRequired);
      if (!auth.authenticated) {
        sendUnauthorized(auth.error, auth.errorMessage);
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
      try {
        await transport.handlePostMessage(req, res);
      } catch (err: any) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
      return;
    }

    // REST API auth gate (when authRequired is true)
    if (url.pathname.startsWith("/api/") && url.pathname !== "/api/info") {
      const auth = await authenticateRequest(req, stationService, quasarClient, oauthStorage, options.storage, authRequired);
      if (!auth.authenticated) {
        sendUnauthorized(auth.error, auth.errorMessage);
        return;
      }
    }

    // REST API: List Devices
    if (url.pathname === "/api/devices" && req.method === "GET") {
      try {
        const onlySpeakers = url.searchParams.get("only_speakers") === "true";
        const svc = await getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage);
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
        const body = await parseJsonBody(req);
        const phrase = String(body?.phrase || "").trim();
        if (!phrase) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: "Parameter 'phrase' is required" }));
          return;
        }
        const svc = await getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage);
        const result = await svc.sayPhrase(phrase, body.device);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...result }));
      } catch (err: any) {
        const status = err.statusCode || 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // REST API: Send Voice Command
    if (url.pathname === "/api/command" && req.method === "POST") {
      try {
        const body = await parseJsonBody(req);
        const command = String(body?.command || "").trim();
        if (!command) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: "Parameter 'command' is required" }));
          return;
        }
        const svc = await getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage);
        const result = await svc.sendCommand(command, body.device);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...result }));
      } catch (err: any) {
        const status = err.statusCode || 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // REST API: Set Volume
    if (url.pathname === "/api/volume" && req.method === "POST") {
      try {
        const body = await parseJsonBody(req);
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
        const svc = await getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage);
        const result = await svc.setVolume(level, body.device);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...result }));
      } catch (err: any) {
        const status = err.statusCode || 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // REST API: Media Control
    if (url.pathname === "/api/media" && req.method === "POST") {
      try {
        const body = await parseJsonBody(req);
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
        const svc = await getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage);
        const result = await svc.mediaControl(action, body.device);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...result }));
      } catch (err: any) {
        const status = err.statusCode || 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // REST API: Trigger Scenario
    if (url.pathname === "/api/scenarios/trigger" && req.method === "POST") {
      try {
        const body = await parseJsonBody(req);
        const scenario = String(body?.scenario || "").trim();
        if (!scenario) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: "Parameter 'scenario' is required" }));
          return;
        }
        const svc = await getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage);
        const result = await svc.triggerScenario(scenario);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...result }));
      } catch (err: any) {
        const status = err.statusCode || 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // Public Informational & Legal Pages
    if (url.pathname === "/about" && req.method === "GET") {
      setSecurityHeaders(res);
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
      setSecurityHeaders(res);
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
      setSecurityHeaders(res);
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
      setSecurityHeaders(res);
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
      setSecurityHeaders(res);
      const user = await getSessionUser(req, oauthStorage);
      const creds = user ? await oauthStorage.getUserCredentials(user.id) : null;
      const grants =
        user && (oauthStorage as any).listUserGrants
          ? await (oauthStorage as any).listUserGrants(user.id)
          : [];

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderAuthPage({
          title: "mctl-alice — Личный кабинет",
          titleKey: "account_title",
          contentHtml: renderAccountPage({
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

    if (url.pathname === "/account/delete" && req.method === "POST") {
      setSecurityHeaders(res);
      const user = await getSessionUser(req, oauthStorage);
      if (user) {
        await oauthStorage.deleteUser(user.id);
      }
      res.writeHead(302, {
        "Set-Cookie": "mctl_session=; Path=/; HttpOnly; Max-Age=0",
        Location: "/?deleted=true",
      });
      res.end();
      return;
    }

    if (url.pathname === "/account/disconnect-quasar" && req.method === "POST") {
      setSecurityHeaders(res);
      const user = await getSessionUser(req, oauthStorage);
      if (user) {
        const creds = await oauthStorage.getUserCredentials(user.id);
        if (creds) {
          await oauthStorage.saveUserCredentials(user.id, {
            ...creds,
            quasarCookie: undefined,
            quasarUpdatedAt: undefined,
          });
        }
        await oauthStorage.deleteQuasarScenarios(user.id);
      }
      res.writeHead(302, { Location: "/account?quasar_disconnected=true" });
      res.end();
      return;
    }

    if (url.pathname === "/account/revoke-grant" && req.method === "POST") {
      setSecurityHeaders(res);
      const user = await getSessionUser(req, oauthStorage);
      const body = await parseRequestBody(req);
      const clientIdParam = body?.client_id;
      if (user && clientIdParam && (oauthStorage as any).deleteUserClientTokens) {
        await (oauthStorage as any).deleteUserClientTokens(user.id, clientIdParam);
      }
      res.writeHead(302, { Location: "/account?grant_revoked=true" });
      res.end();
      return;
    }

    // Auth login redirect
    if (url.pathname === "/auth/login") {
      const responseType = clientSecret ? "code" : "token";
      const oauthUrl = buildOAuthUrl(clientId, redirectUri, responseType);
      res.writeHead(302, { Location: oauthUrl });
      res.end();
      return;
    }

    // Auth callback HTML / Code exchange
    if (url.pathname === "/auth/callback") {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const isPending = Boolean(state && oauthStorage.getPendingAuth(state));
      console.log(`[OAuth] /auth/callback received: code=${code ? "present" : "missing"}, state=${state}, error=${error || "none"}, isPending=${isPending}`);

      if (state && oauthStorage.getPendingAuth(state)) {
        try {
          const result = await oauthController.handleYandexCallback({
            code: code || undefined,
            state,
            error: error || undefined,
            error_description: url.searchParams.get("error_description") || undefined,
          });
          console.log(`[OAuth] /auth/callback (pending) redirected to: ${result.redirectUrl}`);
          res.writeHead(302, { Location: result.redirectUrl });
          res.end();
          return;
        } catch (err: any) {
          console.error(`[OAuth] /auth/callback (pending) failed: ${err.message}`);
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          const content = `
            <h2 data-i18n="callback_error_title">Ошибка авторизации Яндекс</h2>
            <div class="alert alert-error">❌ ${escapeHtml(err.message)}</div>
            <div style="margin-top: 24px; display: flex; gap: 12px; flex-wrap: wrap;">
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
            useKeychain: false,
            persistEnv: false,
            refreshToken: tokens.refresh_token,
            clientId,
            clientSecret,
          });
          stationService = new StationService(client);
          const devices = await stationService.listDevices(true);
          const speakerNames = devices.speakers.map((s) => `${s.name} (${s.room})`);

          saveTokenToEnvFile(tokens.access_token);
          saveTokenToKeychain(tokens.access_token, "mctl-alice");

          if (tokens.refresh_token) {
            saveRefreshTokenToEnvFile(tokens.refresh_token);
            saveTokenToKeychain(tokens.refresh_token, "mctl-alice-refresh-token");
          }

          let userId = "usr_local";
          try {
            const profile = await fetchYandexProfile(tokens.access_token);
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
            await oauthStorage.saveUser({
              id: userId,
              yandexUid: "local_uid",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }

          await oauthStorage.saveUserCredentials(userId, {
            yandexAccessToken: tokens.access_token,
            yandexRefreshToken: tokens.refresh_token,
            yandexExpiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
          });

          const webSessionId = randomUUID();
          await oauthStorage.saveWebSession(webSessionId, userId, Date.now() + 30 * 86400 * 1000);
          res.setHeader("Set-Cookie", `mctl_session=${webSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);

          const speakerHtml =
            speakerNames.length > 0
              ? `<div class="speakers" style="margin-top: 16px; padding: 14px 16px; background: var(--surface-elevated); border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);"><strong data-i18n="callback_speakers_found">Найденные колонки:</strong><br>${speakerNames.map((s) => "• " + escapeHtml(s)).join("<br>")}</div>`
              : `<div class="speakers" style="margin-top: 16px; padding: 14px 16px; background: var(--surface-elevated); border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md); color: var(--surface-fg-muted);"><em data-i18n="callback_no_speakers">Колонки не найдены в умном доме, но токен успешно получен и сохранен.</em></div>`;

          const content = `
            <h2 data-i18n="callback_success_title">mctl-alice — Успешный вход</h2>
            <div class="alert alert-success" data-i18n="callback_success_msg">✅ Авторизация успешна! Получен постоянный Refresh-токен для автообновления.</div>
            ${speakerHtml}
            <div style="margin-top: 24px; display: flex; gap: 12px; flex-wrap: wrap;">
              <a href="/" class="btn btn-primary" data-i18n="callback_btn_home">На главную</a>
              <a href="/auth/cookie" class="btn btn-secondary" data-i18n="callback_btn_cookie">Настроить Quasar Cookie</a>
            </div>
          `;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderAuthPage({ title: "mctl-alice — Авторизация успешна", titleKey: "callback_success_page_title", contentHtml: content }));
          return;
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          const content = `
            <h2 data-i18n="callback_error_title">mctl-alice — Ошибка авторизации</h2>
            <div class="alert alert-error">❌ Ошибка обмена кода: ${escapeHtml(err.message)}</div>
            <div style="margin-top: 24px; display: flex; gap: 12px; flex-wrap: wrap;">
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
        <div id="speakers" class="speakers" style="display:none; margin-top: 16px; padding: 14px 16px; background: var(--surface-elevated); border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);"></div>
        <div id="actions" style="margin-top: 24px; display: none; gap: 12px; flex-wrap: wrap;">
          <a href="/" class="btn btn-primary" data-i18n="callback_btn_home">На главную</a>
          <a href="/auth/cookie" class="btn btn-secondary" data-i18n="callback_btn_cookie">Настроить Quasar Cookie</a>
        </div>
      `;
      const script = `
      <script>
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        const token = params.get('access_token');
        const statusEl = document.getElementById('status');
        const speakersEl = document.getElementById('speakers');
        const actionsEl = document.getElementById('actions');

        function getI18nText(key, fallback) {
          const lang = document.documentElement.getAttribute('lang') || 'ru';
          if (window.mctlAliceTranslations && window.mctlAliceTranslations[lang] && window.mctlAliceTranslations[lang][key]) {
            return window.mctlAliceTranslations[lang][key];
          }
          return fallback;
        }

        if (token) {
          statusEl.innerText = getI18nText('callback_status_connecting', 'Токен получен. Подключение к колонкам...');
          fetch('/auth/save-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
          })
          .then(res => res.json())
          .then(data => {
            if (data.status === 'ok') {
              statusEl.className = 'alert alert-success';
              statusEl.innerText = getI18nText('callback_status_connected', '✅ Успешно! Умный дом подключен к mctl-alice.');
              actionsEl.style.display = 'flex';
              if (data.speakers && data.speakers.length > 0) {
                speakersEl.style.display = 'block';
                const prefix = getI18nText('callback_speakers_found', 'Найденные колонки:');
                speakersEl.innerHTML = '<strong>' + prefix + '</strong><br>' + data.speakers.map(s => '• ' + s).join('<br>');
              }
            } else {
              statusEl.className = 'alert alert-error';
              const lang = document.documentElement.getAttribute('lang') || 'ru';
              const errPrefix = lang === 'en' ? '❌ Verification error: ' : '❌ Ошибка проверки: ';
              const unknownErr = lang === 'en' ? 'unknown error' : 'неизвестная ошибка';
              statusEl.innerText = errPrefix + (data.message || unknownErr);
            }
          })
          .catch(err => {
            const lang = document.documentElement.getAttribute('lang') || 'ru';
            const errPrefix = lang === 'en' ? '❌ Error: ' : '❌ Ошибка: ';
            statusEl.className = 'alert alert-error';
            statusEl.innerText = errPrefix + err.message;
          });
        } else {
          statusEl.className = 'alert alert-error';
          statusEl.innerText = getI18nText('callback_status_token_missing', '❌ Токен не найден в URL редиректа.');
        }
      </script>
      `;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderAuthPage({ title: "mctl-alice — Авторизация", titleKey: "callback_success_page_title", contentHtml: content, scriptHtml: script }));
      return;

    }

    // Save token endpoint
    if (url.pathname === "/auth/save-token" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          const token = data.token?.trim();
          const refreshToken = data.refreshToken?.trim();
          if (!token) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "error", message: "Token missing" }));
            return;
          }

          // Verify with Yandex API
          const client = new YandexIoTClient(token, { useKeychain: false, persistEnv: false });
          stationService = new StationService(client, quasarClient);
          const devices = await stationService.listDevices(true);
          const speakerNames = devices.speakers.map((s) => `${s.name} (${s.room})`);

          if (!authRequired) {
            saveTokenToEnvFile(token);
            saveTokenToKeychain(token, "mctl-alice");

            if (refreshToken) {
              saveRefreshTokenToEnvFile(refreshToken);
              saveTokenToKeychain(refreshToken, "mctl-alice-refresh-token");
            }
          }

          let userId = "usr_local";
          try {
            const profile = await fetchYandexProfile(token);
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
          res.setHeader("Set-Cookie", `mctl_session=${webSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", speakers: speakerNames }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: err.message }));
        }
      });
      return;
    }

    // Quasar Cookie Setup Page
    if (url.pathname === "/auth/cookie" && req.method === "GET") {
      setSecurityHeaders(res);
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
        <p style="color: var(--surface-fg-muted); margin-bottom: 24px;" data-i18n-html="cookie_lead">
          Официальный IoT API Яндекса не позволяет произвольно воспроизводить текст (TTS) или выполнять динамические текстовые команды на колонках Алиса без заранее созданных вручную сценариев.<br>
          Quasar API подключается через веб-сессию Яндекса и разблокирует прямой синтез речи и произвольные команды на всех ваших колонках.
        </p>

        <div class="qr-card">
          <h3 style="margin: 0 0 8px;" data-i18n="cookie_qr_title">Быстрая настройка через QR-код (Рекомендуется)</h3>
          <p style="color: var(--surface-fg-muted); margin: 0 0 16px; max-width: 540px; font-size: 14px;" data-i18n="cookie_qr_desc">
            Отсканируйте QR-код камерой телефона или приложением Яндекс. Сессия будет настроена автоматически без ручного поиска кук.
          </p>
          <div class="qr-frame" id="qr-frame">
            <div class="qr-spinner" id="qr-spinner"></div>
          </div>
          <div id="qr-status" class="alert alert-info" style="margin-top: 12px; max-width: 480px; width: 100%;" data-i18n="cookie_qr_waiting">
            Ожидание сканирования QR-кода...
          </div>
          <div style="display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; justify-content: center;">
            <a id="qr-mobile-btn" href="#" target="_blank" rel="noopener" class="btn btn-primary" style="display: none;" data-i18n="cookie_qr_mobile_btn">Открыть в приложении Яндекс</a>
            <button id="qr-refresh-btn" type="button" class="btn btn-secondary" style="display: none;" data-i18n="cookie_qr_refresh">Обновить QR-код</button>
            <a id="qr-home-btn" href="/" class="btn btn-primary" style="display: none;" data-i18n="cookie_btn_home">Вернуться на главную</a>
          </div>
        </div>

        <details class="faq-item" style="margin-top: 24px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md); padding: 14px 18px;">
          <summary style="font-weight: 500; cursor: pointer;" data-i18n="cookie_manual_toggle">Или настроить вручную через DevTools...</summary>
          <div style="margin-top: 16px;">
            <h4 style="margin: 0 0 8px;" data-i18n="cookie_instructions_title">Инструкция по настройке:</h4>
            <ol class="steps" style="font-size: 14px;">
              <li data-i18n-html="cookie_step1">Откройте <a href="https://yandex.ru/quasar" target="_blank" rel="noopener">yandex.ru/quasar</a> или <a href="https://yandex.ru" target="_blank" rel="noopener">yandex.ru</a> в браузере под вашим аккаунтом Яндекса.</li>
              <li data-i18n-html="cookie_step2">Откройте консоль разработчика DevTools (нажмите <code>F12</code> или <code>Cmd + Option + I</code> на Mac).</li>
              <li data-i18n-html="cookie_step3">Перейдите на вкладку <strong>Application</strong> (или <strong>Storage</strong>) → <strong>Cookies</strong> → <code>https://yandex.ru</code>.</li>
              <li data-i18n-html="cookie_step4">Найдите строку с куки <code>Session_id</code> и скопируйте её значение (или скопируйте всю строку заголовка Cookie).</li>
              <li data-i18n-html="cookie_step5">Вставьте в поле ввода ниже и нажмите <strong>Сохранить и проверить</strong>.</li>
            </ol>
            <div class="alert alert-warning" style="margin-top: 14px; margin-bottom: 14px; font-size: 13px; border-left: 4px solid #f59e0b; background: rgba(245, 158, 11, 0.08); padding: 12px 14px; border-radius: var(--mctl-radius-sm);">
              <strong>⚠️ Важно о приватности и хранении команд:</strong><br>
              <span data-i18n="cookie_scenario_disclosure">
                Воспроизведение произвольного текста (TTS) и выполнение голосовых команд через Quasar происходит путём создания сценариев в вашем умном доме Яндекс. Текст и параметры команды передаются на серверы Яндекса и сохраняются в истории сценариев вашего аккаунта. mctl-alice изолирует сценарии по пользователям и удаляет сценарий сразу после выполнения.
              </span>
              <div style="margin-top: 10px;">
                <label style="display: flex; align-items: center; gap: 8px; font-weight: 500; cursor: pointer; user-select: none;">
                  <input type="checkbox" id="scenarioAckCheckbox" required style="width: 16px; height: 16px; cursor: pointer;">
                  <span data-i18n="cookie_scenario_ack">Я понимаю, что команды Quasar сохраняются в истории сценариев Яндекс</span>
                </label>
              </div>
            </div>
            <form id="cookieForm" style="margin-top: 16px;">
              <label for="cookieInput" style="display: block; font-weight: 500; font-size: 14px; margin-bottom: 6px;" data-i18n="cookie_label">Значение Cookie (Session_id):</label>
              <textarea id="cookieInput" class="form-textarea" placeholder="Session_id=3:17... или значение Session_id" data-i18n-placeholder="cookie_placeholder" required spellcheck="false"></textarea>
              <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-top: 12px;">
                <button type="submit" id="saveBtn" class="btn btn-primary" data-i18n="cookie_btn_save">Сохранить и проверить</button>
                <a href="/" class="btn btn-secondary" data-i18n="cookie_btn_home">Вернуться на главную</a>
              </div>
            </form>
            <div id="status" class="alert" style="display: none; margin-top: 12px;"></div>
          </div>
        </details>
      `;

      const script = `
      <script>
        // QR Code Flow
        const qrFrame = document.getElementById('qr-frame');
        const qrStatus = document.getElementById('qr-status');
        const qrMobileBtn = document.getElementById('qr-mobile-btn');
        const qrRefreshBtn = document.getElementById('qr-refresh-btn');
        const qrHomeBtn = document.getElementById('qr-home-btn');

        let pollTimer = null;
        let currentSessionId = null;

        function getI18nMsg(key, fallback) {
          const lang = document.documentElement.getAttribute('lang') || 'ru';
          if (window.mctlAliceTranslations && window.mctlAliceTranslations[lang] && window.mctlAliceTranslations[lang][key]) {
            return window.mctlAliceTranslations[lang][key];
          }
          return fallback;
        }

        async function loadQrCode() {
          if (pollTimer) clearInterval(pollTimer);
          qrFrame.innerHTML = '<div class="qr-spinner"></div>';
          qrStatus.className = 'alert alert-info';
          qrStatus.innerText = getI18nMsg('cookie_qr_waiting', 'Ожидание сканирования QR-кода...');
          qrMobileBtn.style.display = 'none';
          qrRefreshBtn.style.display = 'none';
          qrHomeBtn.style.display = 'none';

          try {
            const res = await fetch('/auth/qr-code');
            const data = await res.json();
            if (data.status === 'ok' && data.qrSvg) {
              qrFrame.innerHTML = data.qrSvg;
              currentSessionId = data.sessionId;
              if (data.link) {
                qrMobileBtn.href = data.link;
                qrMobileBtn.style.display = 'inline-flex';
              }
              qrRefreshBtn.style.display = 'inline-flex';
              startPolling(data.sessionId);
            } else {
              qrFrame.innerHTML = '<div style="color: var(--surface-fg-muted); padding: 20px;">❌</div>';
              qrStatus.className = 'alert alert-error';
              qrStatus.innerText = (data.message || 'Ошибка загрузки QR-кода');
              qrRefreshBtn.style.display = 'inline-flex';
            }
          } catch (err) {
            qrFrame.innerHTML = '<div style="color: var(--surface-fg-muted); padding: 20px;">❌</div>';
            qrStatus.className = 'alert alert-error';
            qrStatus.innerText = 'Ошибка сети: ' + err.message;
            qrRefreshBtn.style.display = 'inline-flex';
          }
        }

        function startPolling(sessionId) {
          pollTimer = setInterval(async () => {
            try {
              const res = await fetch('/auth/qr-status?sessionId=' + encodeURIComponent(sessionId));
              const data = await res.json();
              if (data.status === 'ok') {
                clearInterval(pollTimer);
                qrStatus.className = 'alert alert-success';
                qrStatus.innerText = getI18nMsg('cookie_qr_success', '✅ Авторизация успешна! Quasar Cookie настроены автоматически.');
                qrMobileBtn.style.display = 'none';
                qrRefreshBtn.style.display = 'none';
                qrHomeBtn.style.display = 'inline-flex';
              } else if (data.status === 'expired') {
                clearInterval(pollTimer);
                qrStatus.className = 'alert alert-error';
                qrStatus.innerText = getI18nMsg('cookie_qr_expired', 'Срок действия QR-кода истёк. Нажмите «Обновить QR-код».');
                qrRefreshBtn.style.display = 'inline-flex';
              } else if (data.status === 'error') {
                clearInterval(pollTimer);
                qrStatus.className = 'alert alert-error';
                qrStatus.innerText = '❌ ' + (data.message || 'Ошибка авторизации');
                qrRefreshBtn.style.display = 'inline-flex';
              }
            } catch (e) {
              // network hiccup, retry next tick
            }
          }, 2000);
        }

        qrRefreshBtn.addEventListener('click', loadQrCode);
        loadQrCode();

        // Manual Form Flow
        const form = document.getElementById('cookieForm');
        const input = document.getElementById('cookieInput');
        const statusEl = document.getElementById('status');
        const btn = document.getElementById('saveBtn');

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const cookie = input.value.trim();
          if (!cookie) return;

          btn.disabled = true;
          statusEl.style.display = 'block';
          statusEl.className = 'alert alert-info';
          const lang = document.documentElement.getAttribute('lang') || 'ru';
          statusEl.innerText = lang === 'en' ? 'Verifying session with Yandex Quasar...' : 'Проверка сессии в Yandex Quasar...';

          try {
            const res = await fetch('/auth/save-cookie', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cookie })
            });
            const data = await res.json();
            const currentLang = document.documentElement.getAttribute('lang') || 'ru';
            if (res.ok && data.status === 'ok') {
              statusEl.className = 'alert alert-success';
              statusEl.innerText = currentLang === 'en'
                ? '✅ Cookie verified and saved successfully! Dynamic TTS and voice text commands are now available.'
                : '✅ Куки успешно проверены и сохранены! Теперь доступны динамический TTS (произвольный текст) и текстовые голосовые команды.';
            } else {
              statusEl.className = 'alert alert-error';
              const errMsg = data.message || (currentLang === 'en' ? 'failed to obtain CSRF token' : 'не удалось получить CSRF токен');
              statusEl.innerText = (currentLang === 'en' ? '❌ Cookie verification error: ' : '❌ Ошибка проверки куки: ') + errMsg;
            }
          } catch (err) {
            const currentLang = document.documentElement.getAttribute('lang') || 'ru';
            statusEl.className = 'alert alert-error';
            statusEl.innerText = (currentLang === 'en' ? '❌ Network error: ' : '❌ Ошибка сети: ') + err.message;
          } finally {
            btn.disabled = false;
          }
        });
      </script>
      `;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderAuthPage({ title: "mctl-alice — Настройка Quasar Cookie", titleKey: "cookie_page_title", contentHtml: content, scriptHtml: script }));
      return;
    }

    // QR Code generation endpoint
    if (url.pathname === "/auth/qr-code" && req.method === "GET") {
      try {
        const qrData = await initQrAuth();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", ...qrData }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
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
        const result = await checkQrAuthStatus(sessionId);
        if (result.status === "ok" && result.cookie) {
          const cookie = result.cookie;

          const user = await getSessionUser(req, oauthStorage);
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // Save Quasar Cookie Endpoint
    if (url.pathname === "/auth/save-cookie" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
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
          const testQuasar = new QuasarClient({ cookie, useKeychain: false, persistEnv: false, userId: user?.id, storage: oauthStorage });
          await testQuasar.getCsrfToken();

          if (!authRequired) {
            saveCookieToEnvFile(cookie);
            saveCookieToKeychain(cookie);

            quasarClient = new QuasarClient({ cookie, useKeychain: false, persistEnv: false, userId: user?.id, storage: oauthStorage });
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
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: err.message }));
        }
      });
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
          version: "1.8.0",
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
  });

  server.on("close", () => {
    if (sampler) sampler.stop();
  });

  return server;
}
