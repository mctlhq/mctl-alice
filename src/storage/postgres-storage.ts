import pg from "pg";
const { Pool } = pg;
import {
  IStorage,
  UserRecord,
  UserCredentials,
  OAuthClient,
  PendingAuth,
  AuthCode,
  OAuthTokenRecord,
  UserGrant,
} from "./storage-interface.js";
import {
  ITelemetryStorage,
  TelemetrySample,
  TelemetryHistoryResult,
  QueryHistoryOptions,
  HistoryDataPoint,
} from "./telemetry-storage.js";
import { encryptToken, decryptToken } from "./crypto.js";

export interface PostgresStorageOptions {
  connectionString?: string;
  pool?: pg.Pool;
  ssl?: boolean | object;
}

export class PostgresStorage implements IStorage {
  private pool: pg.Pool;
  private initPromise: Promise<void> | null = null;

  constructor(options: PostgresStorageOptions = {}) {
    if (options.pool) {
      this.pool = options.pool;
    } else {
      const connStr = options.connectionString || process.env.DATABASE_URL;
      this.pool = new Pool({
        connectionString: connStr,
        max: 10,
        idleTimeoutMillis: 30000,
        ssl: options.ssl ?? (process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined),
      });
    }

    this.initPromise = this.initTables().catch((err) => {
      console.error("❌ [PostgresStorage] Failed to initialize tables:", err);
      throw err;
    });
  }

  public async ready(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  public getPool(): pg.Pool {
    return this.pool;
  }

  private async initTables(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id VARCHAR(255) PRIMARY KEY,
          yandex_uid VARCHAR(255) UNIQUE NOT NULL,
          login VARCHAR(255),
          display_name VARCHAR(255),
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_credentials (
          user_id VARCHAR(255) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          encrypted_yandex_access_token TEXT NOT NULL,
          encrypted_yandex_refresh_token TEXT,
          yandex_expires_at BIGINT,
          encrypted_quasar_cookie TEXT,
          quasar_updated_at BIGINT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS web_sessions (
          session_hash VARCHAR(255) PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);

        CREATE TABLE IF NOT EXISTS quasar_proxy_scenarios (
          user_id VARCHAR(255) NOT NULL,
          device_id VARCHAR(255) NOT NULL,
          scenario_id VARCHAR(255) NOT NULL,
          scenario_name VARCHAR(255),
          created_at BIGINT NOT NULL,
          PRIMARY KEY(user_id, device_id)
        );

        CREATE TABLE IF NOT EXISTS oauth_clients (
          client_id VARCHAR(255) PRIMARY KEY,
          client_secret VARCHAR(255),
          client_name VARCHAR(255),
          redirect_uris TEXT NOT NULL,
          created_at BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS oauth_pending (
          state VARCHAR(255) PRIMARY KEY,
          client_id VARCHAR(255) NOT NULL,
          redirect_uri TEXT NOT NULL,
          client_state TEXT NOT NULL,
          code_challenge TEXT,
          code_challenge_method VARCHAR(50),
          scope TEXT NOT NULL,
          user_id VARCHAR(255),
          yandex_callback_uri TEXT,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pending_expires ON oauth_pending(expires_at);

        CREATE TABLE IF NOT EXISTS oauth_codes (
          code VARCHAR(255) PRIMARY KEY,
          client_id VARCHAR(255) NOT NULL,
          redirect_uri TEXT NOT NULL,
          code_challenge TEXT,
          code_challenge_method VARCHAR(50),
          user_id VARCHAR(255),
          yandex_access_token TEXT NOT NULL,
          yandex_refresh_token TEXT,
          yandex_expires_at BIGINT,
          scope TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_codes_expires ON oauth_codes(expires_at);

        CREATE TABLE IF NOT EXISTS oauth_tokens (
          access_token VARCHAR(255) PRIMARY KEY,
          refresh_token VARCHAR(255) UNIQUE,
          client_id VARCHAR(255) NOT NULL,
          user_id VARCHAR(255),
          yandex_access_token TEXT NOT NULL,
          yandex_refresh_token TEXT,
          yandex_expires_at BIGINT,
          scope TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tokens_expires ON oauth_tokens(expires_at);
        CREATE INDEX IF NOT EXISTS idx_tokens_user ON oauth_tokens(user_id);
      `);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // --- Users & Credentials ---

  async saveUser(user: UserRecord): Promise<void> {
    await this.ready();
    const query = `
      INSERT INTO users (id, yandex_uid, login, display_name, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        yandex_uid = EXCLUDED.yandex_uid,
        login = EXCLUDED.login,
        display_name = EXCLUDED.display_name,
        updated_at = EXCLUDED.updated_at
    `;
    await this.pool.query(query, [
      user.id,
      user.yandexUid,
      user.login ?? null,
      user.displayName ?? null,
      user.createdAt,
      user.updatedAt,
    ]);
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    await this.ready();
    const res = await this.pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      yandexUid: row.yandex_uid,
      login: row.login ?? undefined,
      displayName: row.display_name ?? undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async getUserByYandexUid(yandexUid: string): Promise<UserRecord | null> {
    await this.ready();
    const res = await this.pool.query("SELECT * FROM users WHERE yandex_uid = $1", [yandexUid]);
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      yandexUid: row.yandex_uid,
      login: row.login ?? undefined,
      displayName: row.display_name ?? undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async saveUserCredentials(userId: string, creds: UserCredentials): Promise<void> {
    await this.ready();
    const now = Date.now();
    const encAccess = encryptToken(creds.yandexAccessToken, userId);
    const encRefresh = creds.yandexRefreshToken ? encryptToken(creds.yandexRefreshToken, userId) : null;
    const encCookie = creds.quasarCookie ? encryptToken(creds.quasarCookie, userId) : null;

    const query = `
      INSERT INTO user_credentials (
        user_id, encrypted_yandex_access_token, encrypted_yandex_refresh_token,
        yandex_expires_at, encrypted_quasar_cookie, quasar_updated_at,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id) DO UPDATE SET
        encrypted_yandex_access_token = EXCLUDED.encrypted_yandex_access_token,
        encrypted_yandex_refresh_token = COALESCE(EXCLUDED.encrypted_yandex_refresh_token, user_credentials.encrypted_yandex_refresh_token),
        yandex_expires_at = COALESCE(EXCLUDED.yandex_expires_at, user_credentials.yandex_expires_at),
        encrypted_quasar_cookie = COALESCE(EXCLUDED.encrypted_quasar_cookie, user_credentials.encrypted_quasar_cookie),
        quasar_updated_at = COALESCE(EXCLUDED.quasar_updated_at, user_credentials.quasar_updated_at),
        updated_at = EXCLUDED.updated_at
    `;

    await this.pool.query(query, [
      userId,
      encAccess,
      encRefresh,
      creds.yandexExpiresAt ?? null,
      encCookie,
      creds.quasarUpdatedAt ?? null,
      now,
      now,
    ]);
  }

  async getUserCredentials(userId: string): Promise<UserCredentials | null> {
    await this.ready();
    const res = await this.pool.query("SELECT * FROM user_credentials WHERE user_id = $1", [userId]);
    const row = res.rows[0];
    if (!row) return null;

    let yandexAccessToken = "";
    let yandexRefreshToken: string | undefined = undefined;
    let quasarCookie: string | undefined = undefined;

    if (row.encrypted_yandex_access_token) {
      try {
        yandexAccessToken = decryptToken(row.encrypted_yandex_access_token, userId);
      } catch {
        yandexAccessToken = row.encrypted_yandex_access_token;
      }
    }

    if (row.encrypted_yandex_refresh_token) {
      try {
        yandexRefreshToken = decryptToken(row.encrypted_yandex_refresh_token, userId);
      } catch {
        yandexRefreshToken = row.encrypted_yandex_refresh_token;
      }
    }

    if (row.encrypted_quasar_cookie) {
      try {
        quasarCookie = decryptToken(row.encrypted_quasar_cookie, userId);
      } catch {
        quasarCookie = row.encrypted_quasar_cookie;
      }
    }

    return {
      yandexAccessToken,
      yandexRefreshToken,
      yandexExpiresAt: row.yandex_expires_at ? Number(row.yandex_expires_at) : undefined,
      quasarCookie,
      quasarUpdatedAt: row.quasar_updated_at ? Number(row.quasar_updated_at) : undefined,
    };
  }

  async deleteUserCredentials(userId: string): Promise<void> {
    await this.ready();
    await this.pool.query("DELETE FROM user_credentials WHERE user_id = $1", [userId]);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.ready();
    await this.pool.query("DELETE FROM users WHERE id = $1", [userId]);
  }

  // --- Web Sessions ---

  async saveWebSession(sessionId: string, userId: string, expiresAt: number): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO web_sessions (session_hash, user_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [sessionId, userId, Date.now(), expiresAt]
    );
  }

  async getWebSession(sessionId: string): Promise<{ userId: string } | null> {
    await this.ready();
    const res = await this.pool.query(
      "SELECT user_id, expires_at FROM web_sessions WHERE session_hash = $1",
      [sessionId]
    );
    const row = res.rows[0];
    if (!row) return null;
    if (Number(row.expires_at) < Date.now()) {
      await this.deleteWebSession(sessionId);
      return null;
    }
    return { userId: row.user_id };
  }

  async deleteWebSession(sessionId: string): Promise<void> {
    await this.ready();
    await this.pool.query("DELETE FROM web_sessions WHERE session_hash = $1", [sessionId]);
  }

  // --- Quasar Scenarios ---

  async saveQuasarScenario(userId: string, deviceId: string, scenarioId: string, scenarioName?: string): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO quasar_proxy_scenarios (user_id, device_id, scenario_id, scenario_name, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, device_id) DO UPDATE SET
         scenario_id = EXCLUDED.scenario_id,
         scenario_name = EXCLUDED.scenario_name`,
      [userId, deviceId, scenarioId, scenarioName ?? null, Date.now()]
    );
  }

  async getQuasarScenario(userId: string, deviceId: string): Promise<string | null> {
    await this.ready();
    const res = await this.pool.query(
      "SELECT scenario_id FROM quasar_proxy_scenarios WHERE user_id = $1 AND device_id = $2",
      [userId, deviceId]
    );
    return res.rows[0]?.scenario_id ?? null;
  }

  async listQuasarScenarios(userId: string): Promise<Array<{ deviceId: string; scenarioId: string; scenarioName?: string }>> {
    await this.ready();
    const res = await this.pool.query(
      "SELECT device_id, scenario_id, scenario_name FROM quasar_proxy_scenarios WHERE user_id = $1",
      [userId]
    );
    return res.rows.map((r) => ({
      deviceId: r.device_id,
      scenarioId: r.scenario_id,
      scenarioName: r.scenario_name ?? undefined,
    }));
  }

  async deleteQuasarScenarios(userId: string): Promise<void> {
    await this.ready();
    await this.pool.query("DELETE FROM quasar_proxy_scenarios WHERE user_id = $1", [userId]);
  }

  // --- OAuth Clients ---

  async saveClient(client: OAuthClient): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO oauth_clients (client_id, client_secret, client_name, redirect_uris, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_id) DO UPDATE SET
         client_secret = EXCLUDED.client_secret,
         client_name = EXCLUDED.client_name,
         redirect_uris = EXCLUDED.redirect_uris`,
      [
        client.clientId,
        client.clientSecret ?? null,
        client.clientName ?? null,
        JSON.stringify(client.redirectUris),
        client.createdAt,
      ]
    );
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    await this.ready();
    const res = await this.pool.query("SELECT * FROM oauth_clients WHERE client_id = $1", [clientId]);
    const row = res.rows[0];
    if (!row) return null;
    return {
      clientId: row.client_id,
      clientSecret: row.client_secret ?? undefined,
      clientName: row.client_name ?? undefined,
      redirectUris: JSON.parse(row.redirect_uris || "[]"),
      createdAt: Number(row.created_at),
    };
  }

  // --- Pending Auth ---

  async savePendingAuth(pending: PendingAuth): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO oauth_pending (
         state, client_id, redirect_uri, client_state, code_challenge,
         code_challenge_method, scope, user_id, yandex_callback_uri, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (state) DO UPDATE SET
         client_id = EXCLUDED.client_id,
         redirect_uri = EXCLUDED.redirect_uri,
         client_state = EXCLUDED.client_state,
         code_challenge = EXCLUDED.code_challenge,
         code_challenge_method = EXCLUDED.code_challenge_method,
         scope = EXCLUDED.scope,
         user_id = EXCLUDED.user_id,
         yandex_callback_uri = EXCLUDED.yandex_callback_uri,
         expires_at = EXCLUDED.expires_at`,
      [
        pending.state,
        pending.clientId,
        pending.redirectUri,
        pending.clientState,
        pending.codeChallenge ?? null,
        pending.codeChallengeMethod ?? null,
        pending.scope,
        pending.userId ?? null,
        pending.yandexCallbackUri ?? null,
        pending.createdAt,
        pending.expiresAt,
      ]
    );
  }

  async getPendingAuth(state: string): Promise<PendingAuth | null> {
    await this.ready();
    const res = await this.pool.query("SELECT * FROM oauth_pending WHERE state = $1", [state]);
    const row = res.rows[0];
    if (!row) return null;
    return {
      state: row.state,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      clientState: row.client_state,
      codeChallenge: row.code_challenge ?? undefined,
      codeChallengeMethod: row.code_challenge_method ?? undefined,
      scope: row.scope,
      userId: row.user_id ?? undefined,
      yandexCallbackUri: row.yandex_callback_uri ?? undefined,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  async deletePendingAuth(state: string): Promise<void> {
    await this.ready();
    await this.pool.query("DELETE FROM oauth_pending WHERE state = $1", [state]);
  }

  // --- Auth Codes ---

  async saveAuthCode(code: AuthCode): Promise<void> {
    await this.ready();
    const userId = code.userId || "legacy_user";
    const encAccess = code.yandexAccessToken ? encryptToken(code.yandexAccessToken, userId) : "";
    const encRefresh = code.yandexRefreshToken ? encryptToken(code.yandexRefreshToken, userId) : null;

    await this.pool.query(
      `INSERT INTO oauth_codes (
         code, client_id, redirect_uri, code_challenge, code_challenge_method,
         user_id, yandex_access_token, yandex_refresh_token, yandex_expires_at,
         scope, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        code.code,
        code.clientId,
        code.redirectUri,
        code.codeChallenge ?? null,
        code.codeChallengeMethod ?? null,
        userId,
        encAccess,
        encRefresh,
        code.yandexExpiresAt ?? null,
        code.scope,
        code.createdAt,
        code.expiresAt,
      ]
    );
  }

  async consumeAuthCode(code: string): Promise<AuthCode | null> {
    await this.ready();
    const res = await this.pool.query("DELETE FROM oauth_codes WHERE code = $1 RETURNING *", [code]);
    const row = res.rows[0];
    if (!row) return null;
    if (Number(row.expires_at) < Date.now()) {
      return null;
    }

    const userId = row.user_id || "legacy_user";
    let yandexAccessToken = "";
    let yandexRefreshToken: string | undefined = undefined;

    if (row.yandex_access_token) {
      try {
        yandexAccessToken = decryptToken(row.yandex_access_token, userId);
      } catch {
        yandexAccessToken = row.yandex_access_token;
      }
    }

    if (row.yandex_refresh_token) {
      try {
        yandexRefreshToken = decryptToken(row.yandex_refresh_token, userId);
      } catch {
        yandexRefreshToken = row.yandex_refresh_token;
      }
    }

    return {
      code: row.code,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge ?? undefined,
      codeChallengeMethod: row.code_challenge_method ?? undefined,
      userId: row.user_id ?? undefined,
      yandexAccessToken,
      yandexRefreshToken,
      yandexExpiresAt: row.yandex_expires_at ? Number(row.yandex_expires_at) : undefined,
      scope: row.scope,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  // --- Tokens ---

  async saveToken(token: OAuthTokenRecord): Promise<void> {
    await this.ready();
    const userId = token.userId || "legacy_user";
    const encAccess = encryptToken(token.yandexAccessToken, userId);
    const encRefresh = token.yandexRefreshToken ? encryptToken(token.yandexRefreshToken, userId) : null;

    await this.pool.query(
      `INSERT INTO oauth_tokens (
         access_token, refresh_token, client_id, user_id,
         yandex_access_token, yandex_refresh_token, yandex_expires_at,
         scope, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (access_token) DO UPDATE SET
         refresh_token = EXCLUDED.refresh_token,
         client_id = EXCLUDED.client_id,
         user_id = EXCLUDED.user_id,
         yandex_access_token = EXCLUDED.yandex_access_token,
         yandex_refresh_token = EXCLUDED.yandex_refresh_token,
         yandex_expires_at = EXCLUDED.yandex_expires_at,
         scope = EXCLUDED.scope,
         expires_at = EXCLUDED.expires_at`,
      [
        token.accessToken,
        token.refreshToken ?? null,
        token.clientId,
        userId,
        encAccess,
        encRefresh,
        token.yandexExpiresAt ?? null,
        token.scope,
        token.createdAt,
        token.expiresAt,
      ]
    );
  }

  async getToken(accessToken: string): Promise<OAuthTokenRecord | null> {
    await this.ready();
    const res = await this.pool.query("SELECT * FROM oauth_tokens WHERE access_token = $1", [accessToken]);
    return this.mapTokenRow(res.rows[0]);
  }

  async getTokenByRefreshToken(refreshToken: string): Promise<OAuthTokenRecord | null> {
    await this.ready();
    const res = await this.pool.query("SELECT * FROM oauth_tokens WHERE refresh_token = $1", [refreshToken]);
    return this.mapTokenRow(res.rows[0]);
  }

  private mapTokenRow(row: any): OAuthTokenRecord | null {
    if (!row) return null;
    if (Number(row.expires_at) < Date.now()) {
      return null;
    }

    const userId = row.user_id || "legacy_user";
    let yandexAccessToken = "";
    let yandexRefreshToken: string | undefined = undefined;

    if (row.yandex_access_token) {
      try {
        yandexAccessToken = decryptToken(row.yandex_access_token, userId);
      } catch {
        yandexAccessToken = row.yandex_access_token;
      }
    }

    if (row.yandex_refresh_token) {
      try {
        yandexRefreshToken = decryptToken(row.yandex_refresh_token, userId);
      } catch {
        yandexRefreshToken = row.yandex_refresh_token;
      }
    }

    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token ?? undefined,
      clientId: row.client_id,
      userId: row.user_id ?? undefined,
      yandexAccessToken,
      yandexRefreshToken,
      yandexExpiresAt: row.yandex_expires_at ? Number(row.yandex_expires_at) : undefined,
      scope: row.scope,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  async updateYandexTokens(
    accessToken: string,
    yandexAccessToken: string,
    yandexRefreshToken?: string,
    yandexExpiresAt?: number
  ): Promise<void> {
    await this.ready();
    const existing = await this.getToken(accessToken);
    const userId = existing?.userId || "legacy_user";

    const encAccess = encryptToken(yandexAccessToken, userId);
    const encRefresh = yandexRefreshToken ? encryptToken(yandexRefreshToken, userId) : null;

    await this.pool.query(
      `UPDATE oauth_tokens
       SET yandex_access_token = $1,
           yandex_refresh_token = $2,
           yandex_expires_at = $3
       WHERE access_token = $4`,
      [encAccess, encRefresh, yandexExpiresAt ?? null, accessToken]
    );
  }

  async revokeToken(token: string): Promise<boolean> {
    await this.ready();
    await this.pool.query(
      "DELETE FROM oauth_tokens WHERE access_token = $1 OR refresh_token = $2",
      [token, token]
    );
    return true;
  }

  async listUserGrants(userId: string): Promise<UserGrant[]> {
    await this.ready();
    const query = `
      SELECT t.client_id, c.client_name, t.scope, MIN(t.created_at) as created_at
      FROM oauth_tokens t
      LEFT JOIN oauth_clients c ON t.client_id = c.client_id
      WHERE t.user_id = $1 AND t.expires_at > $2
      GROUP BY t.client_id, c.client_name, t.scope
    `;
    const res = await this.pool.query(query, [userId, Date.now()]);
    return res.rows.map((r) => ({
      clientId: r.client_id,
      clientName: r.client_name ?? undefined,
      scope: r.scope,
      createdAt: Number(r.created_at),
    }));
  }

  async revokeUserGrant(userId: string, clientId: string): Promise<boolean> {
    await this.ready();
    await this.pool.query(
      "DELETE FROM oauth_tokens WHERE user_id = $1 AND client_id = $2",
      [userId, clientId]
    );
    return true;
  }

  async pruneExpired(): Promise<void> {
    await this.ready();
    const now = Date.now();
    await this.pool.query("DELETE FROM oauth_pending WHERE expires_at < $1", [now]);
    await this.pool.query("DELETE FROM oauth_codes WHERE expires_at < $1", [now]);
    await this.pool.query("DELETE FROM oauth_tokens WHERE expires_at < $1", [now]);
    await this.pool.query("DELETE FROM web_sessions WHERE expires_at < $1", [now]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class PostgresTelemetryStorage implements ITelemetryStorage {
  private pool: pg.Pool;
  private initPromise: Promise<void> | null = null;

  constructor(options: PostgresStorageOptions = {}) {
    if (options.pool) {
      this.pool = options.pool;
    } else {
      const connStr = options.connectionString || process.env.DATABASE_URL;
      this.pool = new Pool({
        connectionString: connStr,
        max: 10,
        idleTimeoutMillis: 30000,
        ssl: options.ssl ?? (process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined),
      });
    }

    this.initPromise = this.initTables().catch((err) => {
      console.error("❌ [PostgresTelemetryStorage] Failed to initialize tables:", err);
      throw err;
    });
  }

  public async ready(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  private async initTables(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS telemetry_samples (
        id BIGSERIAL PRIMARY KEY,
        device_id VARCHAR(255) NOT NULL,
        device_name VARCHAR(255) NOT NULL,
        room_name VARCHAR(255),
        metric VARCHAR(100) NOT NULL,
        value DOUBLE PRECISION NOT NULL,
        unit VARCHAR(50),
        timestamp BIGINT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_device_metric_ts ON telemetry_samples(device_id, metric, timestamp ASC);
      CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry_samples(timestamp);
    `);
  }

  async insertSample(sample: TelemetrySample): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO telemetry_samples (device_id, device_name, room_name, metric, value, unit, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sample.deviceId,
        sample.deviceName,
        sample.roomName ?? null,
        sample.metric,
        sample.value,
        sample.unit ?? null,
        sample.timestamp,
      ]
    );
  }

  async insertSamples(samples: TelemetrySample[]): Promise<void> {
    if (!samples.length) return;
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const text = `
        INSERT INTO telemetry_samples (device_id, device_name, room_name, metric, value, unit, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `;
      for (const s of samples) {
        await client.query(text, [
          s.deviceId,
          s.deviceName,
          s.roomName ?? null,
          s.metric,
          s.value,
          s.unit ?? null,
          s.timestamp,
        ]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private getBucketMs(resolution: string): number {
    switch (resolution) {
      case "1m":
        return 60_000;
      case "5m":
        return 300_000;
      case "15m":
        return 900_000;
      case "1h":
        return 3_600_000;
      default:
        return 0;
    }
  }

  async queryHistory(options: QueryHistoryOptions): Promise<TelemetryHistoryResult> {
    await this.ready();
    const { deviceId, from, to } = options;
    const metric = options.metric || "power";
    const resolution = options.resolution || "max";
    const bucketMs = this.getBucketMs(resolution);

    let rows: any[] = [];

    if (bucketMs === 0) {
      if (metric === "all") {
        const res = await this.pool.query(
          `SELECT device_id, device_name, room_name, metric, value, unit, timestamp
           FROM telemetry_samples
           WHERE device_id = $1 AND timestamp >= $2 AND timestamp <= $3
           ORDER BY timestamp ASC`,
          [deviceId, from, to]
        );
        rows = res.rows;
      } else {
        const res = await this.pool.query(
          `SELECT device_id, device_name, room_name, metric, value, unit, timestamp
           FROM telemetry_samples
           WHERE device_id = $1 AND metric = $2 AND timestamp >= $3 AND timestamp <= $4
           ORDER BY timestamp ASC`,
          [deviceId, metric, from, to]
        );
        rows = res.rows;
      }
    } else {
      if (metric === "all") {
        const res = await this.pool.query(
          `SELECT device_id, device_name, room_name, metric, unit,
                  AVG(value) as value, MIN(value) as min_value, MAX(value) as max_value, COUNT(*)::int as sample_count,
                  (CAST(timestamp / $1 AS BIGINT) * $1) as timestamp
           FROM telemetry_samples
           WHERE device_id = $2 AND timestamp >= $3 AND timestamp <= $4
           GROUP BY (CAST(timestamp / $1 AS BIGINT)), device_id, device_name, room_name, metric, unit
           ORDER BY timestamp ASC`,
          [bucketMs, deviceId, from, to]
        );
        rows = res.rows;
      } else {
        const res = await this.pool.query(
          `SELECT device_id, device_name, room_name, metric, unit,
                  AVG(value) as value, MIN(value) as min_value, MAX(value) as max_value, COUNT(*)::int as sample_count,
                  (CAST(timestamp / $1 AS BIGINT) * $1) as timestamp
           FROM telemetry_samples
           WHERE device_id = $2 AND metric = $3 AND timestamp >= $4 AND timestamp <= $5
           GROUP BY (CAST(timestamp / $1 AS BIGINT)), device_id, device_name, room_name, metric, unit
           ORDER BY timestamp ASC`,
          [bucketMs, deviceId, metric, from, to]
        );
        rows = res.rows;
      }
    }

    const first = rows[0];
    const deviceName = first?.device_name || deviceId;
    const roomName = first?.room_name || undefined;
    const unit = first?.unit || (metric === "power" ? "unit.watt" : undefined);

    let minVal: number | null = null;
    let maxVal: number | null = null;
    let sumVal = 0;
    let latestVal: number | null = null;
    const points: HistoryDataPoint[] = [];

    for (const r of rows) {
      const val = Number(r.value);
      const rowMin = r.min_value !== null && r.min_value !== undefined ? Number(r.min_value) : val;
      const rowMax = r.max_value !== null && r.max_value !== undefined ? Number(r.max_value) : val;

      if (minVal === null || rowMin < minVal) minVal = rowMin;
      if (maxVal === null || rowMax > maxVal) maxVal = rowMax;
      sumVal += val;
      latestVal = val;

      points.push({
        timestamp: Number(r.timestamp),
        timeIso: new Date(Number(r.timestamp)).toISOString(),
        value: Math.round(val * 100) / 100,
        minValue: rowMin !== val ? Math.round(rowMin * 100) / 100 : undefined,
        maxValue: rowMax !== val ? Math.round(rowMax * 100) / 100 : undefined,
        sampleCount: r.sample_count ? Number(r.sample_count) : 1,
        metric: r.metric,
        unit: r.unit || unit,
      });
    }

    let totalEnergyKWh: number | undefined = undefined;
    if (metric === "power" && points.length >= 2) {
      let energyJoules = 0;
      for (let i = 1; i < points.length; i++) {
        const dtSec = (points[i].timestamp - points[i - 1].timestamp) / 1000;
        if (dtSec > 0 && dtSec <= 3600) {
          const avgPowerWatts = (points[i].value + points[i - 1].value) / 2;
          energyJoules += avgPowerWatts * dtSec;
        }
      }
      totalEnergyKWh = Math.round((energyJoules / 3_600_000) * 1000) / 1000;
    }

    return {
      deviceId,
      deviceName,
      roomName,
      metric,
      unit,
      from,
      to,
      fromIso: new Date(from).toISOString(),
      toIso: new Date(to).toISOString(),
      resolution,
      count: points.length,
      min: minVal !== null ? Math.round(minVal * 100) / 100 : null,
      max: maxVal !== null ? Math.round(maxVal * 100) / 100 : null,
      avg: points.length > 0 ? Math.round((sumVal / points.length) * 100) / 100 : null,
      latest: latestVal !== null ? Math.round(latestVal * 100) / 100 : null,
      totalEnergyKWh,
      points,
    };
  }

  async saveSamples(samples: TelemetrySample[]): Promise<void> {
    return this.insertSamples(samples);
  }

  async pruneOld(retentionDays = 30): Promise<number> {
    return this.cleanupOldSamples(retentionDays);
  }

  async cleanupOldSamples(retentionDays = 30): Promise<number> {
    await this.ready();
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const res = await this.pool.query("DELETE FROM telemetry_samples WHERE timestamp < $1", [cutoff]);
    return res.rowCount ?? 0;
  }

  async getStats(): Promise<{ totalSamples: number; oldestTimestamp: number | null; newestTimestamp: number | null }> {
    await this.ready();
    const res = await this.pool.query(`
      SELECT COUNT(*)::int as total, MIN(timestamp) as oldest, MAX(timestamp) as newest
      FROM telemetry_samples
    `);
    const r = res.rows[0];
    return {
      totalSamples: r?.total ? Number(r.total) : 0,
      oldestTimestamp: r?.oldest ? Number(r.oldest) : null,
      newestTimestamp: r?.newest ? Number(r.newest) : null,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
