import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: number;
}

export interface PendingAuth {
  state: string;
  clientId: string;
  redirectUri: string;
  clientState: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  yandexAccessToken: string;
  yandexRefreshToken?: string;
  yandexExpiresAt?: number;
  scope: string;
  createdAt: number;
  expiresAt: number;
}

export interface OAuthTokenRecord {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  yandexAccessToken: string;
  yandexRefreshToken?: string;
  yandexExpiresAt?: number;
  scope: string;
  createdAt: number;
  expiresAt: number;
}

export class OAuthStorage {
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
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT,
        code_challenge_method TEXT,
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
    `);
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
      INSERT OR REPLACE INTO oauth_pending (state, client_id, redirect_uri, client_state, code_challenge, code_challenge_method, scope, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getPendingStmt = this.db.prepare(`
      SELECT state, client_id, redirect_uri, client_state, code_challenge, code_challenge_method, scope, created_at, expires_at
      FROM oauth_pending WHERE state = ?
    `);

    this.deletePendingStmt = this.db.prepare(`
      DELETE FROM oauth_pending WHERE state = ?
    `);

    this.insertCodeStmt = this.db.prepare(`
      INSERT OR REPLACE INTO oauth_codes (code, client_id, redirect_uri, code_challenge, code_challenge_method, yandex_access_token, yandex_refresh_token, yandex_expires_at, scope, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getCodeStmt = this.db.prepare(`
      SELECT code, client_id, redirect_uri, code_challenge, code_challenge_method, yandex_access_token, yandex_refresh_token, yandex_expires_at, scope, created_at, expires_at
      FROM oauth_codes WHERE code = ?
    `);

    this.deleteCodeStmt = this.db.prepare(`
      DELETE FROM oauth_codes WHERE code = ?
    `);

    this.insertTokenStmt = this.db.prepare(`
      INSERT OR REPLACE INTO oauth_tokens (access_token, refresh_token, client_id, yandex_access_token, yandex_refresh_token, yandex_expires_at, scope, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getTokenStmt = this.db.prepare(`
      SELECT access_token, refresh_token, client_id, yandex_access_token, yandex_refresh_token, yandex_expires_at, scope, created_at, expires_at
      FROM oauth_tokens WHERE access_token = ?
    `);

    this.getTokenByRefreshStmt = this.db.prepare(`
      SELECT access_token, refresh_token, client_id, yandex_access_token, yandex_refresh_token, yandex_expires_at, scope, created_at, expires_at
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
  }

  // Client management
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

  // Pending authorization flow
  savePendingAuth(pending: PendingAuth): void {
    this.insertPendingStmt.run(
      pending.state,
      pending.clientId,
      pending.redirectUri,
      pending.clientState,
      pending.codeChallenge || null,
      pending.codeChallengeMethod || null,
      pending.scope,
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
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  deletePendingAuth(state: string): void {
    this.deletePendingStmt.run(state);
  }

  // Auth codes
  saveAuthCode(code: AuthCode): void {
    this.insertCodeStmt.run(
      code.code,
      code.clientId,
      code.redirectUri,
      code.codeChallenge || null,
      code.codeChallengeMethod || null,
      code.yandexAccessToken,
      code.yandexRefreshToken || null,
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
    return {
      code: row.code,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge || undefined,
      codeChallengeMethod: row.code_challenge_method || undefined,
      yandexAccessToken: row.yandex_access_token,
      yandexRefreshToken: row.yandex_refresh_token || undefined,
      yandexExpiresAt: row.yandex_expires_at || undefined,
      scope: row.scope,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  // Tokens
  saveToken(token: OAuthTokenRecord): void {
    this.insertTokenStmt.run(
      token.accessToken,
      token.refreshToken || null,
      token.clientId,
      token.yandexAccessToken,
      token.yandexRefreshToken || null,
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
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token || undefined,
      clientId: row.client_id,
      yandexAccessToken: row.yandex_access_token,
      yandexRefreshToken: row.yandex_refresh_token || undefined,
      yandexExpiresAt: row.yandex_expires_at || undefined,
      scope: row.scope,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  getTokenByRefreshToken(refreshToken: string): OAuthTokenRecord | null {
    const row = this.getTokenByRefreshStmt.get(refreshToken) as any;
    if (!row) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token || undefined,
      clientId: row.client_id,
      yandexAccessToken: row.yandex_access_token,
      yandexRefreshToken: row.yandex_refresh_token || undefined,
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
    this.updateYandexTokenStmt.run(
      yandexAccessToken,
      yandexRefreshToken || null,
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
