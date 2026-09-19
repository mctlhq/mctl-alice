import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

export function buildOAuthUrl(
  clientId: string,
  redirectUri: string,
  responseType: "token" | "code" = "token"
): string {
  const params = new URLSearchParams({
    response_type: responseType,
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

export function saveRefreshTokenToEnvFile(refreshToken: string, envFilePath?: string) {
  saveEnvVariable("YANDEX_REFRESH_TOKEN", refreshToken, envFilePath);
}

export function saveClientIdToEnvFile(clientId: string, envFilePath?: string) {
  saveEnvVariable("YANDEX_CLIENT_ID", clientId, envFilePath);
}

export function saveClientSecretToEnvFile(clientSecret: string, envFilePath?: string) {
  saveEnvVariable("YANDEX_CLIENT_SECRET", clientSecret, envFilePath);
}

export function saveCookieToEnvFile(cookie: string, envFilePath?: string) {
  saveEnvVariable("YANDEX_COOKIE", cookie, envFilePath);
}

export function saveCookieToKeychain(
  cookie: string,
  service = "mctl-alice-cookie",
  account = "mashkoffdmitry"
): boolean {
  return saveTokenToKeychain(cookie, service, account);
}

export function getCookieFromKeychain(service = "mctl-alice-cookie"): string | null {
  return getTokenFromKeychain(service);
}

export function saveTokenToKeychain(
  token: string,
  service = "mctl-alice",
  account = "mashkoffdmitry"
): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execSync(`security add-generic-password -a "${account}" -s "${service}" -w "${token}" -U`, {
      stdio: ["pipe", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function getTokenFromKeychain(service = "mctl-alice"): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const out = execSync(`security find-generic-password -s "${service}" -w`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export const getMacKeychain = getTokenFromKeychain;
export const setMacKeychain = saveTokenToKeychain;

export async function exchangeCodeForToken(options: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}): Promise<OAuthTokenResponse> {
  const bodyParams = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    client_id: options.clientId,
    client_secret: options.clientSecret,
  });
  if (options.redirectUri) {
    bodyParams.set("redirect_uri", options.redirectUri);
  }

  const res = await fetch("https://oauth.yandex.ru/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: bodyParams.toString(),
  });

  const data = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(
      data.error_description || data.error || `Token exchange failed with HTTP ${res.status}`
    );
  }
  return data as OAuthTokenResponse;
}

export async function refreshAccessToken(options: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<OAuthTokenResponse> {
  const bodyParams = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
    client_id: options.clientId,
    client_secret: options.clientSecret,
  });

  const res = await fetch("https://oauth.yandex.ru/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: bodyParams.toString(),
  });

  const data = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(
      data.error_description || data.error || `Token refresh failed with HTTP ${res.status}`
    );
  }
  return data as OAuthTokenResponse;
}
