import { saveEnvVariable, saveTokenToKeychain, getTokenFromKeychain } from "../auth/token-storage.js";
import { IStorage } from "../storage/storage-interface.js";

const MASK_EN = "0123456789abcdef-";
const MASK_RU = "оеаинтсрвлкмдпуяы";

export function encodeDeviceId(uid: string): string {
  return uid
    .toLowerCase()
    .split("")
    .map((c) => {
      const idx = MASK_EN.indexOf(c);
      return idx >= 0 ? MASK_RU[idx] : c;
    })
    .join("");
}

export function buildTtsScenarioPayload(
  name: string,
  trigger: string,
  deviceId: string,
  text: string
) {
  return {
    name,
    icon: "home",
    triggers: [
      {
        trigger: { type: "scenario.trigger.voice", value: trigger },
      },
    ],
    steps: [
      {
        type: "scenarios.steps.actions.v2",
        parameters: {
          items: [
            {
              id: deviceId,
              type: "step.action.item.device",
              value: {
                id: deviceId,
                item_type: "device",
                capabilities: [
                  {
                    type: "devices.capabilities.quasar",
                    state: {
                      instance: "tts",
                      value: { text },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  };
}

export function buildCommandScenarioPayload(
  name: string,
  trigger: string,
  deviceId: string,
  command: string
) {
  return {
    name,
    icon: "home",
    triggers: [
      {
        trigger: { type: "scenario.trigger.voice", value: trigger },
      },
    ],
    steps: [
      {
        type: "scenarios.steps.actions.v2",
        parameters: {
          items: [
            {
              id: deviceId,
              type: "step.action.item.device",
              value: {
                id: deviceId,
                item_type: "device",
                capabilities: [
                  {
                    type: "devices.capabilities.quasar.server_action",
                    state: {
                      instance: "text_action",
                      value: command,
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  };
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface QuasarClientOptions {
  cookie?: string;
  useKeychain?: boolean;
  persistEnv?: boolean;
  envFilePath?: string;
  userId?: string;
  storage?: IStorage;
}

export class QuasarClient {
  private cookie: string | null = null;
  private cookiesMap: Map<string, string> = new Map();
  private csrfToken: string | null = null;
  private scenarioCache: Map<string, string> = new Map(); // deviceId -> scenarioId
  private useKeychain: boolean;
  private persistEnv: boolean;
  private envFilePath?: string;

  private locks = new Map<string, Promise<any>>();
  private userId?: string;
  private storage?: IStorage;

  constructor(options: QuasarClientOptions = {}) {
    this.useKeychain = options.useKeychain ?? true;
    this.persistEnv = options.persistEnv ?? true;
    this.envFilePath = options.envFilePath;
    this.userId = options.userId;
    this.storage = options.storage;

    const cookie =
      options.cookie ||
      process.env.YANDEX_COOKIE ||
      (this.useKeychain ? getTokenFromKeychain("mctl-alice-quasar-cookie") : null);

    if (cookie) {
      this.setCookie(cookie, false);
    }
  }

  /**
   * Serializes async operations targeting the same key (e.g. deviceId)
   */
  private async runWithLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) || Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      key,
      prev.then(
        () => next,
        () => next
      )
    );

    await prev.catch(() => {});
    try {
      return await task();
    } finally {
      release!();
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    }
  }

  private parseCookieString(str: string): void {
    const parts = str.split(";");
    for (const part of parts) {
      const idx = part.indexOf("=");
      if (idx > 0) {
        const k = part.substring(0, idx).trim();
        const v = part.substring(idx + 1).trim();
        if (k) this.cookiesMap.set(k, v);
      }
    }
  }

  private serializeCookies(): string {
    const pairs: string[] = [];
    for (const [k, v] of this.cookiesMap.entries()) {
      pairs.push(`${k}=${v}`);
    }
    return pairs.join("; ");
  }

  setCookie(cookie: string, persist = true): void {
    let normalized = cookie.trim();
    if (!normalized.includes("=")) {
      normalized = `Session_id=${normalized}`;
    }
    this.parseCookieString(normalized);
    this.cookie = this.serializeCookies();
    this.csrfToken = null;

    if (persist) {
      if (this.useKeychain) {
        saveTokenToKeychain(this.cookie, "mctl-alice-cookie");
      }
      if (this.persistEnv) {
        try {
          saveEnvVariable("YANDEX_COOKIE", this.cookie, this.envFilePath);
        } catch {
          // ignore
        }
      }
    }
  }

  hasCookie(): boolean {
    return Boolean(this.cookie);
  }

  async getCsrfToken(): Promise<string> {
    if (this.csrfToken) {
      return this.csrfToken;
    }

    if (!this.cookie) {
      throw new Error("Yandex cookie not configured. Set YANDEX_COOKIE in .env or via /auth/cookie.");
    }

    const res = await fetch("https://yandex.ru/quasar", {
      headers: {
        Cookie: this.cookie,
        "User-Agent": USER_AGENT,
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch Quasar CSRF token: HTTP ${res.status}`);
    }

    // Merge any Set-Cookie headers returned by yandex.ru (e.g. _yasc, i, etc.)
    const setCookies =
      typeof (res.headers as any).getSetCookie === "function"
        ? (res.headers as any).getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean);
    for (const sc of setCookies) {
      if (sc) {
        this.parseCookieString(sc.split(";")[0]);
      }
    }
    this.cookie = this.serializeCookies();

    const html = await res.text();
    const match = html.match(/"csrfToken2"\s*:\s*"([^"]+)"/);
    if (!match || !match[1]) {
      throw new Error("Failed to extract csrfToken2 from Yandex Quasar page. Cookie may be invalid or expired.");
    }

    this.csrfToken = match[1];
    return this.csrfToken;
  }

  private async request(url: string, options: RequestInit = {}): Promise<any> {
    const csrf = await this.getCsrfToken();
    const headers: Record<string, string> = {
      Cookie: this.cookie || "",
      "User-Agent": USER_AGENT,
      "Origin": "https://yandex.ru",
      "Referer": "https://yandex.ru/quasar",
      "Accept": "application/json",
      "x-csrf-token": csrf,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

    let res = await fetch(url, { ...options, headers });

    if (res.status === 403) {
      // CSRF token may have expired, refresh once
      this.csrfToken = null;
      const newCsrf = await this.getCsrfToken();
      headers["x-csrf-token"] = newCsrf;
      headers["Cookie"] = this.cookie || "";
      res = await fetch(url, { ...options, headers });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Quasar API error (${res.status}): ${text}`);
    }

    return res.json();
  }

  async getUserDevices(): Promise<any> {
    return this.request("https://iot.quasar.yandex.ru/m/user/devices", {
      method: "GET",
    });
  }

  async getDevice(deviceId: string): Promise<any> {
    return this.request(`https://iot.quasar.yandex.ru/m/user/devices/${encodeURIComponent(deviceId)}`, {
      method: "GET",
    });
  }

  async sendDeviceActions(
    deviceId: string,
    actions: Array<{ type: string; state: { instance: string; value: any } }>
  ): Promise<any> {
    return this.request(
      `https://iot.quasar.yandex.ru/m/user/devices/${encodeURIComponent(deviceId)}/actions`,
      {
        method: "POST",
        body: JSON.stringify({ actions }),
      }
    );
  }

  async getScenarios(): Promise<any[]> {
    const data = await this.request("https://iot.quasar.yandex.ru/m/user/scenarios", {
      method: "GET",
    });
    return data.scenarios || [];
  }

  async triggerScenario(scenarioId: string): Promise<any> {
    return this.request(`https://iot.quasar.yandex.ru/m/user/scenarios/${encodeURIComponent(scenarioId)}/actions`, {
      method: "POST",
    });
  }

  async getOrCreateSpeakerScenario(deviceId: string): Promise<string> {
    if (this.scenarioCache.has(deviceId)) {
      return this.scenarioCache.get(deviceId)!;
    }

    const trigger = encodeDeviceId(deviceId);
    const name = this.userId ? `mctl-${this.userId.slice(0, 8)}-${deviceId}` : `mctl-${deviceId}`;

    // Check existing scenarios
    try {
      const scenarios = await this.getScenarios();
      // Look for exact matching speaker scenario only (never adopt arbitrary scenarios)
      for (const sc of scenarios) {
        if (sc.name === name || sc.triggers?.[0]?.value === trigger) {
          this.scenarioCache.set(deviceId, sc.id);
          return sc.id;
        }
      }
    } catch {
      // ignore, try create
    }

    // Create a new proxy scenario on /m/user/scenarios (not /v4/)
    const uniqueTrigger = `${trigger}${Date.now().toString().slice(-4)}`;
    const payload = buildTtsScenarioPayload(name, uniqueTrigger, deviceId, "готов");
    const res = await this.request("https://iot.quasar.yandex.ru/m/user/scenarios", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (res.status !== "ok" || !res.scenario_id) {
      throw new Error(`Failed to create proxy scenario: ${JSON.stringify(res)}`);
    }

    this.scenarioCache.set(deviceId, res.scenario_id);
    return res.scenario_id;
  }

  async sendTts(
    deviceId: string,
    text: string,
    triggerCallback?: (scenarioId: string) => Promise<any>
  ): Promise<any> {
    return this.runWithLock(deviceId, async () => {
      const scenarioId = await this.getOrCreateSpeakerScenario(deviceId);
      const trigger = encodeDeviceId(deviceId);
      const name = this.userId ? `mctl-${this.userId.slice(0, 8)}-${deviceId}` : `mctl-${deviceId}`;

      const payload = buildTtsScenarioPayload(name, trigger, deviceId, text);
      const updateRes = await this.request(
        `https://iot.quasar.yandex.ru/m/v4/user/scenarios/${scenarioId}`,
        {
          method: "PUT",
          body: JSON.stringify(payload),
        }
      );

      if (updateRes.status !== "ok") {
        throw new Error(`Failed to update scenario for TTS: ${JSON.stringify(updateRes)}`);
      }

      if (triggerCallback) {
        try {
          return await triggerCallback(scenarioId);
        } catch {
          // Fallback to direct Quasar trigger if triggerCallback fails
        }
      }

      return this.triggerScenario(scenarioId);
    });
  }

  async sendCommand(
    deviceId: string,
    command: string,
    triggerCallback?: (scenarioId: string) => Promise<any>
  ): Promise<any> {
    return this.runWithLock(deviceId, async () => {
      const scenarioId = await this.getOrCreateSpeakerScenario(deviceId);
      const trigger = encodeDeviceId(deviceId);
      const name = this.userId ? `mctl-${this.userId.slice(0, 8)}-${deviceId}` : `mctl-${deviceId}`;

      const payload = buildCommandScenarioPayload(name, trigger, deviceId, command);
      const updateRes = await this.request(
        `https://iot.quasar.yandex.ru/m/v4/user/scenarios/${scenarioId}`,
        {
          method: "PUT",
          body: JSON.stringify(payload),
        }
      );

      if (updateRes.status !== "ok") {
        throw new Error(`Failed to update scenario for command: ${JSON.stringify(updateRes)}`);
      }

      if (triggerCallback) {
        try {
          return await triggerCallback(scenarioId);
        } catch {
          // Fallback to direct Quasar trigger if triggerCallback fails
        }
      }

      return this.triggerScenario(scenarioId);
    });
  }

  async deleteSpeakerScenario(deviceId: string): Promise<boolean> {
    const scenarioId = this.scenarioCache.get(deviceId);
    if (!scenarioId) return false;
    try {
      await this.request(`https://iot.quasar.yandex.ru/m/v4/user/scenarios/${encodeURIComponent(scenarioId)}`, {
        method: "DELETE",
      });
      this.scenarioCache.delete(deviceId);
      return true;
    } catch {
      return false;
    }
  }

  async cleanupAllProxyScenarios(): Promise<number> {
    const prefix = this.userId ? `mctl-${this.userId.slice(0, 8)}-` : "mctl-";
    try {
      const scenarios = await this.getScenarios();
      let deleted = 0;
      for (const sc of scenarios) {
        if (sc.name && sc.name.startsWith(prefix)) {
          try {
            await this.request(`https://iot.quasar.yandex.ru/m/v4/user/scenarios/${encodeURIComponent(sc.id)}`, {
              method: "DELETE",
            });
            deleted++;
          } catch {
            // ignore individual delete failures
          }
        }
      }
      this.scenarioCache.clear();
      return deleted;
    } catch {
      return 0;
    }
  }
}
