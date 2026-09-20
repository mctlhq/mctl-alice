import crypto from "node:crypto";
import {
  IStorage,
  UserRecord,
  UserCredentials,
  OAuthClient,
  PendingAuth,
  AuthCode,
  OAuthTokenRecord,
} from "./storage-interface.js";
import { encryptToken, decryptToken, hashToken } from "./crypto.js";

export interface MinioStorageOptions {
  endpoint?: string;
  bucket?: string;
  prefix?: string;
  accessKey?: string;
  secretKey?: string;
  region?: string;
}

export class MinioStorage implements IStorage {
  private endpoint: string;
  private bucket: string;
  private prefix: string;
  private accessKey: string;
  private secretKey: string;
  private region: string;

  constructor(options: MinioStorageOptions = {}) {
    this.endpoint = (
      options.endpoint ||
      process.env.MINIO_ENDPOINT ||
      "http://minio.minio.svc.cluster.local:9000"
    ).replace(/\/+$/, "");

    this.bucket = options.bucket || process.env.MINIO_BUCKET || "platform-state";
    this.prefix = (options.prefix || process.env.MINIO_PREFIX || "labs/mctl-alice")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");

    this.accessKey = options.accessKey || process.env.MINIO_ACCESS_KEY || "";
    this.secretKey = options.secretKey || process.env.MINIO_SECRET_KEY || "";
    this.region = options.region || process.env.MINIO_REGION || "us-east-1";
  }

  /**
   * Generates AWS SigV4 authorization headers for S3/MinIO REST API
   */
  private signRequest(method: string, canonicalPath: string, body = ""): Record<string, string> {
    const parsedUrl = new URL(this.endpoint);
    const host = parsedUrl.host;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateScope = amzDate.slice(0, 8);

    const payloadHash = crypto.createHash("sha256").update(body).digest("hex");

    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

    const canonicalRequest = [
      method,
      canonicalPath,
      "", // query string
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateScope}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    const kDate = crypto.createHmac("sha256", `AWS4${this.secretKey}`).update(dateScope).digest();
    const kRegion = crypto.createHmac("sha256", kDate).update(this.region).digest();
    const kService = crypto.createHmac("sha256", kRegion).update("s3").digest();
    const kSigning = crypto.createHmac("sha256", kService).update("aws4_request").digest();
    const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

    const authHeader = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      Host: host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      Authorization: authHeader,
    };
  }

  private buildKey(subPath: string): string {
    return this.prefix ? `${this.prefix}/${subPath}` : subPath;
  }

  async putObject(key: string, data: any): Promise<void> {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    const fullPath = `/${this.bucket}/${this.buildKey(key)}`;
    const headers = this.signRequest("PUT", fullPath, body);

    const res = await fetch(`${this.endpoint}${fullPath}`, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body,
    });

    if (!res.ok && res.status !== 200 && res.status !== 204) {
      const errText = await res.text().catch(() => "");
      throw new Error(`MinIO PUT ${fullPath} failed (${res.status}): ${errText}`);
    }
  }

  async getObject<T>(key: string): Promise<T | null> {
    const fullPath = `/${this.bucket}/${this.buildKey(key)}`;
    const headers = this.signRequest("GET", fullPath, "");

    const res = await fetch(`${this.endpoint}${fullPath}`, {
      method: "GET",
      headers,
    });

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`MinIO GET ${fullPath} failed (${res.status}): ${errText}`);
    }

    return (await res.json()) as T;
  }

  async deleteObject(key: string): Promise<void> {
    const fullPath = `/${this.bucket}/${this.buildKey(key)}`;
    const headers = this.signRequest("DELETE", fullPath, "");

    const res = await fetch(`${this.endpoint}${fullPath}`, {
      method: "DELETE",
      headers,
    });

    if (!res.ok && res.status !== 204 && res.status !== 404) {
      const errText = await res.text().catch(() => "");
      throw new Error(`MinIO DELETE ${fullPath} failed (${res.status}): ${errText}`);
    }
  }

  // --- Users & Credentials ---

  async saveUser(user: UserRecord): Promise<void> {
    await Promise.all([
      this.putObject(`users/${user.id}.json`, user),
      this.putObject(`indexes/yandex-uid/${user.yandexUid}.json`, { userId: user.id }),
    ]);
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    return this.getObject<UserRecord>(`users/${userId}.json`);
  }

  async getUserByYandexUid(yandexUid: string): Promise<UserRecord | null> {
    const index = await this.getObject<{ userId: string }>(`indexes/yandex-uid/${yandexUid}.json`);
    if (!index || !index.userId) return null;
    return this.getUser(index.userId);
  }

  async saveUserCredentials(userId: string, creds: UserCredentials): Promise<void> {
    const existing = await this.getUserCredentials(userId);

    const encryptedAccess = encryptToken(creds.yandexAccessToken, userId);
    const encryptedRefresh = creds.yandexRefreshToken
      ? encryptToken(creds.yandexRefreshToken, userId)
      : null;
    const encryptedQuasar = creds.quasarCookie
      ? encryptToken(creds.quasarCookie, userId)
      : existing?.quasarCookie
      ? encryptToken(existing.quasarCookie, userId)
      : null;

    const payload = {
      userId,
      encryptedYandexAccessToken: encryptedAccess,
      encryptedYandexRefreshToken: encryptedRefresh,
      yandexExpiresAt: creds.yandexExpiresAt || null,
      encryptedQuasarCookie: encryptedQuasar,
      quasarUpdatedAt: creds.quasarCookie ? Date.now() : existing?.quasarUpdatedAt || null,
      updatedAt: Date.now(),
    };

    await this.putObject(`credentials/${userId}.json`, payload);
  }

  async getUserCredentials(userId: string): Promise<UserCredentials | null> {
    const raw = await this.getObject<any>(`credentials/${userId}.json`);
    if (!raw) return null;

    try {
      const yandexAccessToken = decryptToken(raw.encryptedYandexAccessToken, userId);
      const yandexRefreshToken = raw.encryptedYandexRefreshToken
        ? decryptToken(raw.encryptedYandexRefreshToken, userId)
        : undefined;
      const quasarCookie = raw.encryptedQuasarCookie
        ? decryptToken(raw.encryptedQuasarCookie, userId)
        : undefined;

      return {
        yandexAccessToken,
        yandexRefreshToken,
        yandexExpiresAt: raw.yandexExpiresAt || undefined,
        quasarCookie,
        quasarUpdatedAt: raw.quasarUpdatedAt || undefined,
      };
    } catch {
      return null;
    }
  }

  async deleteUserCredentials(userId: string): Promise<void> {
    await this.deleteObject(`credentials/${userId}.json`);
  }

  async deleteUser(userId: string): Promise<void> {
    const user = await this.getUser(userId);
    await Promise.all([
      this.deleteObject(`users/${userId}.json`),
      user ? this.deleteObject(`indexes/yandex-uid/${user.yandexUid}.json`) : Promise.resolve(),
      this.deleteUserCredentials(userId),
      this.deleteQuasarScenarios(userId),
    ]);
  }

  // --- Web Sessions ---

  async saveWebSession(sessionId: string, userId: string, expiresAt: number): Promise<void> {
    const hash = hashToken(sessionId);
    await this.putObject(`sessions/${hash}.json`, {
      userId,
      expiresAt,
      createdAt: Date.now(),
    });
  }

  async getWebSession(sessionId: string): Promise<{ userId: string } | null> {
    const hash = hashToken(sessionId);
    const session = await this.getObject<{ userId: string; expiresAt: number }>(`sessions/${hash}.json`);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      await this.deleteWebSession(sessionId);
      return null;
    }
    return { userId: session.userId };
  }

  async deleteWebSession(sessionId: string): Promise<void> {
    const hash = hashToken(sessionId);
    await this.deleteObject(`sessions/${hash}.json`);
  }

  // --- Quasar Scenarios ---

  async saveQuasarScenario(userId: string, deviceId: string, scenarioId: string, scenarioName?: string): Promise<void> {
    const current = (await this.getObject<Record<string, { scenarioId: string; scenarioName?: string }>>(`scenarios/${userId}.json`)) || {};
    current[deviceId] = { scenarioId, scenarioName };
    await this.putObject(`scenarios/${userId}.json`, current);
  }

  async getQuasarScenario(userId: string, deviceId: string): Promise<string | null> {
    const current = await this.getObject<Record<string, { scenarioId: string; scenarioName?: string }>>(`scenarios/${userId}.json`);
    return current?.[deviceId]?.scenarioId || null;
  }

  async listQuasarScenarios(userId: string): Promise<Array<{ deviceId: string; scenarioId: string; scenarioName?: string }>> {
    const current = await this.getObject<Record<string, { scenarioId: string; scenarioName?: string }>>(`scenarios/${userId}.json`);
    if (!current) return [];
    return Object.entries(current).map(([deviceId, val]) => ({
      deviceId,
      scenarioId: val.scenarioId,
      scenarioName: val.scenarioName,
    }));
  }

  async deleteQuasarScenarios(userId: string): Promise<void> {
    await this.deleteObject(`scenarios/${userId}.json`);
  }

  // --- OAuth Clients ---

  async saveClient(client: OAuthClient): Promise<void> {
    await this.putObject(`clients/${client.clientId}.json`, client);
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    return this.getObject<OAuthClient>(`clients/${clientId}.json`);
  }

  // --- Pending Auth ---

  async savePendingAuth(pending: PendingAuth): Promise<void> {
    await this.putObject(`pending/${pending.state}.json`, pending);
  }

  async getPendingAuth(state: string): Promise<PendingAuth | null> {
    const pending = await this.getObject<PendingAuth>(`pending/${state}.json`);
    if (!pending) return null;
    if (pending.expiresAt < Date.now()) {
      await this.deletePendingAuth(state);
      return null;
    }
    return pending;
  }

  async deletePendingAuth(state: string): Promise<void> {
    await this.deleteObject(`pending/${state}.json`);
  }

  // --- Auth Codes ---

  async saveAuthCode(code: AuthCode): Promise<void> {
    const userId = code.userId || "legacy_user";
    const encAccess = code.yandexAccessToken ? encryptToken(code.yandexAccessToken, userId) : "";
    const encRefresh = code.yandexRefreshToken ? encryptToken(code.yandexRefreshToken, userId) : null;

    const payload = {
      ...code,
      yandexAccessToken: encAccess,
      yandexRefreshToken: encRefresh,
    };
    await this.putObject(`codes/${code.code}.json`, payload);
  }

  async consumeAuthCode(code: string): Promise<AuthCode | null> {
    const raw = await this.getObject<any>(`codes/${code}.json`);
    if (!raw) return null;

    await this.deleteObject(`codes/${code}.json`);
    if (raw.expiresAt < Date.now()) {
      return null;
    }

    const userId = raw.userId || "legacy_user";
    let yandexAccessToken = "";
    let yandexRefreshToken: string | undefined = undefined;

    if (raw.yandexAccessToken) {
      try {
        yandexAccessToken = decryptToken(raw.yandexAccessToken, userId);
      } catch {
        yandexAccessToken = raw.yandexAccessToken;
      }
    }
    if (raw.yandexRefreshToken) {
      try {
        yandexRefreshToken = decryptToken(raw.yandexRefreshToken, userId);
      } catch {
        yandexRefreshToken = raw.yandexRefreshToken;
      }
    }

    return {
      ...raw,
      yandexAccessToken,
      yandexRefreshToken,
    };
  }

  // --- Tokens ---

  async saveToken(token: OAuthTokenRecord): Promise<void> {
    const userId = token.userId || "legacy_user";
    const encAccess = token.yandexAccessToken ? encryptToken(token.yandexAccessToken, userId) : "";
    const encRefresh = token.yandexRefreshToken ? encryptToken(token.yandexRefreshToken, userId) : null;

    const payload = {
      ...token,
      yandexAccessToken: encAccess,
      yandexRefreshToken: encRefresh,
    };

    const accessHash = hashToken(token.accessToken);
    await this.putObject(`tokens/${accessHash}.json`, payload);

    if (token.refreshToken) {
      const refreshHash = hashToken(token.refreshToken);
      await this.putObject(`tokens_refresh/${refreshHash}.json`, { accessTokenHash: accessHash });
    }
  }

  async getToken(accessToken: string): Promise<OAuthTokenRecord | null> {
    const accessHash = hashToken(accessToken);
    const raw = await this.getObject<any>(`tokens/${accessHash}.json`);
    if (!raw) return null;
    if (raw.expiresAt < Date.now()) {
      return null;
    }

    const userId = raw.userId || "legacy_user";
    let yandexAccessToken = "";
    let yandexRefreshToken: string | undefined = undefined;

    if (raw.yandexAccessToken) {
      try {
        yandexAccessToken = decryptToken(raw.yandexAccessToken, userId);
      } catch {
        yandexAccessToken = raw.yandexAccessToken;
      }
    }
    if (raw.yandexRefreshToken) {
      try {
        yandexRefreshToken = decryptToken(raw.yandexRefreshToken, userId);
      } catch {
        yandexRefreshToken = raw.yandexRefreshToken;
      }
    }

    return {
      ...raw,
      yandexAccessToken,
      yandexRefreshToken,
    };
  }

  async getTokenByRefreshToken(refreshToken: string): Promise<OAuthTokenRecord | null> {
    const refreshHash = hashToken(refreshToken);
    const ptr = await this.getObject<{ accessTokenHash: string }>(`tokens_refresh/${refreshHash}.json`);
    if (!ptr || !ptr.accessTokenHash) return null;

    const raw = await this.getObject<any>(`tokens/${ptr.accessTokenHash}.json`);
    if (!raw) return null;

    const userId = raw.userId || "legacy_user";
    let yandexAccessToken = "";
    let yandexRefreshToken: string | undefined = undefined;

    if (raw.yandexAccessToken) {
      try {
        yandexAccessToken = decryptToken(raw.yandexAccessToken, userId);
      } catch {
        yandexAccessToken = raw.yandexAccessToken;
      }
    }
    if (raw.yandexRefreshToken) {
      try {
        yandexRefreshToken = decryptToken(raw.yandexRefreshToken, userId);
      } catch {
        yandexRefreshToken = raw.yandexRefreshToken;
      }
    }

    return {
      ...raw,
      yandexAccessToken,
      yandexRefreshToken,
    };
  }

  async revokeToken(token: string): Promise<boolean> {
    const tokenHash = hashToken(token);
    // Try both access and refresh pointer
    await Promise.all([
      this.deleteObject(`tokens/${tokenHash}.json`),
      this.deleteObject(`tokens_refresh/${tokenHash}.json`),
    ]);
    return true;
  }
}
