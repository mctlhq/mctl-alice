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
import { TelemetryStorage } from "../storage/telemetry-storage.js";
import { TelemetrySampler } from "../services/telemetry-sampler.js";
import { OAuthStorage } from "../storage/oauth-storage.js";
import { OAuthController } from "../auth/oauth-controller.js";

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
          "Cache-Control": "public, max-age=300",
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
      "Cache-Control": "public, max-age=300",
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
  contentHtml,
  scriptHtml = "",
}: {
  title: string;
  contentHtml: string;
  scriptHtml?: string;
}): string {
  return `<!doctype html>
<html lang="ru">
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/components.css">
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
    <a href="/">Главная</a>
    <a href="/auth/login">Вход (OAuth)</a>
    <a href="/auth/cookie">Quasar Cookie</a>
    <a href="https://github.com/mctlhq/mctl-alice" target="_blank" rel="noopener">GitHub</a>
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
    <span>mctl-alice — часть платформы <a href="https://mctl.ai" target="_blank" rel="noopener">mctl</a>.</span>
    <span>
      <a href="/">Главная</a> ·
      <a href="/auth/login">Вход (OAuth)</a> ·
      <a href="/auth/cookie">Quasar Cookie</a> ·
      <a href="https://github.com/mctlhq/mctl-alice" target="_blank" rel="noopener">GitHub</a>
    </span>
  </div>
</footer>
<script src="/assets/site.js"></script>
${scriptHtml}
</body>
</html>`;
}


function getServiceForRequest(
  req: http.IncomingMessage,
  defaultService: StationService,
  defaultQuasar?: QuasarClient,
  oauthStorage?: OAuthStorage,
  telemetryStorage?: TelemetryStorage
): StationService {
  const authHeader = req.headers.authorization;
  const cookieHeader = req.headers["x-yandex-cookie"] as string | undefined;

  let customQuasar = defaultQuasar;
  if (cookieHeader) {
    customQuasar = new QuasarClient({ cookie: cookieHeader, useKeychain: false, persistEnv: false });
  }

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const rawToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (rawToken) {
      // 1. Check if rawToken is an issued OAuth Bearer token in oauthStorage
      if (oauthStorage) {
        const tokenRecord = oauthStorage.getToken(rawToken);
        if (tokenRecord) {
          try {
            const client = new YandexIoTClient(tokenRecord.yandexAccessToken, {
              useKeychain: false,
              persistEnv: false,
              refreshToken: tokenRecord.yandexRefreshToken,
            });
            return new StationService(client, customQuasar, telemetryStorage);
          } catch {
            // fall through
          }
        }
      }

      // 2. Direct Yandex OAuth token fallback
      try {
        const client = new YandexIoTClient(rawToken, { useKeychain: false, persistEnv: false });
        return new StationService(client, customQuasar, telemetryStorage);
      } catch {
        // Fallback to default service
      }
    }
  }

  if (customQuasar && customQuasar !== defaultQuasar) {
    return new StationService(undefined, customQuasar, telemetryStorage);
  }

  return defaultService;
}

export function createMcpServer(service: StationService | (() => StationService)): Server {
  const getService = typeof service === "function" ? service : () => service;
  const server = new Server(
    {
      name: "mctl-alice",
      version: "1.8.0",
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
    return handleToolCall(name, args, getService());
  });

  return server;
}

export function createHttpServer(
  port = 8080,
  options: {
    clientId?: string;
    clientSecret?: string;
    publicBaseUrl?: string;
    storage?: TelemetryStorage;
    enableSampler?: boolean;
    oauthStorage?: OAuthStorage;
    yandexCallbackUri?: string;
  } = {}
): http.Server {
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

  const oauthStorage = options.oauthStorage || new OAuthStorage();
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

  async function handleSingleRpc(rpcReq: any, req: http.IncomingMessage): Promise<any | null> {
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
          serverInfo: { name: "mctl-alice", version: "1.8.0" },
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
        const svc = getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage);
        const result = await handleToolCall(name, args, svc);
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
      res.end(JSON.stringify({ status: "ok", service: "mctl-alice", version: "1.8.0" }));
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
        const clientInfo = oauthController.registerClient(body);
        res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(clientInfo));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "invalid_request", error_description: err.message }));
      }
      return;
    }

    // OAuth: Authorize Endpoint
    if (url.pathname === "/oauth/authorize" && req.method === "GET") {
      const clientId = url.searchParams.get("client_id") || "";
      const redirectUri = url.searchParams.get("redirect_uri") || "";
      const state = url.searchParams.get("state") || "";
      console.log(`[OAuth] /oauth/authorize client_id=${clientId}, redirect_uri=${redirectUri}, state=${state}`);

      const result = await oauthController.handleAuthorize({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: url.searchParams.get("response_type") || undefined,
        state: state || undefined,
        code_challenge: url.searchParams.get("code_challenge") || undefined,
        code_challenge_method: url.searchParams.get("code_challenge_method") || undefined,
        scope: url.searchParams.get("scope") || undefined,
      });

      if ("error" in result) {
        console.warn(`[OAuth] /oauth/authorize rejected: error=${result.error}, desc=${result.description}`);
        res.writeHead(result.status || 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: result.error, error_description: result.description }));
        return;
      }

      console.log(`[OAuth] /oauth/authorize redirecting user to Yandex: ${result.redirectUrl}`);
      res.writeHead(302, { Location: result.redirectUrl });
      res.end();
      return;
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
        oauthController.handleRevoke(token);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "ok" }));
      } catch (err: any) {
        console.error(`[OAuth] /oauth/revoke error: ${err.message}`);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "ok" }));
      }
      return;
    }

    // Pure Stateless MCP JSON-RPC endpoint (for ChatGPT Connectors, Claude, Streamable HTTP & direct JSON-RPC)
    const isMcpPost =
      (url.pathname === "/mcp" ||
        url.pathname === "/" ||
        url.pathname === "/sse" ||
        url.pathname === "/mcp/sse") &&
      req.method === "POST";

    if (isMcpPost) {
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
              const resItem = await handleSingleRpc(item, req);
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
            const result = await handleSingleRpc(rpcData, req);
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
    const isSseRequest =
      (url.pathname === "/sse" ||
        url.pathname === "/mcp/sse" ||
        url.pathname === "/mcp" ||
        (url.pathname === "/" && req.headers.accept?.includes("text/event-stream"))) &&
      req.method === "GET";

    if (isSseRequest) {
      try {
        const svc = getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage);
        const transport = new SSEServerTransport("/messages", res);
        const sessionId = transport.sessionId;
        sseTransports.set(sessionId, transport);

        transport.onclose = () => {
          sseTransports.delete(sessionId);
        };

        const mcpServer = createMcpServer(svc);
        await mcpServer.connect(transport);
      } catch (err: any) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: err.message }));
        }
      }
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

    // REST API: List Devices
    if (url.pathname === "/api/devices" && req.method === "GET") {
      try {
        const onlySpeakers = url.searchParams.get("only_speakers") === "true";
        const svc = getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage);
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
        const svc = getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage);
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
        const svc = getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage);
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
        const svc = getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage);
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
        const svc = getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage);
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
        const svc = getServiceForRequest(req, stationService, quasarClient, oauthStorage, options.storage);
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
            <h2>Ошибка авторизации Яндекс</h2>
            <div class="alert alert-error">❌ ${escapeHtml(err.message)}</div>
            <div style="margin-top: 24px; display: flex; gap: 12px; flex-wrap: wrap;">
              <a href="${baseUrl}/auth/login" class="btn btn-primary">Попробовать снова</a>
              <a href="/" class="btn btn-secondary">На главную</a>
            </div>
          `;
          res.end(renderAuthPage({ title: "mctl-alice — Ошибка авторизации", contentHtml: content }));
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

          const speakerHtml =
            speakerNames.length > 0
              ? `<div class="speakers" style="margin-top: 16px; padding: 14px 16px; background: var(--surface-elevated); border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);"><strong>Найденные колонки:</strong><br>${speakerNames.map((s) => "• " + escapeHtml(s)).join("<br>")}</div>`
              : `<div class="speakers" style="margin-top: 16px; padding: 14px 16px; background: var(--surface-elevated); border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md); color: var(--surface-fg-muted);"><em>Колонки не найдены в умном доме, но токен успешно получен и сохранен.</em></div>`;

          const content = `
            <h2>mctl-alice — Успешный вход</h2>
            <div class="alert alert-success">✅ Авторизация успешна! Получен постоянный Refresh-токен для автообновления.</div>
            ${speakerHtml}
            <div style="margin-top: 24px; display: flex; gap: 12px; flex-wrap: wrap;">
              <a href="/" class="btn btn-primary">На главную</a>
              <a href="/auth/cookie" class="btn btn-secondary">Настроить Quasar Cookie</a>
            </div>
          `;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderAuthPage({ title: "mctl-alice — Авторизация успешна", contentHtml: content }));
          return;
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          const content = `
            <h2>mctl-alice — Ошибка авторизации</h2>
            <div class="alert alert-error">❌ Ошибка обмена кода: ${escapeHtml(err.message)}</div>
            <div style="margin-top: 24px; display: flex; gap: 12px; flex-wrap: wrap;">
              <a href="${baseUrl}/auth/login" class="btn btn-primary">Попробовать снова</a>
              <a href="/" class="btn btn-secondary">На главную</a>
            </div>
          `;
          res.end(renderAuthPage({ title: "mctl-alice — Ошибка", contentHtml: content }));
          return;
        }
      }

      const content = `
        <h2>mctl-alice — Успешный вход</h2>
        <div id="status" class="alert alert-info">Получение токена...</div>
        <div id="speakers" class="speakers" style="display:none; margin-top: 16px; padding: 14px 16px; background: var(--surface-elevated); border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);"></div>
        <div id="actions" style="margin-top: 24px; display: none; gap: 12px; flex-wrap: wrap;">
          <a href="/" class="btn btn-primary">На главную</a>
          <a href="/auth/cookie" class="btn btn-secondary">Настроить Quasar Cookie</a>
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

        if (token) {
          statusEl.innerText = 'Токен получен. Подключение к колонкам...';
          fetch('/auth/save-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
          })
          .then(res => res.json())
          .then(data => {
            if (data.status === 'ok') {
              statusEl.className = 'alert alert-success';
              statusEl.innerText = '✅ Успешно! Умный дом подключен к mctl-alice.';
              actionsEl.style.display = 'flex';
              if (data.speakers && data.speakers.length > 0) {
                speakersEl.style.display = 'block';
                speakersEl.innerHTML = '<strong>Найденные колонки:</strong><br>' + data.speakers.map(s => '• ' + s).join('<br>');
              }
            } else {
              statusEl.className = 'alert alert-error';
              statusEl.innerText = '❌ Ошибка проверки: ' + (data.message || 'неизвестная ошибка');
            }
          })
          .catch(err => {
            statusEl.className = 'alert alert-error';
            statusEl.innerText = '❌ Ошибка: ' + err.message;
          });
        } else {
          statusEl.className = 'alert alert-error';
          statusEl.innerText = '❌ Токен не найден в URL редиректа.';
        }
      </script>
      `;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderAuthPage({ title: "mctl-alice — Авторизация", contentHtml: content, scriptHtml: script }));
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

          saveTokenToEnvFile(token);
          saveTokenToKeychain(token, "mctl-alice");

          if (refreshToken) {
            saveRefreshTokenToEnvFile(refreshToken);
            saveTokenToKeychain(refreshToken, "mctl-alice-refresh-token");
          }

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
      const content = `
        <h2>mctl-alice — Настройка Quasar (Динамический голос и команды)</h2>
        <p style="color: var(--surface-fg-muted); margin-bottom: 24px;">
          Официальный IoT API Яндекса не позволяет произвольно воспроизводить текст (TTS) или выполнять динамические текстовые команды на колонках Алиса без заранее созданных вручную сценариев.<br>
          Quasar API подключается через веб-сессию Яндекса и разблокирует прямой синтез речи и произвольные команды на всех ваших колонках.
        </p>
        <h3 style="margin-top: 24px; margin-bottom: 12px;">Инструкция по настройке:</h3>
        <ol class="steps">
          <li>Откройте <a href="https://yandex.ru/quasar" target="_blank" rel="noopener">yandex.ru/quasar</a> или <a href="https://yandex.ru" target="_blank" rel="noopener">yandex.ru</a> в браузере под вашим аккаунтом Яндекса.</li>
          <li>Откройте консоль разработчика DevTools (нажмите <code>F12</code> или <code>Cmd + Option + I</code> на Mac).</li>
          <li>Перейдите на вкладку <strong>Application</strong> (или <strong>Storage</strong>) → <strong>Cookies</strong> → <code>https://yandex.ru</code>.</li>
          <li>Найдите строку с куки <code>Session_id</code> и скопируйте её значение (или скопируйте всю строку заголовка Cookie).</li>
          <li>Вставьте в поле ввода ниже и нажмите <strong>Сохранить и проверить</strong>.</li>
        </ol>
        <form id="cookieForm" style="margin-top: 20px;">
          <label for="cookieInput" style="display: block; font-weight: 500; font-size: 14px; margin-bottom: 6px;">Значение Cookie (Session_id):</label>
          <textarea id="cookieInput" class="form-textarea" placeholder="Session_id=3:17... или значение Session_id" required spellcheck="false"></textarea>
          <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
            <button type="submit" id="saveBtn" class="btn btn-primary">Сохранить и проверить</button>
            <a href="/" class="btn btn-secondary">Вернуться на главную</a>
          </div>
        </form>
        <div id="status" class="alert" style="display: none;"></div>
      `;

      const script = `
      <script>
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
          statusEl.innerText = 'Проверка сессии в Yandex Quasar...';

          try {
            const res = await fetch('/auth/save-cookie', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cookie })
            });
            const data = await res.json();
            if (res.ok && data.status === 'ok') {
              statusEl.className = 'alert alert-success';
              statusEl.innerText = '✅ Куки успешно проверены и сохранены! Теперь доступны динамический TTS (произвольный текст) и текстовые голосовые команды.';
            } else {
              statusEl.className = 'alert alert-error';
              statusEl.innerText = '❌ Ошибка проверки куки: ' + (data.message || 'не удалось получить CSRF токен');
            }
          } catch (err) {
            statusEl.className = 'alert alert-error';
            statusEl.innerText = '❌ Ошибка сети: ' + err.message;
          } finally {
            btn.disabled = false;
          }
        });
      </script>
      `;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderAuthPage({ title: "mctl-alice — Настройка Quasar Cookie", contentHtml: content, scriptHtml: script }));
      return;
    }


    // Save Quasar Cookie Endpoint
    if (url.pathname === "/auth/save-cookie" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          const cookie = data.cookie?.trim();
          if (!cookie) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "error", message: "Cookie missing" }));
            return;
          }

          // Test verification with Quasar
          const testQuasar = new QuasarClient({ cookie, useKeychain: false, persistEnv: false });
          await testQuasar.getCsrfToken();

          saveCookieToEnvFile(cookie);
          saveCookieToKeychain(cookie);

          quasarClient = new QuasarClient();
          stationService = new StationService(undefined, quasarClient);

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
