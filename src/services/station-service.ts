import { YandexIoTClient, YandexApiError } from "../client/yandex-api.js";
import { QuasarClient } from "../client/quasar-client.js";
import {
  YandexDevice,
  YandexRoom,
  YandexScenario,
  YandexUserInfo,
  SpeakerInfo,
} from "../client/types.js";

export interface DeviceListResult {
  speakers: Array<{
    id: string;
    name: string;
    room: string;
    type: string;
    state?: string;
  }>;
  otherDevices?: Array<{
    id: string;
    name: string;
    room: string;
    type: string;
  }>;
  rooms: Array<{ id: string; name: string }>;
  scenarios: Array<{ id: string; name: string; isActive: boolean }>;
}

export class StationService {
  private client: YandexIoTClient | null = null;
  private quasarClient: QuasarClient | null = null;
  private cachedUserInfo: YandexUserInfo | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 30000; // 30 seconds

  constructor(client?: YandexIoTClient, quasarClient?: QuasarClient) {
    if (client) {
      this.client = client;
    } else {
      try {
        this.client = new YandexIoTClient();
      } catch {
        this.client = null;
      }
    }
    if (quasarClient) {
      this.quasarClient = quasarClient;
    } else {
      try {
        this.quasarClient = new QuasarClient();
      } catch {
        this.quasarClient = null;
      }
    }
  }

  getQuasarClient(): QuasarClient | null {
    return this.quasarClient;
  }

  private getClient(): YandexIoTClient {
    if (!this.client) {
      try {
        this.client = new YandexIoTClient();
      } catch {
        throw new YandexApiError(
          "Yandex OAuth token is missing. Please set YANDEX_OAUTH_TOKEN in environment or .env file."
        );
      }
    }
    return this.client;
  }

  /**
   * Fetch user info with simple in-memory caching
   */
  async getUserInfo(forceRefresh = false): Promise<YandexUserInfo> {
    const now = Date.now();
    if (!forceRefresh && this.cachedUserInfo && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return this.cachedUserInfo;
    }
    const info = await this.getClient().getUserInfo();
    this.cachedUserInfo = info;
    this.cacheTimestamp = now;
    return info;
  }

  /**
   * Determine whether a device is a smart speaker or media device with Alice
   */
  isSpeaker(device: YandexDevice): boolean {
    if (device.type && device.type.startsWith("devices.types.smart_speaker")) {
      return true;
    }

    // Check if device has quasar info or quasar capabilities
    if ((device as any).quasar_info) {
      return true;
    }

    return (
      device.capabilities?.some(
        (c) =>
          c.type === "devices.capabilities.quasar.server_action" ||
          c.type.startsWith("devices.capabilities.quasar")
      ) ?? false
    );
  }

  /**
   * Map room ID to room name
   */
  private buildRoomMap(rooms?: YandexRoom[]): Map<string, string> {
    const map = new Map<string, string>();
    if (!rooms) return map;
    for (const r of rooms) {
      map.set(r.id, r.name);
    }
    return map;
  }

  /**
   * Get formatted list of devices and speakers
   */
  async listDevices(onlySpeakers = false): Promise<DeviceListResult> {
    const info = await this.getUserInfo();
    const roomMap = this.buildRoomMap(info.rooms);

    const speakers: DeviceListResult["speakers"] = [];
    const otherDevices: DeviceListResult["otherDevices"] = [];

    for (const device of info.devices || []) {
      const roomName = (device.room && roomMap.get(device.room)) || "Не указана";
      const item = {
        id: device.id,
        name: device.name,
        room: roomName,
        type: device.type,
        state: device.state,
      };

      if (this.isSpeaker(device)) {
        speakers.push(item);
      } else {
        otherDevices.push(item);
      }
    }

    const rooms = (info.rooms || []).map((r) => ({ id: r.id, name: r.name }));
    const scenarios = (info.scenarios || []).map((s) => ({
      id: s.id,
      name: s.name,
      isActive: s.is_active,
    }));

    return {
      speakers,
      otherDevices: onlySpeakers ? undefined : otherDevices,
      rooms,
      scenarios,
    };
  }

  /**
   * Find target speaker by query (ID, device name, or room name).
   * If query is not provided, uses DEFAULT_SPEAKER env or the first available speaker.
   */
  async resolveSpeaker(query?: string): Promise<YandexDevice> {
    const info = await this.getUserInfo();
    const roomMap = this.buildRoomMap(info.rooms);
    const speakers = (info.devices || []).filter((d) => this.isSpeaker(d));

    if (speakers.length === 0) {
      throw new YandexApiError(
        "No Alice smart speakers found in your Yandex account. Please check that a Yandex Station is linked to your Smart Home."
      );
    }

    const searchQuery = (query || process.env.DEFAULT_SPEAKER || "").trim().toLowerCase();

    if (!searchQuery) {
      // Return default or first speaker
      return speakers[0];
    }

    // 1. Direct ID match
    const byId = speakers.find((s) => s.id === query);
    if (byId) return byId;

    // 2. Exact name match
    const byExactName = speakers.find((s) => s.name.toLowerCase() === searchQuery);
    if (byExactName) return byExactName;

    // 3. Substring name match
    const bySubName = speakers.find((s) => s.name.toLowerCase().includes(searchQuery));
    if (bySubName) return bySubName;

    // 4. Room match (prefer smart speakers over other devices)
    const byRoom =
      speakers.find((s) => {
        const rName = (s.room && roomMap.get(s.room))?.toLowerCase() || "";
        return (
          (rName === searchQuery || rName.includes(searchQuery)) &&
          s.type.startsWith("devices.types.smart_speaker")
        );
      }) ||
      speakers.find((s) => {
        const rName = (s.room && roomMap.get(s.room))?.toLowerCase() || "";
        return rName === searchQuery || rName.includes(searchQuery);
      });
    if (byRoom) return byRoom;

    // If query was specified but not found
    const available = speakers
      .map((s) => `"${s.name}" (room: ${s.room ? roomMap.get(s.room) : "none"}, id: ${s.id})`)
      .join(", ");
    throw new YandexApiError(
      `Speaker matching "${query}" was not found. Available speakers: ${available}`
    );
  }

  /**
   * Send arbitrary voice command to Alice as text (e.g. "включи джаз", "поставь таймер на 10 минут")
   */
  async sendCommand(command: string, targetSpeaker?: string) {
    const speaker = await this.resolveSpeaker(targetSpeaker);

    if (this.quasarClient && this.quasarClient.hasCookie()) {
      const response = await this.quasarClient.sendCommand(
        speaker.id,
        command,
        (sid) => this.getClient().triggerScenario(sid)
      );
      return {
        status: "ok",
        speaker: { id: speaker.id, name: speaker.name },
        command,
        method: "quasar_command",
        apiResponse: response,
      };
    }

    try {
      const response = await this.getClient().sendDeviceActions([
        {
          id: speaker.id,
          actions: [
            {
              type: "devices.capabilities.quasar.server_action",
              state: {
                instance: "text_action",
                value: command,
              },
            },
          ],
        },
      ]);

      return {
        status: "ok",
        speaker: { id: speaker.id, name: speaker.name },
        command,
        apiResponse: response,
      };
    } catch (err: any) {
      throw new Error(
        `Не удалось выполнить команду на колонке "${speaker.name}". ` +
        `Для прямого выполнения голосовых команд требуется авторизация Yandex Quasar (куки Session_id). ` +
        `Укажите YANDEX_COOKIE в .env или настройте на странице /auth/cookie. ` +
        `Либо используйте готовый сценарий через triggerScenario.`
      );
    }
  }

  /**
   * Speak arbitrary text via Alice (TTS)
   */
  async sayPhrase(phrase: string, targetSpeaker?: string) {
    const speaker = await this.resolveSpeaker(targetSpeaker);

    if (this.quasarClient && this.quasarClient.hasCookie()) {
      const response = await this.quasarClient.sendTts(
        speaker.id,
        phrase,
        (sid) => this.getClient().triggerScenario(sid)
      );
      return {
        status: "ok",
        speaker: { id: speaker.id, name: speaker.name },
        phrase,
        method: "quasar_tts",
        apiResponse: response,
      };
    }

    try {
      const response = await this.getClient().sendDeviceActions([
        {
          id: speaker.id,
          actions: [
            {
              type: "devices.capabilities.quasar.server_action",
              state: {
                instance: "phrase_action",
                value: phrase,
              },
            },
          ],
        },
      ]);

      return {
        status: "ok",
        speaker: { id: speaker.id, name: speaker.name },
        phrase,
        apiResponse: response,
      };
    } catch (err: any) {
      throw new Error(
        `Не удалось озвучить фразу на колонке "${speaker.name}". ` +
        `Для прямого воспроизведения произвольного текста (TTS) требуется авторизация Yandex Quasar (куки Session_id). ` +
        `Укажите YANDEX_COOKIE в .env или настройте на странице /auth/cookie. ` +
        `Либо используйте готовый сценарий через triggerScenario.`
      );
    }
  }

  /**
   * Set speaker volume (1-10 or 1-100 depending on device parameters)
   */
  async setVolume(level: number, targetSpeaker?: string) {
    const speaker = await this.resolveSpeaker(targetSpeaker);

    // Find volume capability parameters if present
    const volumeCap = speaker.capabilities.find(
      (c) => c.type === "devices.capabilities.range" && c.parameters?.instance === "volume"
    );

    let targetValue = level;
    if (volumeCap?.parameters?.range) {
      const min = volumeCap.parameters.range.min ?? 1;
      const max = volumeCap.parameters.range.max ?? 10;
      targetValue = Math.min(Math.max(level, min), max);
    } else {
      // Default to standard 1-10 scale for Yandex Station
      targetValue = Math.min(Math.max(Math.round(level), 1), 10);
    }

    const response = await this.getClient().sendDeviceActions([
      {
        id: speaker.id,
        actions: [
          {
            type: "devices.capabilities.range",
            state: {
              instance: "volume",
              value: targetValue,
            },
          },
        ],
      },
    ]);

    return {
      status: "ok",
      speaker: { id: speaker.id, name: speaker.name },
      volume: targetValue,
      apiResponse: response,
    };
  }

  /**
   * Media playback control
   */
  async mediaControl(
    action: "pause" | "play" | "stop" | "next" | "prev",
    targetSpeaker?: string
  ) {
    const speaker = await this.resolveSpeaker(targetSpeaker);

    // Map actions to natural Russian commands that Alice executes reliably
    const commandMap: Record<typeof action, string> = {
      pause: "пауза",
      play: "продолжи воспроизведение",
      stop: "стоп",
      next: "следующий трек",
      prev: "предыдущий трек",
    };

    const command = commandMap[action];
    const response = await this.getClient().sendDeviceActions([
      {
        id: speaker.id,
        actions: [
          {
            type: "devices.capabilities.quasar.server_action",
            state: {
              instance: "text_action",
              value: command,
            },
          },
        ],
      },
    ]);

    return {
      status: "ok",
      speaker: { id: speaker.id, name: speaker.name },
      action,
      commandSent: command,
      apiResponse: response,
    };
  }

  /**
   * Trigger scenario by name or ID
   */
  async triggerScenario(nameOrId: string) {
    const info = await this.getUserInfo();
    const scenarios = info.scenarios || [];

    const query = nameOrId.trim().toLowerCase();
    const target =
      scenarios.find((s) => s.id === nameOrId) ||
      scenarios.find((s) => s.name.toLowerCase() === query) ||
      scenarios.find((s) => s.name.toLowerCase().includes(query));

    if (!target) {
      const names = scenarios.map((s) => `"${s.name}" (id: ${s.id})`).join(", ");
      throw new YandexApiError(
        `Scenario "${nameOrId}" not found. Available scenarios: ${names || "none"}`
      );
    }

    const response = await this.getClient().triggerScenario(target.id);
    return {
      status: "ok",
      scenario: { id: target.id, name: target.name },
      apiResponse: response,
    };
  }
}
