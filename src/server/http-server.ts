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
import { buildOAuthUrl, saveTokenToEnvFile } from "../auth/oauth-helper.js";

const DEFAULT_CLIENT_ID = "c0ebe342af7d48fbbbfcf2d2eedb8f9e";

export function createHttpServer(
  port = 8080,
  options: { clientId?: string; publicBaseUrl?: string } = {}
): http.Server {
  const baseUrl = options.publicBaseUrl || process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
  const clientId = options.clientId || process.env.YANDEX_CLIENT_ID || DEFAULT_CLIENT_ID;
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

    // Auth login redirect
    if (url.pathname === "/auth/login") {
      const oauthUrl = buildOAuthUrl(clientId, redirectUri);
      res.writeHead(302, { Location: oauthUrl });
      res.end();
      return;
    }

    // Auth callback HTML
    if (url.pathname === "/auth/callback") {
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
          if (!token) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "error", message: "Token missing" }));
            return;
          }

          // Verify with Yandex API
          const client = new YandexIoTClient(token);
          stationService = new StationService(client);
          const devices = await stationService.listDevices(true);
          const speakerNames = devices.speakers.map((s) => `${s.name} (${s.room})`);

          saveTokenToEnvFile(token);

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
            const result = await handleToolCall(name, args, stationService);
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
        description: "Yandex Alice Smart Speaker MCP Server",
        version: "1.0.0",
        endpoints: {
          mcp: "/mcp",
          healthz: "/healthz",
          auth: "/auth/login",
        },
      })
    );
  });

  return server;
}
