import {
  getMacKeychain,
  saveTokenToKeychain,
  refreshAccessToken,
  saveTokenToEnvFile,
  saveRefreshTokenToEnvFile,
} from "../auth/token-storage.js";
import {
  YandexUserInfo,
  DeviceActionRequest,
  DeviceActionResponse,
  ScenarioActionResponse,
} from "./types.js";

export interface YandexIoTClientOptions {
  useKeychain?: boolean;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  autoRefresh?: boolean;
  persistEnv?: boolean;
  envFilePath?: string;
}

export class YandexApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public responseBody?: any
  ) {
    super(message);
    this.name = "YandexApiError";
  }
}

export class YandexIoTClient {
  private baseUrl = "https://api.iot.yandex.net/v1.0";
  private token: string;
  private refreshToken: string | null = null;
  private clientId: string | null = null;
  private clientSecret: string | null = null;
  private autoRefresh: boolean;
  private useKeychain: boolean;
  private persistEnv: boolean;
  private envFilePath?: string;

  constructor(token?: string, options: YandexIoTClientOptions = {}) {
    this.useKeychain = options.useKeychain ?? true;
    this.autoRefresh = options.autoRefresh ?? true;
    this.persistEnv = options.persistEnv ?? true;
    this.envFilePath = options.envFilePath;

    const resolvedToken =
      token ||
      process.env.YANDEX_OAUTH_TOKEN ||
      (this.useKeychain ? getMacKeychain("mctl-alice") : null);

    if (!resolvedToken) {
      throw new YandexApiError(
        "Yandex OAuth token is missing. Please provide it in YANDEX_OAUTH_TOKEN env variable, macOS Keychain, or pass it directly."
      );
    }
    // Clean token if user prefixed with 'Bearer ' or quotes
    this.token = resolvedToken.trim().replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "");

    this.refreshToken =
      options.refreshToken ||
      process.env.YANDEX_REFRESH_TOKEN ||
      (this.useKeychain ? getMacKeychain("mctl-alice-refresh-token") : null);

    this.clientId =
      options.clientId ||
      process.env.YANDEX_CLIENT_ID ||
      (this.useKeychain ? getMacKeychain("mctl-alice-client-id") : null);

    this.clientSecret =
      options.clientSecret ||
      process.env.YANDEX_CLIENT_SECRET ||
      (this.useKeychain ? getMacKeychain("mctl-alice-client-secret") : null);
  }

  private async request<T>(
    endpoint: string,
    options: {
      method?: string;
      body?: any;
    } = {},
    isRetry = false
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      const responseText = await response.text();
      let responseData: any;
      try {
        responseData = responseText ? JSON.parse(responseText) : {};
      } catch {
        responseData = { text: responseText };
      }

      if (!response.ok) {
        if (response.status === 401) {
          if (
            !isRetry &&
            this.autoRefresh &&
            this.refreshToken &&
            this.clientId &&
            this.clientSecret
          ) {
            try {
              const newTokens = await refreshAccessToken({
                refreshToken: this.refreshToken,
                clientId: this.clientId,
                clientSecret: this.clientSecret,
              });

              this.token = newTokens.access_token;
              if (newTokens.refresh_token) {
                this.refreshToken = newTokens.refresh_token;
              }

              if (this.useKeychain) {
                saveTokenToKeychain(this.token, "mctl-alice");
                if (this.refreshToken) {
                  saveTokenToKeychain(this.refreshToken, "mctl-alice-refresh-token");
                }
              }

              if (this.persistEnv) {
                try {
                  saveTokenToEnvFile(this.token, this.envFilePath);
                  if (this.refreshToken) {
                    saveRefreshTokenToEnvFile(this.refreshToken, this.envFilePath);
                  }
                } catch {
                  // Ignore env file write errors
                }
              }

              // Retry request with newly acquired access token
              return await this.request<T>(endpoint, options, true);
            } catch (refreshErr: any) {
              throw new YandexApiError(
                `Unauthorized (401): The Yandex OAuth token has expired and auto-refresh failed: ${refreshErr.message}. Run 'npm run auth' or visit http://localhost:8080/auth/login to re-authenticate.`,
                401,
                responseData
              );
            }
          }

          throw new YandexApiError(
            "Unauthorized (401): The Yandex OAuth token is invalid or expired. Run 'npm run auth' or visit http://localhost:8080/auth/login to re-authenticate.",
            response.status,
            responseData
          );
        }

        if (response.status === 403) {
          throw new YandexApiError(
            "Forbidden (403): Token lacks 'iot:view' or 'iot:control' permissions.",
            response.status,
            responseData
          );
        }

        const errorMsg =
          responseData?.message ||
          responseData?.error_code ||
          `HTTP request failed with status ${response.status}`;
        throw new YandexApiError(errorMsg, response.status, responseData);
      }

      return responseData as T;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new YandexApiError("Request timed out after 15 seconds", 408);
      }
      if (err instanceof YandexApiError) {
        throw err;
      }
      throw new YandexApiError(`Network or request error: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get user smart home tree: devices, rooms, groups, scenarios
   */
  async getUserInfo(): Promise<YandexUserInfo> {
    return this.request<YandexUserInfo>("/user/info");
  }

  /**
   * Execute actions on devices (e.g. text_action, phrase_action, volume, on_off)
   */
  async sendDeviceActions(
    deviceActions: DeviceActionRequest[]
  ): Promise<DeviceActionResponse> {
    return this.request<DeviceActionResponse>("/devices/actions", {
      method: "POST",
      body: {
        devices: deviceActions,
      },
    });
  }

  /**
   * Trigger a predefined scenario in Yandex Smart Home
   */
  async triggerScenario(scenarioId: string): Promise<ScenarioActionResponse> {
    return this.request<ScenarioActionResponse>(
      `/scenarios/${encodeURIComponent(scenarioId)}/actions`,
      {
        method: "POST",
      }
    );
  }
}
