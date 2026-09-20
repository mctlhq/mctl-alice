import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { encryptToken, decryptToken, hashToken } from "./crypto.js";

import {
  IStorage,
  UserRecord,
  UserCredentials,
  OAuthClient,
  PendingAuth,
  AuthCode,
  OAuthTokenRecord,
} from "./storage-interface.js";

export {
  IStorage,
  UserRecord,
  UserCredentials,
  OAuthClient,
  PendingAuth,
  AuthCode,
  OAuthTokenRecord,
};

export class OAuthStorage implements IStorage {
  private db: DatabaseSync;
  private insertClientStmt!: StatementSync;
  private getClientStmt!: StatementSync;
  private insertPendingStmt!: StatementSync;
  private getPendingStmt!: StatementSync;
  private deletePendingStmt!: StatementSync;
  private insertCodeStmt!: StatementSync;
  private getCodeStmt!: StatementSync;
  private deleteCodeStmt!: StatementSync;
  private insertTokenStmt!: StatementSync;
  private getTokenStmt!: StatementSync;
  private getTokenByRefreshStmt!: StatementSync;
  private deleteTokenStmt!: StatementSync;
  private updateYandexTokenStmt!: StatementSync;

  // User & credentials statements
  private insertUserStmt!: StatementSync;
  private getUserStmt!: StatementSync;
  private getUserByYandexUidStmt!: StatementSync;
  private insertUserCredsStmt!: StatementSync;
  private getUserCredsStmt!: StatementSync;
  private deleteUserCredsStmt!: StatementSync;
  private deleteUserStmt!: StatementSync;

  // Web sessions
  private insertWebSessionStmt!: StatementSync;
  private getWebSessionStmt!: StatementSync;
  private deleteWebSessionStmt!: StatementSync;
  private pruneWebSessionsStmt!: StatementSync;

  // Quasar scenarios
  private insertQuasarScenarioStmt!: StatementSync;
  private getQuasarScenarioStmt!: StatementSync;
  private listQuasarScenariosStmt!: StatementSync;
  private deleteQuasarScenariosStmt!: StatementSync;

  // Grants management
  private listUserGrantsStmt!: StatementSync;
  private deleteUserClientTokensStmt!: StatementSync;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || process.env.OAUTH_DB_PATH || "./data/oauth.db";

    if (resolvedPath !== ":memory:") {
      const dir = path.dirname(path.resolve(resolvedPath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(resolvedPath);
    this.initTables();
    this.prepareStatements();
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        yandex_uid TEXT UNIQUE NOT NULL,
        login TEXT,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_credentials (
        user_id TEXT PRIMARY KEY,
        encrypted_yandex_access_token TEXT NOT NULL,
        encrypted_yandex_refresh_token TEXT,
        yandex_expires_at INTEGER,
        encrypted_quasar_cookie TEXT,
        quasar_updated_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS web_sessions (
        session_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS quasar_proxy_scenarios (
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        scenario_name TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret TEXT,
        client_name TEXT,
        redirect_uris TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_pending (
        state TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        client_state TEXT NOT NULL,
        code_challenge TEXT,
        code_challenge_method TEXT,
        scope TEXT NOT NULL,
        user_id TEXT,
        yandex_callback_uri TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT,
        code_challenge_method TEXT,
        user_id TEXT,
        yandex_access_token TEXT NOT NULL,
        yandex_refresh_token TEXT,
        yandex_expires_at INTEGER,
        scope TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        access_token TEXT PRIMARY KEY,
        refresh_token TEXT UNIQUE,
        client_id TEXT NOT NULL,
        user_id TEXT,
        yandex_access_token TEXT NOT NULL,
        yandex_refresh_token TEXT,
        yandex_expires_at INTEGER,
        scope TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pending_expires ON oauth_pending(expires_at);
      CREATE INDEX IF NOT EXISTS idx_codes_expires ON oauth_codes(expires_at);
      CREATE INDEX IF NOT EXISTS idx_tokens_expires ON oauth_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);
    `);

    // Migrations for existing databases
    try {
      this.db.exec(`ALTER TABLE oauth_pending ADD COLUMN yandex_callback_uri TEXT;`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE oauth_pending ADD COLUMN user_id TEXT;`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE oauth_codes ADD COLUMN user_id TEXT;`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE oauth_tokens ADD COLUMN user_id TEXT;`);
    } catch {
      // Column already exists
    }

    // Indexes on migrated columns
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tokens_user ON oauth_tokens(user_id);`);
    } catch {
      // Ignore if cannot index
    }
  }

  private prepareStatements() {
    this.insertClientStmt = this.db.prepare(`
      INSERT OR REPLACE INTO oauth_clients (client_id, client_secret, client_name, redirect_uris, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.getClientStmt = this.db.prepare(`
      SELECT client_id, client_secret, client_name, redirect_uris, created_at
      FROM oauth_clients WHERE client_id = ?
    `);

    this.insertPendingStmt = this.db.prepare(`
      INSERT OR REPLACE INTO oauth_pending (state, client_id, redirect_uri, client_state, code_challenge, code_challenge_method, scope, user_id, yandex_callback_uri, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getPendingStmt = this.db.prepare(`
      SELECT state, client_id, redirect_uri, client_state, code_challenge, code_challenge_method, scope, user_id, yandex_callback_uri, created_at, expires_at
      FROM oauth_pending WHERE state = ?
    `);

    this.deletePendingStmt = this.db.prepare(`
      DELETE FROM oauth_pending WHERE state = ?
    `);

    this.insertCodeStmt = this.db.prepare(`
      INSERT OR REPLACE INTO oauth_codes (code, client_id, redirect_uri, code_challenge, code_challenge_method, user_id, yandex_access_token, yandex_refresh_token, yandex_expires_at, scope, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getCodeStmt = this.db.prepare(`
      SELECT code, client_id, redirect_uri, code_challenge, code_challenge_method, user_id, yandex_access_token, yandex_refresh_token, yandex_expires_at, scope, created_at, expires_at
      FROM oauth_codes WHERE code = ?
    `);

    this.deleteCodeStmt = this.db.prepare(`
      DELETE FROM oauth_codes WHERE code = ?
    `);

    this.insertTokenStmt = this.db.prepare(`
      INSERT OR REPLACE INTO oauth_tokens (access_token, refresh_token, client_id, user_id, yandex_access_token, yandex_refresh_token, yandex_expires_at, scope, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getTokenStmt = this.db.prepare(`
      SELECT access_token, refresh_token, client_id, user_id, yandex_access_token, yandex_refresh_token, yandex_expires_at, scope, created_at, expires_at
      FROM oauth_tokens WHERE access_token = ?
    `);

    this.getTokenByRefreshStmt = this.db.prepare(`
      SELECT access_token, refresh_token, client_id, user_id, yandex_access_token, yandex_refresh_token, yandex_expires_at, scope, created_at, expires_at
      FROM oauth_tokens WHERE refresh_token = ?
    `);

    this.deleteTokenStmt = this.db.prepare(`
      DELETE FROM oauth_tokens WHERE access_token = ? OR refresh_token = ?
    `);

    this.updateYandexTokenStmt = this.db.prepare(`
      UPDATE oauth_tokens
      SET yandex_access_token = ?, yandex_refresh_token = ?, yandex_expires_at = ?
      WHERE access_token = ?
    `);

    // Users & credentials
    this.insertUserStmt = this.db.prepare(`
      INSERT INTO users (id, yandex_uid, login, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        login = excluded.login,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
      ON CONFLICT(yandex_uid) DO UPDATE SET
        login = excluded.login,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
    `);

    this.getUserStmt = this.db.prepare(`
      SELECT id, yandex_uid, login, display_name, created_at, updated_at
      FROM users WHERE id = ?
    `);

    this.getUserByYandexUidStmt = this.db.prepare(`
      SELECT id, yandex_uid, login, display_name, created_at, updated_at
      FROM users WHERE yandex_uid = ?
    `);

    this.insertUserCredsStmt = this.db.prepare(`
      INSERT OR REPLACE INTO user_credentials (user_id, encrypted_yandex_access_token, encrypted_yandex_refresh_token, yandex_expires_at, encrypted_quasar_cookie, quasar_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getUserCredsStmt = this.db.prepare(`
      SELECT user_id, encrypted_yandex_access_token, encrypted_yandex_refresh_token, yandex_expires_at, encrypted_quasar_cookie, quasar_updated_at, created_at, updated_at
      FROM user_credentials WHERE user_id = ?
    `);

    this.deleteUserCredsStmt = this.db.prepare(`
      DELETE FROM user_credentials WHERE user_id = ?
    `);

    this.deleteUserStmt = this.db.prepare(`
      DELETE FROM users WHERE id = ?
    `);

    // Web sessions
    this.insertWebSessionStmt = this.db.prepare(`
      INSERT OR REPLACE INTO web_sessions (session_hash, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `);

    this.getWebSessionStmt = this.db.prepare(`
      SELECT session_hash, user_id, created_at, expires_at
      FROM web_sessions WHERE session_hash = ?
    `);

    this.deleteWebSessionStmt = this.db.prepare(`
      DELETE FROM web_sessions WHERE session_hash = ?
    `);

    this.pruneWebSessionsStmt = this.db.prepare(`
      DELETE FROM web_sessions WHERE expires_at < ?
    `);

    // Quasar scenarios
    this.insertQuasarScenarioStmt = this.db.prepare(`
      INSERT OR REPLACE INTO quasar_proxy_scenarios (user_id, device_id, scenario_id, scenario_name, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.getQuasarScenarioStmt = this.db.prepare(`
      SELECT scenario_id FROM quasar_proxy_scenarios
      WHERE user_id = ? AND device_id = ?
    `);

    this.listQuasarScenariosStmt = this.db.prepare(`
      SELECT device_id, scenario_id, scenario_name FROM quasar_proxy_scenarios
      WHERE user_id = ?
    `);

    this.deleteQuasarScenariosStmt = this.db.prepare(`
      DELETE FROM quasar_proxy_scenarios WHERE user_id = ?
    `);

    // User grants
    this.listUserGrantsStmt = this.db.prepare(`
      SELECT t.client_id, c.client_name, t.scope, t.created_at
      FROM oauth_tokens t
      LEFT JOIN oauth_clients c ON t.client_id = c.client_id
      WHERE t.user_id = ?
      GROUP BY t.client_id
    `);

    this.deleteUserClientTokensStmt = this.db.prepare(`
      DELETE FROM oauth_tokens WHERE user_id = ? AND client_id = ?
    `);
  }

  // --- User & Credentials Management ---

  saveUser(user: UserRecord): void {
    this.insertUserStmt.run(
      user.id,
      user.yandexUid,
      user.login || null,
      user.displayName || null,
      user.createdAt,
      user.updatedAt
    );
  }

  getUser(userId: string): UserRecord | null {
    const row = this.getUserStmt.get(userId) as any;
    if (!row) return null;
    return {
      id: row.id,
      yandexUid: row.yandex_uid,
      login: row.login || undefined,
      displayName: row.display_name || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getUserByYandexUid(yandexUid: string): UserRecord | null {
    const row = this.getUserByYandexUidStmt.get(yandexUid) as any;
    if (!row) return null;
    return {
      id: row.id,
      yandexUid: row.yandex_uid,
      login: row.login || undefined,
      displayName: row.display_name || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  saveUserCredentials(userId: string, creds: UserCredentials): void {
    const existing = this.getUserCredentials(userId);
    const now = Date.now();
    const createdAt = existing ? now : now;

    // Encrypt tokens using user-bound AAD
    const encryptedAccess = encryptToken(creds.yandexAccessToken, userId);
    const encryptedRefresh = creds.yandexRefreshToken
      ? encryptToken(creds.yandexRefreshToken, userId)
      : null;
    const encryptedQuasar = creds.quasarCookie
      ? encryptToken(creds.quasarCookie, userId)
      : existing?.quasarCookie
      ? encryptToken(existing.quasarCookie, userId)
      : null;
    const quasarUpdated = creds.quasarCookie ? now : existing?.quasarUpdatedAt || null;

    this.insertUserCredsStmt.run(
      userId,
      encryptedAccess,
      encryptedRefresh,
      creds.yandexExpiresAt || null,
      encryptedQuasar,
      quasarUpdated,
      createdAt,
      now
    );
  }

  getUserCredentials(userId: string): UserCredentials | null {
    const row = this.getUserCredsStmt.get(userId) as any;
    if (!row) return null;

    try {
      const yandexAccessToken = decryptToken(row.encrypted_yandex_access_token, userId);
      const yandexRefreshToken = row.encrypted_yandex_refresh_token
        ? decryptToken(row.encrypted_yandex_refresh_token, userId)
        : undefined;
      const quasarCookie = row.encrypted_quasar_cookie
        ? decryptToken(row.encrypted_quasar_cookie, userId)
        : undefined;

      return {
        yandexAccessToken,
        yandexRefreshToken,
        yandexExpiresAt: row.yandex_expires_at || undefined,
        quasarCookie,
        quasarUpdatedAt: row.quasar_updated_at || undefined,
      };
    } catch (err) {
      // If decryption fails (e.g. key mismatch), return null
      return null;
    }
  }

  deleteUserCredentials(userId: string): void {
    this.deleteUserCredsStmt.run(userId);
  }

  // --- Web Sessions ---

  saveWebSession(sessionId: string, userId: string, expiresAt: number): void {
    const hash = hashToken(sessionId);
    this.insertWebSessionStmt.run(hash, userId, Date.now(), expiresAt);
  }

  getWebSession(sessionId: string): { userId: string } | null {
    const hash = hashToken(sessionId);
    const row = this.getWebSessionStmt.get(hash) as any;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.deleteWebSession(sessionId);
      return null;
    }
    return { userId: row.user_id };
  }

  deleteWebSession(sessionId: string): void {
    const hash = hashToken(sessionId);
    this.deleteWebSessionStmt.run(hash);
  }

  pruneExpiredWebSessions(): void {
    this.pruneWebSessionsStmt.run(Date.now());
  }

  // --- Quasar Scenarios ---

  saveQuasarScenario(userId: string, deviceId: string, scenarioId: string, scenarioName?: string): void {
    this.insertQuasarScenarioStmt.run(userId, deviceId, scenarioId, scenarioName || null, Date.now());
  }

  getQuasarScenario(userId: string, deviceId: string): string | null {
    const row = this.getQuasarScenarioStmt.get(userId, deviceId) as any;
    return row ? row.scenario_id : null;
  }

  listQuasarScenarios(userId: string): Array<{ deviceId: string; scenarioId: string; scenarioName?: string }> {
    const rows = this.listQuasarScenariosStmt.all(userId) as any[];
    return rows.map((r) => ({
      deviceId: r.device_id,
      scenarioId: r.scenario_id,
      scenarioName: r.scenario_name || undefined,
    }));
  }

  deleteQuasarScenarios(userId: string): void {
    this.deleteQuasarScenariosStmt.run(userId);
  }

  // --- Grants & Revocation ---

  listUserGrants(userId: string): Array<{ clientId: string; clientName?: string; scope: string; createdAt: number }> {
    const rows = this.listUserGrantsStmt.all(userId) as any[];
    return rows.map((r) => ({
      clientId: r.client_id,
      clientName: r.client_name || undefined,
      scope: r.scope,
      createdAt: r.created_at,
    }));
  }

  revokeUserClientGrants(userId: string, clientId: string): void {
    this.deleteUserClientTokensStmt.run(userId, clientId);
  }

  deleteUser(userId: string): void {
    this.db.exec("BEGIN TRANSACTION;");
    try {
      this.deleteUserCredsStmt.run(userId);
      this.deleteQuasarScenariosStmt.run(userId);
      this.db.prepare("DELETE FROM web_sessions WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM oauth_codes WHERE user_id = ?").run(userId);
      this.deleteUserStmt.run(userId);
      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  // --- Client Management ---

  saveClient(client: OAuthClient): void {
    this.insertClientStmt.run(
      client.clientId,
      client.clientSecret || null,
      client.clientName || null,
      JSON.stringify(client.redirectUris),
      client.createdAt
    );
  }

  getClient(clientId: string): OAuthClient | null {
    const row = this.getClientStmt.get(clientId) as any;
    if (!row) return null;
    return {
      clientId: row.client_id,
      clientSecret: row.client_secret || undefined,
      clientName: row.client_name || undefined,
      redirectUris: JSON.parse(row.redirect_uris || "[]"),
      createdAt: row.created_at,
    };
  }

  // --- Pending Authorization Flow ---

  savePendingAuth(pending: PendingAuth): void {
    this.insertPendingStmt.run(
      pending.state,
      pending.clientId,
      pending.redirectUri,
      pending.clientState,
      pending.codeChallenge || null,
      pending.codeChallengeMethod || null,
      pending.scope,
      pending.userId || null,
      pending.yandexCallbackUri || null,
      pending.createdAt,
      pending.expiresAt
    );
  }

  getPendingAuth(state: string): PendingAuth | null {
    const row = this.getPendingStmt.get(state) as any;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.deletePendingStmt.run(state);
      return null;
    }
    return {
      state: row.state,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      clientState: row.client_state,
      codeChallenge: row.code_challenge || undefined,
      codeChallengeMethod: row.code_challenge_method || undefined,
      scope: row.scope,
      userId: row.user_id || undefined,
      yandexCallbackUri: row.yandex_callback_uri || undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  deletePendingAuth(state: string): void {
    this.deletePendingStmt.run(state);
  }

  // --- Auth Codes (One-Time Use) ---

  saveAuthCode(code: AuthCode): void {
    const userId = code.userId || "legacy_user";
    const encryptedAccess = code.yandexAccessToken ? encryptToken(code.yandexAccessToken, userId) : "";
    const encryptedRefresh = code.yandexRefreshToken ? encryptToken(code.yandexRefreshToken, userId) : null;

    this.insertCodeStmt.run(
      code.code,
      code.clientId,
      code.redirectUri,
      code.codeChallenge || null,
      code.codeChallengeMethod || null,
      userId,
      encryptedAccess,
      encryptedRefresh,
      code.yandexExpiresAt || null,
      code.scope,
      code.createdAt,
      code.expiresAt
    );
  }

  consumeAuthCode(code: string): AuthCode | null {
    const row = this.getCodeStmt.get(code) as any;
    if (!row) return null;
    this.deleteCodeStmt.run(code);
    if (row.expires_at < Date.now()) {
      return null;
    }

    const userId = row.user_id || "legacy_user";
    let yandexAccessToken = "";
    let yandexRefreshToken: string | undefined = undefined;

    if (row.yandex_access_token) {
      try {
        yandexAccessToken = decryptToken(row.yandex_access_token, userId);
      } catch {
        yandexAccessToken = row.yandex_access_token; // Plaintext fallback for legacy rows
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
      codeChallenge: row.code_challenge || undefined,
      codeChallengeMethod: row.code_challenge_method || undefined,
      userId: row.user_id || undefined,
      yandexAccessToken,
      yandexRefreshToken,
      yandexExpiresAt: row.yandex_expires_at || undefined,
      scope: row.scope,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  // --- Tokens ---

  saveToken(token: OAuthTokenRecord): void {
    const userId = token.userId || "legacy_user";
    const encryptedAccess = token.yandexAccessToken ? encryptToken(token.yandexAccessToken, userId) : "";
    const encryptedRefresh = token.yandexRefreshToken ? encryptToken(token.yandexRefreshToken, userId) : null;

    this.insertTokenStmt.run(
      token.accessToken,
      token.refreshToken || null,
      token.clientId,
      userId,
      encryptedAccess,
      encryptedRefresh,
      token.yandexExpiresAt || null,
      token.scope,
      token.createdAt,
      token.expiresAt
    );
  }

  getToken(accessToken: string): OAuthTokenRecord | null {
    const row = this.getTokenStmt.get(accessToken) as any;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
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
      refreshToken: row.refresh_token || undefined,
      clientId: row.client_id,
      userId: row.user_id || undefined,
      yandexAccessToken,
      yandexRefreshToken,
      yandexExpiresAt: row.yandex_expires_at || undefined,
      scope: row.scope,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  getTokenByRefreshToken(refreshToken: string): OAuthTokenRecord | null {
    const row = this.getTokenByRefreshStmt.get(refreshToken) as any;
    if (!row) return null;

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
      refreshToken: row.refresh_token || undefined,
      clientId: row.client_id,
      userId: row.user_id || undefined,
      yandexAccessToken,
      yandexRefreshToken,
      yandexExpiresAt: row.yandex_expires_at || undefined,
      scope: row.scope,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  updateYandexTokens(
    accessToken: string,
    yandexAccessToken: string,
    yandexRefreshToken?: string,
    yandexExpiresAt?: number
  ): void {
    const existing = this.getToken(accessToken);
    const userId = existing?.userId || "legacy_user";

    const encAccess = encryptToken(yandexAccessToken, userId);
    const encRefresh = yandexRefreshToken ? encryptToken(yandexRefreshToken, userId) : null;

    this.updateYandexTokenStmt.run(
      encAccess,
      encRefresh,
      yandexExpiresAt || null,
      accessToken
    );
  }

  revokeToken(token: string): boolean {
    this.deleteTokenStmt.run(token, token);
    return true;
  }

  close(): void {
    this.db.close();
  }
}
