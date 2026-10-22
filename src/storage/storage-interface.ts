export interface UserRecord {
  id: string;
  yandexUid: string;
  login?: string;
  displayName?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UserCredentials {
  yandexAccessToken: string;
  yandexRefreshToken?: string;
  yandexExpiresAt?: number;
  quasarCookie?: string;
  quasarUpdatedAt?: number;
}

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
  userId?: string;
  yandexCallbackUri?: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  userId?: string;
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
  userId?: string;
  yandexAccessToken: string;
  yandexRefreshToken?: string;
  yandexExpiresAt?: number;
  scope: string;
  createdAt: number;
  expiresAt: number;
  /** Shared by every token descended from one authorization code. */
  grantId?: string;
}

/**
 * A redeemed authorization code or a rotated refresh token, kept by digest so
 * that presenting it again can be recognized as reuse of the grant it started.
 */
export interface SpentSecret {
  kind: "code" | "refresh";
  grantId: string;
  clientId: string;
  userId?: string;
  spentAt: number;
  expiresAt: number;
  /** Set once the secret has been presented again after it was spent. */
  reusedAt?: number;
}

/** Maps an oauth_spent_secrets row (SQLite or PostgreSQL) to a SpentSecret. */
export function spentSecretFromRow(row: any): SpentSecret {
  return {
    kind: row.kind,
    grantId: row.grant_id,
    clientId: row.client_id,
    userId: row.user_id ?? undefined,
    spentAt: Number(row.spent_at),
    expiresAt: Number(row.expires_at),
    reusedAt: row.reused_at == null ? undefined : Number(row.reused_at),
  };
}

export interface UserGrant {
  clientId: string;
  clientName?: string;
  scope: string;
  createdAt: number;
}

export interface IStorage {
  // Users & credentials
  saveUser(user: UserRecord): Promise<void> | void;
  getUser(userId: string): Promise<UserRecord | null> | (UserRecord | null);
  getUserByYandexUid(yandexUid: string): Promise<UserRecord | null> | (UserRecord | null);
  saveUserCredentials(userId: string, creds: UserCredentials): Promise<void> | void;
  getUserCredentials(userId: string): Promise<UserCredentials | null> | (UserCredentials | null);
  deleteUserCredentials(userId: string): Promise<void> | void;
  deleteUser(userId: string): Promise<void> | void;

  saveBrowserTransaction(key: string, payload: string, expiresAt: number): Promise<void> | void;
  getBrowserTransaction(key: string): Promise<string | null> | string | null;
  deleteBrowserTransaction(key: string): Promise<void> | void;

  // Web sessions
  saveWebSession(sessionId: string, userId: string, expiresAt: number): Promise<void> | void;
  getWebSession(sessionId: string): Promise<{ userId: string } | null> | ({ userId: string } | null);
  deleteWebSession(sessionId: string): Promise<void> | void;

  // Quasar scenarios
  saveQuasarScenario(userId: string, deviceId: string, scenarioId: string, scenarioName?: string): Promise<void> | void;
  getQuasarScenario(userId: string, deviceId: string): Promise<string | null> | (string | null);
  listQuasarScenarios(userId: string): Promise<Array<{ deviceId: string; scenarioId: string; scenarioName?: string }>> | Array<{ deviceId: string; scenarioId: string; scenarioName?: string }>;
  deleteQuasarScenarios(userId: string): Promise<void> | void;

  // OAuth Clients
  saveClient(client: OAuthClient): Promise<void> | void;
  getClient(clientId: string): Promise<OAuthClient | null> | (OAuthClient | null);

  // Pending Auth
  savePendingAuth(pending: PendingAuth): Promise<void> | void;
  getPendingAuth(state: string): Promise<PendingAuth | null> | (PendingAuth | null);
  deletePendingAuth(state: string): Promise<void> | void;

  // Auth Codes
  saveAuthCode(code: AuthCode): Promise<void> | void;
  // With `spend`, a valid code is atomically replaced by a SpentSecret of kind
  // "code" for that grant, kept until `spend.keepUntil`.
  consumeAuthCode(code: string, spend?: { grantId: string; keepUntil: number }): Promise<AuthCode | null> | (AuthCode | null);

  // Tokens
  saveToken(token: OAuthTokenRecord): Promise<void> | void;
  // Secrets are stored as digests: both getters return the presented secret in
  // clear text and the other one only as an opaque stored handle, so never pass
  // the other field back as a secret (e.g. to revokeToken).
  getToken(accessToken: string): Promise<OAuthTokenRecord | null> | (OAuthTokenRecord | null);
  getTokenByRefreshToken(refreshToken: string): Promise<OAuthTokenRecord | null> | (OAuthTokenRecord | null);
  revokeToken(token: string): Promise<boolean> | boolean;

  // Reuse detection
  recordSpentSecret(secret: string, spent: SpentSecret): Promise<void> | void;
  getSpentSecret(secret: string): Promise<SpentSecret | null> | (SpentSecret | null);
  /** Marks a live spent secret as presented again and returns it; null when it is unknown or expired. */
  flagSpentSecretReuse(secret: string): Promise<SpentSecret | null> | (SpentSecret | null);
  /** Revokes every token of one grant; true when any was revoked. */
  revokeGrantFamily(grantId: string): Promise<boolean> | boolean;

  // Token update & grants
  updateYandexTokens?(
    accessToken: string,
    yandexAccessToken: string,
    yandexRefreshToken?: string,
    yandexExpiresAt?: number
  ): Promise<void> | void;
  listUserGrants?(userId: string): Promise<UserGrant[]> | UserGrant[];
  revokeUserGrant(userId: string, clientId: string): Promise<boolean> | boolean;
  pruneExpired?(): Promise<void> | void;

  close?(): Promise<void> | void;
}


export class CredentialDecryptionError extends Error {
  constructor() { super("Saved credentials cannot be decrypted; reconnect your Yandex account"); this.name = "CredentialDecryptionError"; }
}

/** Distinguish storage failure from a successfully observed missing record. */
export class StorageUnavailableError extends Error {
  constructor() { super("Credential storage unavailable"); this.name = "StorageUnavailableError"; }
}

export function guardedStorage(storage: IStorage): IStorage {
  return new Proxy(storage, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try { return await value.apply(target, args); }
        catch (error) { if (error instanceof CredentialDecryptionError) throw error; throw new StorageUnavailableError(); }
      };
    },
  });
}
