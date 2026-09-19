import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { YandexIoTClient } from "../client/yandex-api.js";
import { StationService } from "../services/station-service.js";

export interface AuthServerOptions {
  port?: number;
  clientId: string;
  envFilePath?: string;
  onSuccess?: (info: { token: string; speakers: string[] }) => void;
}

export function buildOAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: "token",
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  return `https://oauth.yandex.ru/authorize?${params.toString()}`;
}

export function saveEnvVariable(key: string, value: string, envFilePath?: string) {
  const targetPath = envFilePath || path.resolve(process.cwd(), ".env");
  let content = "";
  if (fs.existsSync(targetPath)) {
    content = fs.readFileSync(targetPath, "utf-8");
  }

  const line = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = content ? `${content.trim()}\n${line}\n` : `${line}\n`;
  }

  fs.writeFileSync(targetPath, content, "utf-8");
  process.env[key] = value;
}

export function saveTokenToEnvFile(token: string, envFilePath?: string) {
  saveEnvVariable("YANDEX_OAUTH_TOKEN", token, envFilePath);
}

export function saveClientIdToEnvFile(clientId: string, envFilePath?: string) {
  saveEnvVariable("YANDEX_CLIENT_ID", clientId, envFilePath);
}

export async function validateTokenAndGetSpeakers(token: string): Promise<string[]> {
  const client = new YandexIoTClient(token);
  const service = new StationService(client);
  const devices = await service.listDevices(true);
  return devices.speakers.map((s) => `${s.name} (${s.room})`);
}

export function startAuthServer(options: AuthServerOptions): Promise<{
  token: string;
  speakers: string[];
  server: http.Server;
}> {
  const port = options.port || 8085;
  const clientId = options.clientId;
  const redirectUri = `http://localhost:${port}/callback`;
  const oauthUrl = buildOAuthUrl(clientId, redirectUri);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      if (url.pathname === "/") {
        // Redirect directly to Yandex OAuth
        res.writeHead(302, { Location: oauthUrl });
        res.end();
        return;
      }

      if (url.pathname === "/callback") {
        // Return HTML that extracts hash fragment #access_token=... and POSTs it to /save-token
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
    <h2>Подключение Яндекс Станции (mctl-alice)</h2>
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
      statusEl.innerText = 'Токен получен. Проверяем связь с умным домом...';
      fetch('/save-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      })
      .then(res => res.json())
      .then(data => {
        if (data.status === 'ok') {
          statusEl.className = 'status success';
          statusEl.innerText = '✅ Авторизация успешна! Токен сохранен.';
          speakersEl.style.display = 'block';
          if (data.speakers && data.speakers.length > 0) {
            speakersEl.innerHTML = '<strong>Найденные колонки:</strong><br>' + data.speakers.map(s => '• ' + s).join('<br>');
          } else {
            speakersEl.innerHTML = '<em>Колонки не найдены в умном доме, но токен успешно сохранен.</em>';
          }
        } else {
          statusEl.className = 'status error';
          statusEl.innerText = '❌ Ошибка проверки токена: ' + (data.message || 'неизвестная ошибка');
        }
      })
      .catch(err => {
        statusEl.className = 'status error';
        statusEl.innerText = '❌ Ошибка отправки токена: ' + err.message;
      });
    } else {
      statusEl.className = 'status error';
      statusEl.innerText = '❌ Токен не найден в адресе редиректа.';
    }
  </script>
</body>
</html>`);
        return;
      }

      if (url.pathname === "/save-token" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          try {
            const data = JSON.parse(body);
            const token = data.token?.trim();
            if (!token) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "error", message: "Token is missing" }));
              return;
            }

            // Verify token with Yandex API
            const speakerNames = await validateTokenAndGetSpeakers(token);

            // Save token
            saveTokenToEnvFile(token, options.envFilePath);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                status: "ok",
                speakers: speakerNames,
              })
            );

            if (options.onSuccess) {
              options.onSuccess({ token, speakers: speakerNames });
            }

            // Give the browser time to render success page, then resolve
            setTimeout(() => {
              server.close();
              resolve({ token, speakers: speakerNames, server });
            }, 1000);
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "error", message: err.message }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    server.listen(port, () => {
      // server is ready
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}
