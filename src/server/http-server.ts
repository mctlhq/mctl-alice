import http from "node:http";
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
import {
  buildOAuthUrl,
  exchangeCodeForToken,
  saveTokenToEnvFile,
  saveRefreshTokenToEnvFile,
  saveTokenToKeychain,
  getTokenFromKeychain,
} from "../auth/oauth-helper.js";
import { getOpenApiSpec } from "./openapi.js";

const DEFAULT_CLIENT_ID = "c0ebe342af7d48fbbbfcf2d2eedb8f9e";

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function getServiceForRequest(
  req: http.IncomingMessage,
  defaultService: StationService
): StationService {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token) {
      try {
        const client = new YandexIoTClient(token, { useKeychain: false, persistEnv: false });
        return new StationService(client);
      } catch {
        // Fallback to default service
      }
    }
  }
  return defaultService;
}

export function createMcpServer(service: StationService): Server {
  const server = new Server(
    {
      name: "mctl-alice",
      version: "1.0.0",
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
    return handleToolCall(name, args, service);
  });

  return server;
}

export function createHttpServer(
  port = 8080,
  options: { clientId?: string; clientSecret?: string; publicBaseUrl?: string } = {}
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
    getTokenFromKeychain("mctl-alice-client-secret");
  const redirectUri = `${baseUrl}/auth/callback`;

  let stationService = new StationService();

  // Keep track of active SSE transports
  const sseTransports = new Map<string, SSEServerTransport>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", baseUrl);

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check for Kubernetes probes
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "mctl-alice", version: "1.0.0" }));
      return;
    }

    // OpenAPI 3.1 schema for ChatGPT Actions and external integrators
    if (url.pathname === "/openapi.json" || url.pathname === "/openapi.yaml") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getOpenApiSpec(baseUrl), null, 2));
      return;
    }

    // MCP SSE endpoint for ChatGPT Connectors / remote MCP clients
    if ((url.pathname === "/sse" || url.pathname === "/mcp/sse") && req.method === "GET") {
      try {
        const svc = getServiceForRequest(req, stationService);
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
    if ((url.pathname === "/messages" || url.pathname === "/mcp/messages") && req.method === "POST") {
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
        const svc = getServiceForRequest(req, stationService);
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
        const svc = getServiceForRequest(req, stationService);
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
        const svc = getServiceForRequest(req, stationService);
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
        const svc = getServiceForRequest(req, stationService);
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
        const svc = getServiceForRequest(req, stationService);
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
        const svc = getServiceForRequest(req, stationService);
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
      const code = url.searchParams.get("code");
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
          stationService = new StationService(client);
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

    // Direct JSON-RPC endpoint at POST /mcp
    if (url.pathname === "/mcp" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const rpcReq = JSON.parse(body);
          const id = rpcReq.id;

          if (rpcReq.method === "initialize") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  protocolVersion: "2024-11-05",
                  capabilities: { tools: {} },
                  serverInfo: { name: "mctl-alice", version: "1.0.0" },
                },
              })
            );
            return;
          }

          if (rpcReq.method === "tools/list") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: { tools: ALICE_TOOLS },
              })
            );
            return;
          }

          if (rpcReq.method === "tools/call") {
            const { name, arguments: args } = rpcReq.params || {};
            const svc = getServiceForRequest(req, stationService);
            const result = await handleToolCall(name, args, svc);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result,
              })
            );
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Method not found: ${rpcReq.method}` },
            })
          );
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32700, message: "Parse error" },
            })
          );
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
        version: "1.0.0",
        endpoints: {
          openapi: "/openapi.json",
          sse: "/sse",
          messages: "/messages",
          mcp: "/mcp",
          healthz: "/healthz",
          auth: "/auth/login",
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

  return server;
}
