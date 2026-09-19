import {
  YandexUserInfo,
  DeviceActionRequest,
  DeviceActionResponse,
  ScenarioActionResponse,
} from "./types.js";

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

  constructor(token?: string) {
    const resolvedToken = token || process.env.YANDEX_OAUTH_TOKEN;
    if (!resolvedToken) {
      throw new YandexApiError(
        "Yandex OAuth token is missing. Please provide it in YANDEX_OAUTH_TOKEN env variable or pass it directly."
      );
    }
    // Clean token if user prefixed with 'Bearer ' or quotes
    this.token = resolvedToken.trim().replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "");
  }

  private async request<T>(
    endpoint: string,
    options: {
      method?: string;
      body?: any;
    } = {}
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
          throw new YandexApiError(
            "Unauthorized (401): The Yandex OAuth token is invalid or expired. Please check your YANDEX_OAUTH_TOKEN.",
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
