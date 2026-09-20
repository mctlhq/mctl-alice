import http from "node:http";
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
      version: "1.7.4",
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
          serverInfo: { name: "mctl-alice", version: "1.7.4" },
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
      res.end(JSON.stringify({ status: "ok", service: "mctl-alice", version: "1.7.4" }));
      return;
    }

    console.log(`[HTTP] ${req.method} ${url.pathname}${url.search}`);

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
          res.end(`<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"><title>OAuth Error</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 40px; max-width: 600px; margin: auto;">
  <h2 style="color: #0f172a;">Ошибка авторизации Яндекс</h2>
  <p style="color: #dc2626;">${err.message}</p>
  <p><a href="${baseUrl}/auth/login" style="color: #2563eb;">Попробовать снова</a></p>
</body>
</html>`);
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
              ? `<div class="speakers"><strong>Найденные колонки:</strong><br>${speakerNames.map((s) => "• " + s).join("<br>")}</div>`
              : `<div class="speakers"><em>Колонки не найдены в умном доме, но токен успешно получен и сохранен.</em></div>`;

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>mctl-alice — Авторизация успешна</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; line-height: 1.6; }
    .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; }
    h2 { margin-top: 0; color: #0f172a; }
    .status { font-size: 18px; margin: 16px 0; color: #16a34a; }
    .speakers { background: #ffffff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>mctl-alice — Успешный вход</h2>
    <div class="status">✅ Авторизация успешна! Получен постоянный Refresh-токен для автообновления.</div>
    ${speakerHtml}
  </div>
</body>
</html>`);
          return;
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>mctl-alice — Ошибка</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; line-height: 1.6; }
    .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; }
    h2 { margin-top: 0; color: #0f172a; }
    .error { font-size: 18px; margin: 16px 0; color: #dc2626; }
  </style>
</head>
<body>
  <div class="card">
    <h2>mctl-alice — Ошибка авторизации</h2>
    <div class="error">❌ Ошибка обмена кода: ${err.message}</div>
  </div>
</body>
</html>`);
          return;
        }
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>mctl-alice — Авторизация</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; line-height: 1.6; }
    .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; }
    h2 { margin-top: 0; color: #0f172a; }
    .status { font-size: 18px; margin: 16px 0; }
    .success { color: #16a34a; }
    .error { color: #dc2626; }
    .speakers { background: #ffffff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>mctl-alice — Успешный вход</h2>
    <div id="status" class="status">Получение токена...</div>
    <div id="speakers" class="speakers" style="display:none;"></div>
  </div>
  <script>
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const token = params.get('access_token');
    const statusEl = document.getElementById('status');
    const speakersEl = document.getElementById('speakers');

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
          statusEl.className = 'status success';
          statusEl.innerText = '✅ Успешно! Колонка подключена к mctl-alice.';
          speakersEl.style.display = 'block';
          if (data.speakers && data.speakers.length > 0) {
            speakersEl.innerHTML = '<strong>Найденные колонки:</strong><br>' + data.speakers.map(s => '• ' + s).join('<br>');
          }
        } else {
          statusEl.className = 'status error';
          statusEl.innerText = '❌ Ошибка проверки: ' + (data.message || 'неизвестная ошибка');
        }
      })
      .catch(err => {
        statusEl.className = 'status error';
        statusEl.innerText = '❌ Ошибка: ' + err.message;
      });
    } else {
      statusEl.className = 'status error';
      statusEl.innerText = '❌ Токен не найден в URL редиректа.';
    }
  </script>
</body>
</html>`);
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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>mctl-alice — Настройка Quasar Cookie</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 680px; margin: 40px auto; padding: 20px; line-height: 1.6; color: #1e293b; }
    .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05); }
    h2 { margin-top: 0; color: #0f172a; }
    .desc { margin-bottom: 20px; color: #475569; }
    ol { padding-left: 20px; color: #334155; margin-bottom: 24px; }
    li { margin-bottom: 8px; }
    code { background: #e2e8f0; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    textarea { width: 100%; height: 90px; padding: 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-family: monospace; font-size: 13px; box-sizing: border-box; resize: vertical; }
    button { margin-top: 12px; background: #2563eb; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; font-size: 15px; font-weight: 500; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #1d4ed8; }
    .status { margin-top: 16px; font-weight: 500; padding: 12px; border-radius: 8px; display: none; }
    .status.success { display: block; background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
    .status.error { display: block; background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }
  </style>
</head>
<body>
  <div class="card">
    <h2>mctl-alice — Настройка Quasar (Динамический голос и команды)</h2>
    <p class="desc">
      Официальный IoT API Яндекса не позволяет произвольно говорить текст (TTS) или выполнять текстовые команды на колонках Алиса без заранее созданных вручную сценариев.<br>
      Для прямого воспроизведения произвольной речи («голос/текст — в ответ голос») используется Quasar API через веб-сессию Яндекса.
    </p>
    <h3>Инструкция:</h3>
    <ol>
      <li>Откройте <a href="https://yandex.ru/quasar" target="_blank">yandex.ru/quasar</a> или <a href="https://yandex.ru" target="_blank">yandex.ru</a> в браузере под вашим аккаунтом.</li>
      <li>Откройте DevTools (F12 или Cmd+Option+I на Mac).</li>
      <li>Вкладка <b>Application</b> (Приложение) или <b>Storage</b> &rarr; <b>Cookies</b> &rarr; <code>https://yandex.ru</code>.</li>
      <li>Найдите куки <code>Session_id</code> и скопируйте его значение (или скопируйте всю строку заголовка Cookie).</li>
      <li>Вставьте ниже и нажмите <b>Сохранить</b>.</li>
    </ol>
    <form id="cookieForm">
      <textarea id="cookieInput" placeholder="Session_id=3:17... или значение Session_id" required></textarea>
      <button type="submit" id="saveBtn">Сохранить и проверить</button>
    </form>
    <div id="status" class="status"></div>
  </div>
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
      statusEl.className = 'status';
      statusEl.style.display = 'block';
      statusEl.innerText = 'Проверка сессии в Yandex Quasar...';

      try {
        const res = await fetch('/auth/save-cookie', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookie })
        });
        const data = await res.json();
        if (res.ok && data.status === 'ok') {
          statusEl.className = 'status success';
          statusEl.innerText = '✅ Куки успешно проверены и сохранены! Теперь доступны динамический TTS (произвольный текст) и текстовые голосовые команды.';
        } else {
          statusEl.className = 'status error';
          statusEl.innerText = '❌ Ошибка проверки куки: ' + (data.message || 'не удалось получить CSRF токен');
        }
      } catch (err) {
        statusEl.className = 'status error';
        statusEl.innerText = '❌ Ошибка сети: ' + err.message;
      } finally {
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`);
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

    // Default info
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        service: "mctl-alice",
        description: "Yandex Alice Smart Speaker MCP & REST Server for ChatGPT",
        version: "1.7.4",
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
  });

  server.on("close", () => {
    if (sampler) sampler.stop();
  });

  return server;
}
