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
  consumeAuthCode(code: string): Promise<AuthCode | null> | (AuthCode | null);

  // Tokens
  saveToken(token: OAuthTokenRecord): Promise<void> | void;
  getToken(accessToken: string): Promise<OAuthTokenRecord | null> | (OAuthTokenRecord | null);
  getTokenByRefreshToken(refreshToken: string): Promise<OAuthTokenRecord | null> | (OAuthTokenRecord | null);
  revokeToken(token: string): Promise<boolean> | boolean;

  // Token update & grants
  updateYandexTokens?(
    accessToken: string,
    yandexAccessToken: string,
    yandexRefreshToken?: string,
    yandexExpiresAt?: number
  ): Promise<void> | void;
  listUserGrants?(userId: string): Promise<UserGrant[]> | UserGrant[];
  revokeUserGrant?(userId: string, clientId: string): Promise<boolean> | boolean;
  pruneExpired?(): Promise<void> | void;

  close?(): Promise<void> | void;
}

