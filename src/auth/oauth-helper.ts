import { FORM_BODY_LIMIT, PayloadTooLargeError, readRequestBody, sendPayloadTooLarge } from "../server/request-body.js";
import { UpstreamTimeoutError, upstreamFetch } from "../client/upstream.js";
import http from "node:http";
import crypto from "node:crypto";
import { YandexIoTClient } from "../client/yandex-api.js";
import { isLocalOrigin } from "../server/origin.js";
import { StationService } from "../services/station-service.js";
import {
  OAuthTokenResponse,
  buildOAuthUrl,
  saveTokenToEnvFile,
  saveRefreshTokenToEnvFile,
  saveTokenToKeychain,
  exchangeCodeForToken,
  refreshAccessToken,
} from "./token-storage.js";

export * from "./token-storage.js";

export interface AuthServerOptions {
  port?: number;
  clientId: string;
  clientSecret?: string;
  responseType?: "token" | "code";
  /** Nonce the authorization URL carries; generated when absent. */
  state?: string;
  envFilePath?: string;
  onSuccess?: (info: { token: string; refreshToken?: string; speakers: string[] }) => void;
}


export async function validateTokenAndGetSpeakers(token: string): Promise<string[]> {
  const client = new YandexIoTClient(token, { useKeychain: false });
  const service = new StationService(client);
  const devices = await service.listDevices(true);
  return devices.speakers.map((s) => `${s.name} (${s.room})`);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderHtmlPage(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
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
    ${content}
  </div>
</body>
</html>`;
}

export function startAuthServer(options: AuthServerOptions): Promise<{
  token: string;
  refreshToken?: string;
  speakers: string[];
  server: http.Server;
}> {
  const port = options.port || 8085;
  const clientId = options.clientId;
  const clientSecret = options.clientSecret;
  const responseType = options.responseType || (clientSecret ? "code" : "token");
  const redirectUri = `http://localhost:${port}/callback`;
  // Binds a callback to the flow this process started: without it any page
  // could load /callback#access_token=<its own token> in the operator's
  // browser and have that page hand the token over with a valid Origin.
  const state = options.state || crypto.randomUUID();
  const oauthUrl = buildOAuthUrl(clientId, redirectUri, responseType, state);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");

      if (url.pathname === "/") {
        // Redirect directly to Yandex OAuth
        res.writeHead(302, { Location: oauthUrl });
        res.end();
        return;
      }

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");

        // If Authorization Code flow was used, exchange code directly on backend
        if (code && clientSecret) {
          if (url.searchParams.get("state") !== state) {
            res.writeHead(403); res.end("Invalid state"); return;
          }
          try {
            const tokens = await exchangeCodeForToken({
              code,
              clientId,
              clientSecret,
              redirectUri,
            });

            const speakerNames = await validateTokenAndGetSpeakers(tokens.access_token);
            saveTokenToEnvFile(tokens.access_token, options.envFilePath);
            saveTokenToKeychain(tokens.access_token, "mctl-alice");

            if (tokens.refresh_token) {
              saveRefreshTokenToEnvFile(tokens.refresh_token, options.envFilePath);
              saveTokenToKeychain(tokens.refresh_token, "mctl-alice-refresh-token");
            }

            const speakerHtml =
              speakerNames.length > 0
                ? `<div class="speakers"><strong>Найденные колонки:</strong><br>${speakerNames.map((s) => "• " + escapeHtml(s)).join("<br>")}</div>`
                : `<div class="speakers"><em>Колонки не найдены в умном доме, но токен успешно получен и сохранен.</em></div>`;

            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
              renderHtmlPage(
                "mctl-alice — Авторизация успешна",
                `<div class="status success">✅ Авторизация успешна! Получен постоянный Refresh-токен.</div>${speakerHtml}`
              )
            );

            if (options.onSuccess) {
              options.onSuccess({
                token: tokens.access_token,
                refreshToken: tokens.refresh_token,
                speakers: speakerNames,
              });
            }

            setTimeout(() => {
              server.close();
              resolve({
                token: tokens.access_token,
                refreshToken: tokens.refresh_token,
                speakers: speakerNames,
                server,
              });
            }, 1000);
            return;
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
              renderHtmlPage(
                "mctl-alice — Ошибка",
                `<div class="status error">❌ Ошибка обмена кода авторизации: ${escapeHtml(String(err.message))}</div>`
              )
            );
            return;
          }
        }

        // Implicit flow fallback (hash fragment #access_token=... parsed by browser JS)
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
    const state = params.get('state');
    const statusEl = document.getElementById('status');
    const speakersEl = document.getElementById('speakers');

    if (token) {
      statusEl.innerText = 'Токен получен. Проверяем связь с умным домом...';
      fetch('/save-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, state })
      })
      .then(res => res.json())
      .then(data => {
        if (data.status === 'ok') {
          statusEl.className = 'status success';
          statusEl.innerText = '✅ Авторизация успешна! Токен сохранен.';
          speakersEl.style.display = 'block';
          if (data.speakers && data.speakers.length > 0) {
            const title = document.createElement('strong');
            title.textContent = 'Найденные колонки:';
            speakersEl.replaceChildren(title);
            data.speakers.forEach(s => {
              speakersEl.appendChild(document.createElement('br'));
              speakersEl.appendChild(document.createTextNode('• ' + String(s)));
            });
          } else {
            const note = document.createElement('em');
            note.textContent = 'Колонки не найдены в умном доме, но токен успешно сохранен.';
            speakersEl.replaceChildren(note);
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
        // Only this helper's own page may hand it a token: a cross-site
        // text/plain form would otherwise store an attacker's account. Its
        // fetch always carries Origin, so a request without one is refused.
        const origin = req.headers.origin;
        if (origin === undefined || !isLocalOrigin(origin, `http://localhost:${port}`)) {
          res.writeHead(403); res.end("Invalid origin"); return;
        }
        let body: string;
        try { body = await readRequestBody(req, { limit: FORM_BODY_LIMIT }); }
        catch (err) {
          if (err instanceof PayloadTooLargeError) { sendPayloadTooLarge(res); return; }
          res.writeHead(400); res.end(); return;
        }
        {
          try {
            const data = JSON.parse(body);
            if (data.state !== state) {
              res.writeHead(403, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "error", message: "Invalid state; start the sign-in again" }));
              return;
            }
            const token = data.token?.trim();
            const refreshToken = data.refreshToken?.trim();
            if (!token) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "error", message: "Token is missing" }));
              return;
            }

            // Verify token with Yandex API
            const speakerNames = await validateTokenAndGetSpeakers(token);

            // Save tokens
            saveTokenToEnvFile(token, options.envFilePath);
            saveTokenToKeychain(token, "mctl-alice");

            if (refreshToken) {
              saveRefreshTokenToEnvFile(refreshToken, options.envFilePath);
              saveTokenToKeychain(refreshToken, "mctl-alice-refresh-token");
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                status: "ok",
                speakers: speakerNames,
              })
            );

            if (options.onSuccess) {
              options.onSuccess({ token, refreshToken, speakers: speakerNames });
            }

            setTimeout(() => {
              server.close();
              resolve({ token, refreshToken, speakers: speakerNames, server });
            }, 1000);
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "error", message: err.message }));
          }
        }
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    // Loopback only: the redirect URI is localhost, and nothing on the
    // network should be able to reach /save-token while the flow is open.
    server.listen(port, "127.0.0.1", () => {
      // server is ready
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

export interface YandexProfile {
  id: string;
  yandexUid: string;
  login: string;
  displayName: string;
}

export async function fetchYandexProfile(accessToken: string, requireVerifiedIdentity = false, timeoutMs?: number): Promise<YandexProfile> {
  try {
    const { res, data } = await upstreamFetch(
      "https://login.yandex.ru/info?format=json",
      { headers: { Authorization: `OAuth ${accessToken}` } },
      { upstream: "Yandex login", timeoutMs },
      async (r) => ({ res: r, data: r.ok ? ((await r.json()) as any) : undefined }),
    );
    if (res.ok) {
      if (data && data.id) {
        return {
          id: `usr_${data.id}`,
          yandexUid: String(data.id),
          login: data.login || data.default_email || "user",
          displayName: data.display_name || data.real_name || data.login || "Пользователь",
        };
      }
    }
  } catch (err: any) {
    if (requireVerifiedIdentity && err instanceof UpstreamTimeoutError) throw err;
    console.warn("[OAuth] Failed to fetch profile from login.yandex.ru:", err.message);
  }

  if (requireVerifiedIdentity) throw new Error("Yandex profile verification failed; reconnect");

  // Fallback: smart home API user info
  try {
    const { res, data } = await upstreamFetch(
      "https://api.iot.yandex.net/v1.0/user/info",
      { headers: { Authorization: `Bearer ${accessToken}` } },
      { upstream: "Yandex IoT", timeoutMs },
      async (r) => ({ res: r, data: r.ok ? ((await r.json()) as any) : undefined }),
    );
    if (res.ok) {
      const householdId = data.households?.[0]?.id || "default";
      const hash = crypto.createHash("sha256").update(accessToken).digest("hex").slice(0, 12);
      return {
        id: `usr_${hash}`,
        yandexUid: `iot_${householdId}_${hash}`,
        login: "yandex_user",
        displayName: "Владелец умного дома",
      };
    }
  } catch {}

  const fallbackHash = crypto.createHash("sha256").update(accessToken).digest("hex").slice(0, 12);
  return {
    id: `usr_${fallbackHash}`,
    yandexUid: fallbackHash,
    login: "user",
    displayName: "Пользователь",
  };
}

