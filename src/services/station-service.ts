import { YandexIoTClient, YandexApiError } from "../client/yandex-api.js";
import { QuasarClient } from "../client/quasar-client.js";
import {
  YandexDevice,
  YandexRoom,
  YandexScenario,
  YandexUserInfo,
  SpeakerInfo,
} from "../client/types.js";
import { TelemetryStorage, TelemetryHistoryResult } from "../storage/telemetry-storage.js";

export interface LightControlOptions {
  device: string;
  room?: string;
  state?: "on" | "off";
  brightness?: number;
  color_temp_k?: number;
  scene?: string;
}

export interface RoomControlOptions {
  room: string;
  action: "turn_on" | "turn_off";
  device_type?: "light" | "socket" | "climate" | "all";
}

export interface HomeSummaryResult {
  scope: string;
  timestamp: string;
  totalDevices: number;
  climate: Array<{
    room: string;
    temperature?: number;
    humidity?: number;
    pressure?: number;
    devices: string[];
  }>;
  security: Array<{
    name: string;
    room: string;
    type: string;
    status: string;
    details?: any;
  }>;
  lights: {
    total: number;
    onCount: number;
    offCount: number;
    activeLights: Array<{ name: string; room: string; brightness?: number }>;
  };
  sockets: {
    total: number;
    onCount: number;
    totalPowerW: number;
    devices: Array<{
      name: string;
      room: string;
      isOn: boolean;
      powerW?: number;
      voltageV?: number;
      amperageA?: number;
    }>;
  };
  batteries: Array<{
    name: string;
    room: string;
    level: number;
    warning: boolean;
  }>;
  offlineDevices: Array<{
    name: string;
    room: string;
    type: string;
  }>;
}

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

  private storage: TelemetryStorage | null = null;

  constructor(
    client?: YandexIoTClient,
    quasarClient?: QuasarClient,
    storage?: TelemetryStorage
  ) {
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
    if (storage) {
      this.storage = storage;
    }
  }

  getStorage(): TelemetryStorage {
    if (!this.storage) {
      this.storage = new TelemetryStorage();
    }
    return this.storage;
  }

  setStorage(storage: TelemetryStorage): void {
    this.storage = storage;
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
   * Fetch user info with simple in-memory caching and fallback to Quasar client if IoT token is missing/forbidden
   */
  async getUserInfo(forceRefresh = false): Promise<YandexUserInfo> {
    const now = Date.now();
    if (!forceRefresh && this.cachedUserInfo && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return this.cachedUserInfo;
    }
    try {
      const info = await this.getClient().getUserInfo();
      this.cachedUserInfo = info;
      this.cacheTimestamp = now;
      return info;
    } catch (err: any) {
      if (this.quasarClient && this.quasarClient.hasCookie()) {
        try {
          const quasarInfo = await this.getUserInfoFromQuasar();
          this.cachedUserInfo = quasarInfo;
          this.cacheTimestamp = now;
          return quasarInfo;
        } catch {
          // fall through
        }
      }
      throw err;
    }
  }

  private async getUserInfoFromQuasar(): Promise<YandexUserInfo> {
    if (!this.quasarClient || !this.quasarClient.hasCookie()) {
      throw new Error("Quasar client not configured with cookie");
    }

    const [quasarData, scenarios] = await Promise.all([
      this.quasarClient.getUserDevices(),
      this.quasarClient.getScenarios().catch(() => []),
    ]);

    const devices: YandexDevice[] = [];
    const rooms: YandexRoom[] = (quasarData.rooms || []).map((r: any) => {
      const roomDeviceIds: string[] = [];
      for (const d of r.devices || []) {
        devices.push({ ...d, room: r.id });
        roomDeviceIds.push(d.id);
      }
      return {
        id: r.id,
        name: r.name,
        devices: roomDeviceIds,
      };
    });

    const seenDeviceIds = new Set<string>(devices.map((d) => d.id));
    for (const s of quasarData.speakers || []) {
      if (!seenDeviceIds.has(s.id)) {
        devices.push(s);
        seenDeviceIds.add(s.id);
      }
    }
    for (const u of quasarData.unconfigured_devices || []) {
      if (!seenDeviceIds.has(u.id)) {
        devices.push(u);
        seenDeviceIds.add(u.id);
      }
    }

    return {
      status: quasarData.status || "ok",
      request_id: quasarData.request_id || "",
      rooms,
      groups: quasarData.groups || [],
      devices,
      scenarios: scenarios.map((s: any) => ({
        id: s.id,
        name: s.name,
        is_active: s.is_active ?? true,
      })),
    };
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
        command
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
        phrase
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

    if (this.quasarClient && this.quasarClient.hasCookie()) {
      try {
        const response = await this.sendCommand(`сделай громкость ${targetValue}`, targetSpeaker);
        return {
          status: "ok",
          speaker: { id: speaker.id, name: speaker.name },
          volume: targetValue,
          apiResponse: response,
        };
      } catch {
        // Fall through to official IoT API
      }
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

    if (this.quasarClient && this.quasarClient.hasCookie()) {
      try {
        const response = await this.sendCommand(command, targetSpeaker);
        return {
          status: "ok",
          speaker: { id: speaker.id, name: speaker.name },
          action,
          commandSent: command,
          apiResponse: response,
        };
      } catch {
        // Fall through to official IoT API
      }
    }

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

    if (this.quasarClient && this.quasarClient.hasCookie()) {
      try {
        const response = await this.quasarClient.triggerScenario(target.id);
        return {
          status: "ok",
          scenario: { id: target.id, name: target.name },
          apiResponse: response,
        };
      } catch {
        // Fall through to official IoT API
      }
    }

    const response = await this.getClient().triggerScenario(target.id);
    return {
      status: "ok",
      scenario: { id: target.id, name: target.name },
      apiResponse: response,
    };
  }

  /**
   * Resolve any smart home device by name or ID, optionally filtered by room name
   */
  async resolveDevice(
    deviceQuery: string,
    roomQuery?: string
  ): Promise<{ device: YandexDevice; roomName: string }> {
    const info = await this.getUserInfo();
    const roomMap = this.buildRoomMap(info.rooms);
    const devices = info.devices || [];

    if (devices.length === 0) {
      throw new YandexApiError("No smart home devices found in your Yandex account.");
    }

    const dQuery = deviceQuery.trim().toLowerCase();
    const rQuery = roomQuery ? roomQuery.trim().toLowerCase() : undefined;

    // Filter by room if specified
    const candidates = rQuery
      ? devices.filter((d) => {
          const rName = (d.room && roomMap.get(d.room))?.toLowerCase() || "";
          return rName === rQuery || rName.includes(rQuery);
        })
      : devices;

    const searchPool = candidates.length > 0 ? candidates : devices;

    // 1. Direct ID match
    let match = searchPool.find((d) => d.id === deviceQuery);
    // 2. Exact name match
    if (!match) match = searchPool.find((d) => d.name.toLowerCase() === dQuery);
    // 3. Substring name match
    if (!match) match = searchPool.find((d) => d.name.toLowerCase().includes(dQuery));
    // 4. Fallback search across all devices if room filter had no match
    if (!match && rQuery && candidates.length === 0) {
      match = devices.find((d) => d.name.toLowerCase().includes(dQuery));
    }

    if (!match) {
      const available = devices
        .map((d) => `"${d.name}" (${d.room ? roomMap.get(d.room) : "no room"}, id: ${d.id})`)
        .join(", ");
      throw new YandexApiError(
        `Device matching "${deviceQuery}"${roomQuery ? ` in room "${roomQuery}"` : ""} was not found. Available devices: ${available}`
      );
    }

    const roomName = (match.room && roomMap.get(match.room)) || "Не указана";
    return { device: match, roomName };
  }

  /**
   * Directly control smart home devices (on/off, temperature, mode) via official Yandex IoT API
   */
  async controlDevice(options: {
    device: string;
    room?: string;
    state?: "on" | "off";
    temperature?: number;
    mode?: string;
  }) {
    const { device, roomName } = await this.resolveDevice(options.device, options.room);
    const actions: Array<{
      type: string;
      state: { instance: string; value: any };
    }> = [];

    // 1. On / Off capability
    if (options.state) {
      const onOffCap = device.capabilities?.find(
        (c) => c.type === "devices.capabilities.on_off"
      );
      if (onOffCap) {
        actions.push({
          type: "devices.capabilities.on_off",
          state: {
            instance: "on",
            value: options.state === "on",
          },
        });
      }
    }

    // 2. Temperature capability (thermostat/AC range)
    if (typeof options.temperature === "number" && !isNaN(options.temperature)) {
      const tempCap = device.capabilities?.find(
        (c) =>
          c.type === "devices.capabilities.range" &&
          c.parameters?.instance === "temperature"
      );
      if (tempCap) {
        let val = options.temperature;
        if (tempCap.parameters?.range) {
          const min = tempCap.parameters.range.min ?? 16;
          const max = tempCap.parameters.range.max ?? 30;
          val = Math.min(Math.max(val, min), max);
        }
        actions.push({
          type: "devices.capabilities.range",
          state: {
            instance: "temperature",
            value: val,
          },
        });
      }
    }

    // 3. Mode capability (thermostat mode: cool, heat, auto, dry, fan_only)
    if (options.mode) {
      const modeCap = device.capabilities?.find(
        (c) =>
          c.type === "devices.capabilities.mode" &&
          c.parameters?.instance === "thermostat"
      );
      if (modeCap) {
        actions.push({
          type: "devices.capabilities.mode",
          state: {
            instance: "thermostat",
            value: options.mode,
          },
        });
      }
    }

    if (actions.length === 0) {
      throw new YandexApiError(
        `Device "${device.name}" does not support the requested actions. Device type: ${device.type}.`
      );
    }

    if (this.quasarClient && this.quasarClient.hasCookie()) {
      try {
        const response = await this.quasarClient.sendDeviceActions(device.id, actions);
        return {
          status: "ok",
          device: { id: device.id, name: device.name, room: roomName },
          actionsApplied: actions,
          apiResponse: response,
        };
      } catch {
        // Fall through to official IoT API
      }
    }

    const response = await this.getClient().sendDeviceActions([
      {
        id: device.id,
        actions,
      },
    ]);

    return {
      status: "ok",
      device: { id: device.id, name: device.name, room: roomName },
      actionsApplied: actions,
      apiResponse: response,
    };
  }

  /**
   * Control smart lighting (power, brightness, color temperature, scenes)
   */
  async setLight(options: LightControlOptions) {
    const { device, roomName } = await this.resolveDevice(options.device, options.room);
    const actions: Array<{
      type: string;
      state: { instance: string; value: any };
    }> = [];

    // 1. On / Off capability
    if (options.state) {
      const onOffCap = device.capabilities?.find(
        (c) => c.type === "devices.capabilities.on_off"
      );
      if (onOffCap) {
        actions.push({
          type: "devices.capabilities.on_off",
          state: {
            instance: "on",
            value: options.state === "on",
          },
        });
      }
    }

    // 2. Brightness capability
    if (typeof options.brightness === "number" && !isNaN(options.brightness)) {
      const brightnessCap = device.capabilities?.find(
        (c) =>
          c.type === "devices.capabilities.range" &&
          c.parameters?.instance === "brightness"
      );
      if (brightnessCap) {
        let val = Math.round(options.brightness);
        const min = brightnessCap.parameters?.range?.min ?? 1;
        const max = brightnessCap.parameters?.range?.max ?? 100;
        val = Math.min(Math.max(val, min), max);
        actions.push({
          type: "devices.capabilities.range",
          state: {
            instance: "brightness",
            value: val,
          },
        });
      }
    }

    // 3. Color temperature capability (Kelvin)
    if (typeof options.color_temp_k === "number" && !isNaN(options.color_temp_k)) {
      const colorCap = device.capabilities?.find(
        (c) => c.type === "devices.capabilities.color_setting"
      );
      if (colorCap) {
        let val = Math.round(options.color_temp_k);
        const min = colorCap.parameters?.temperature_k?.min ?? 1500;
        const max = colorCap.parameters?.temperature_k?.max ?? 6500;
        val = Math.min(Math.max(val, min), max);
        actions.push({
          type: "devices.capabilities.color_setting",
          state: {
            instance: "temperature_k",
            value: val,
          },
        });
      }
    }

    // 4. Lighting scene capability (night, reading, party, candle, etc.)
    if (options.scene) {
      const colorCap = device.capabilities?.find(
        (c) => c.type === "devices.capabilities.color_setting"
      );
      if (colorCap) {
        const sceneId = options.scene.trim().toLowerCase();
        actions.push({
          type: "devices.capabilities.color_setting",
          state: {
            instance: "scene",
            value: sceneId,
          },
        });
      }
    }

    if (actions.length === 0) {
      throw new YandexApiError(
        `Device "${device.name}" does not support the requested light actions. Device type: ${device.type}.`
      );
    }

    if (this.quasarClient && this.quasarClient.hasCookie()) {
      try {
        const response = await this.quasarClient.sendDeviceActions(device.id, actions);
        return {
          status: "ok",
          device: { id: device.id, name: device.name, room: roomName },
          actionsApplied: actions,
          apiResponse: response,
        };
      } catch {
        // Fall through to official IoT API
      }
    }

    const response = await this.getClient().sendDeviceActions([
      {
        id: device.id,
        actions,
      },
    ]);

    return {
      status: "ok",
      device: { id: device.id, name: device.name, room: roomName },
      actionsApplied: actions,
      apiResponse: response,
    };
  }

  /**
   * Batch control devices within a room or the entire home
   */
  async controlRoom(options: RoomControlOptions) {
    const info = await this.getUserInfo();
    const roomMap = this.buildRoomMap(info.rooms);
    const devices = info.devices || [];

    const roomNorm = options.room.trim().toLowerCase();
    const isAllRooms = ["all", "все", "весь дом", "всё"].includes(roomNorm);

    let targetRoomName = "Весь дом";
    let targetRoomId: string | undefined;

    if (!isAllRooms) {
      const matchedRoom = (info.rooms || []).find(
        (r) =>
          r.id === options.room ||
          r.name.toLowerCase() === roomNorm ||
          r.name.toLowerCase().includes(roomNorm)
      );
      if (!matchedRoom) {
        const available = (info.rooms || []).map((r) => r.name).join(", ");
        throw new YandexApiError(
          `Room "${options.room}" not found. Available rooms: ${available || "none"}`
        );
      }
      targetRoomName = matchedRoom.name;
      targetRoomId = matchedRoom.id;
    }

    const devicesInScope = isAllRooms
      ? devices
      : devices.filter((d) => d.room === targetRoomId);

    const filterType = options.device_type || "all";
    const controllable = devicesInScope.filter((d) => {
      // Exclude smart speakers from mass power actions
      if (this.isSpeaker(d)) return false;

      // Must support on_off capability
      const hasOnOff = d.capabilities?.some(
        (c) => c.type === "devices.capabilities.on_off"
      );
      if (!hasOnOff) return false;

      const t = (d.type || "").toLowerCase();
      if (filterType === "light") {
        return t.includes("light") || t.includes("lamp");
      }
      if (filterType === "socket") {
        return t.includes("socket") || t.includes("switch");
      }
      if (filterType === "climate") {
        return (
          t.includes("thermostat") ||
          t.includes("ac") ||
          t.includes("heater") ||
          t.includes("humidifier") ||
          t.includes("fan")
        );
      }
      return true; // "all"
    });

    if (controllable.length === 0) {
      throw new YandexApiError(
        `No controllable ${filterType === "all" ? "" : filterType + " "}devices found in ${
          isAllRooms ? "the house" : `room "${targetRoomName}"`
        }.`
      );
    }

    const turnOn = options.action === "turn_on";
    const batchRequests = controllable.map((d) => ({
      id: d.id,
      actions: [
        {
          type: "devices.capabilities.on_off",
          state: {
            instance: "on",
            value: turnOn,
          },
        },
      ],
    }));

    if (this.quasarClient && this.quasarClient.hasCookie()) {
      try {
        const responses = await Promise.all(
          batchRequests.map((req) => this.quasarClient!.sendDeviceActions(req.id, req.actions))
        );
        return {
          status: "ok",
          room: targetRoomName,
          action: options.action,
          deviceType: filterType,
          affectedCount: controllable.length,
          affectedDevices: controllable.map((d) => ({
            id: d.id,
            name: d.name,
            room: (d.room && roomMap.get(d.room)) || "Не указана",
            type: d.type,
          })),
          apiResponse: responses,
        };
      } catch {
        // Fall through to official IoT API
      }
    }

    const response = await this.getClient().sendDeviceActions(batchRequests);

    return {
      status: "ok",
      room: targetRoomName,
      action: options.action,
      deviceType: filterType,
      affectedCount: controllable.length,
      affectedDevices: controllable.map((d) => ({
        id: d.id,
        name: d.name,
        room: (d.room && roomMap.get(d.room)) || "Не указана",
        type: d.type,
      })),
      apiResponse: response,
    };
  }

  /**
   * Get an aggregated summary of the entire home or a specific room
   */
  async getHomeSummary(roomQuery?: string): Promise<HomeSummaryResult> {
    const info = await this.getUserInfo();
    const roomMap = this.buildRoomMap(info.rooms);
    let devices = info.devices || [];

    let scope = "Весь дом";
    if (roomQuery && !["all", "все", "весь дом"].includes(roomQuery.trim().toLowerCase())) {
      const q = roomQuery.trim().toLowerCase();
      const matchedRoom = (info.rooms || []).find(
        (r) => r.id === roomQuery || r.name.toLowerCase() === q || r.name.toLowerCase().includes(q)
      );
      if (matchedRoom) {
        scope = matchedRoom.name;
        devices = devices.filter((d) => d.room === matchedRoom.id);
      } else {
        const available = (info.rooms || []).map((r) => r.name).join(", ");
        throw new YandexApiError(
          `Room "${roomQuery}" not found. Available rooms: ${available || "none"}`
        );
      }
    }

    // 1. Climate aggregation by room
    const climateByRoom = new Map<
      string,
      { room: string; temperature?: number; humidity?: number; pressure?: number; devices: string[] }
    >();

    for (const d of devices) {
      const rName = (d.room && roomMap.get(d.room)) || "Без комнаты";
      let hasClimate = false;
      let temp: number | undefined;
      let hum: number | undefined;
      let press: number | undefined;

      if (d.properties) {
        for (const p of d.properties) {
          const inst = p.state?.instance || p.parameters?.instance;
          const val = p.state?.value;
          if (inst === "temperature" && typeof val === "number") {
            temp = Math.round(val * 10) / 10;
            hasClimate = true;
          } else if (inst === "humidity" && typeof val === "number") {
            hum = Math.round(val * 10) / 10;
            hasClimate = true;
          } else if (inst === "pressure" && typeof val === "number") {
            press = Math.round(val);
            hasClimate = true;
          }
        }
      }

      if (hasClimate) {
        const existing = climateByRoom.get(rName) || {
          room: rName,
          devices: [],
        };
        if (temp !== undefined) existing.temperature = temp;
        if (hum !== undefined) existing.humidity = hum;
        if (press !== undefined) existing.pressure = press;
        if (!existing.devices.includes(d.name)) existing.devices.push(d.name);
        climateByRoom.set(rName, existing);
      }
    }

    // 2. Security & Sensors
    const security: HomeSummaryResult["security"] = [];
    for (const d of devices) {
      const rName = (d.room && roomMap.get(d.room)) || "Без комнаты";
      if (d.properties) {
        for (const p of d.properties) {
          const inst = p.state?.instance || p.parameters?.instance;
          const val = p.state?.value;
          if (inst === "open") {
            security.push({
              name: d.name,
              room: rName,
              type: "Датчик открытия",
              status: val ? "Открыто 🔴" : "Закрыто 🟢",
              details: { open: val },
            });
          } else if (inst === "motion") {
            const detected = val === "detected" || val === true;
            security.push({
              name: d.name,
              room: rName,
              type: "Датчик движения",
              status: detected ? "Движение обнаружено ⚠️" : "Спокойно 🟢",
              details: { motion: val },
            });
          } else if (inst === "illumination") {
            const lux = typeof val === "number" ? Math.round(val * 10) / 10 : val;
            security.push({
              name: d.name,
              room: rName,
              type: "Освещенность",
              status: `${lux} люкс`,
              details: { illumination: lux },
            });
          } else if (inst === "vibration") {
            security.push({
              name: d.name,
              room: rName,
              type: "Датчик вибрации",
              status: String(val),
            });
          } else if (inst === "water_leak") {
            const leak = val === "leak" || val === true;
            security.push({
              name: d.name,
              room: rName,
              type: "Датчик протечки",
              status: leak ? "ПРОТЕЧКА 🚨" : "Сухо 🟢",
            });
          }
        }
      }
    }

    // 3. Lights
    const lightDevices = devices.filter((d) => (d.type || "").toLowerCase().includes("light"));
    let lightsOn = 0;
    const activeLights: Array<{ name: string; room: string; brightness?: number }> = [];

    for (const d of lightDevices) {
      const onOff = d.capabilities?.find((c) => c.type === "devices.capabilities.on_off");
      const isOn = onOff?.state?.value === true;
      if (isOn) {
        lightsOn++;
        const brightCap = d.capabilities?.find(
          (c) => c.type === "devices.capabilities.range" && c.parameters?.instance === "brightness"
        );
        activeLights.push({
          name: d.name,
          room: (d.room && roomMap.get(d.room)) || "Не указана",
          brightness: brightCap?.state?.value,
        });
      }
    }

    // 4. Sockets & Power
    const socketDevices = devices.filter(
      (d) => (d.type || "").toLowerCase().includes("socket") || (d.type || "").toLowerCase().includes("switch")
    );
    let totalPowerW = 0;
    let socketsOn = 0;
    const socketDetails: HomeSummaryResult["sockets"]["devices"] = [];

    for (const d of socketDevices) {
      const onOff = d.capabilities?.find((c) => c.type === "devices.capabilities.on_off");
      const isOn = onOff?.state?.value === true;
      if (isOn) socketsOn++;

      let powerW: number | undefined;
      let voltageV: number | undefined;
      let amperageA: number | undefined;

      if (d.properties) {
        for (const p of d.properties) {
          const inst = p.state?.instance || p.parameters?.instance;
          const val = p.state?.value;
          if (inst === "power" && typeof val === "number") {
            powerW = Math.round(val * 10) / 10;
            totalPowerW += val;
          } else if (inst === "voltage" && typeof val === "number") {
            voltageV = Math.round(val * 10) / 10;
          } else if (inst === "amperage" && typeof val === "number") {
            amperageA = Math.round(val * 100) / 100;
          }
        }
      }

      socketDetails.push({
        name: d.name,
        room: (d.room && roomMap.get(d.room)) || "Не указана",
        isOn,
        powerW,
        voltageV,
        amperageA,
      });
    }

    // 5. Battery levels
    const batteries: HomeSummaryResult["batteries"] = [];
    for (const d of devices) {
      if (d.properties) {
        const batProp = d.properties.find(
          (p) => (p.state?.instance || p.parameters?.instance) === "battery_level"
        );
        if (batProp && typeof batProp.state?.value === "number") {
          const level = Math.round(batProp.state.value * 10) / 10;
          batteries.push({
            name: d.name,
            room: (d.room && roomMap.get(d.room)) || "Не указана",
            level,
            warning: level < 20,
          });
        }
      }
    }
    batteries.sort((a, b) => a.level - b.level);

    // 6. Offline devices
    const offlineDevices = devices
      .filter((d) => d.state === "offline")
      .map((d) => ({
        name: d.name,
        room: (d.room && roomMap.get(d.room)) || "Не указана",
        type: d.type,
      }));

    return {
      scope,
      timestamp: new Date().toISOString(),
      totalDevices: devices.length,
      climate: Array.from(climateByRoom.values()),
      security,
      lights: {
        total: lightDevices.length,
        onCount: lightsOn,
        offCount: lightDevices.length - lightsOn,
        activeLights,
      },
      sockets: {
        total: socketDevices.length,
        onCount: socketsOn,
        totalPowerW: Math.round(totalPowerW * 10) / 10,
        devices: socketDetails,
      },
      batteries,
      offlineDevices,
    };
  }

  /**
   * Get real-time status, capabilities, and telemetry properties of a smart home device
   */
  async getDeviceState(options: {
    device: string;
    room?: string;
  }) {
    const { device: matchedDevice, roomName } = await this.resolveDevice(options.device, options.room);
    let detailed: any;
    if (this.quasarClient && this.quasarClient.hasCookie()) {
      try {
        detailed = await this.quasarClient.getDevice(matchedDevice.id);
      } catch {
        // Fall through to official IoT API
      }
    }
    if (!detailed) {
      detailed = await this.getClient().getDevice(matchedDevice.id);
    }

    const propertiesSummary: Array<{
      name: string;
      instance: string;
      value: any;
      unit?: string;
    }> = [];

    if (detailed.properties && detailed.properties.length > 0) {
      for (const prop of detailed.properties) {
        if (prop.state) {
          const instance = prop.state.instance || prop.parameters?.instance || "unknown";
          const unit = prop.parameters?.unit || "";
          propertiesSummary.push({
            name: instance,
            instance,
            value: prop.state.value,
            unit,
          });
        }
      }
    }

    const capabilitiesSummary: Array<{
      type: string;
      instance?: string;
      value?: any;
    }> = [];

    if (detailed.capabilities && detailed.capabilities.length > 0) {
      for (const cap of detailed.capabilities) {
        capabilitiesSummary.push({
          type: cap.type,
          instance: cap.state?.instance || cap.parameters?.instance,
          value: cap.state?.value,
        });
      }
    }

    return {
      status: "ok",
      device: {
        id: detailed.id,
        name: detailed.name,
        room: roomName,
        type: detailed.type,
        state: detailed.state || "online",
      },
      properties: propertiesSummary,
      capabilities: capabilitiesSummary,
      raw: detailed,
    };
  }

  /**
   * Query historical telemetry and calculate energy usage for a smart device
   */
  async getDeviceHistory(options: {
    device: string;
    room?: string;
    metric?: string;
    from?: string;
    to?: string;
    resolution?: "max" | "1m" | "5m" | "15m" | "1h";
  }): Promise<TelemetryHistoryResult> {
    const { device, roomName } = await this.resolveDevice(options.device, options.room);

    // Parse time range
    const now = Date.now();
    let toTs = now;
    if (options.to && options.to !== "now") {
      const parsed = Date.parse(options.to);
      if (!isNaN(parsed)) toTs = parsed;
    }

    let fromTs = new Date().setHours(0, 0, 0, 0); // default to start of today
    if (options.from) {
      if (options.from === "24h") {
        fromTs = now - 24 * 60 * 60 * 1000;
      } else if (options.from === "7d") {
        fromTs = now - 7 * 24 * 60 * 60 * 1000;
      } else if (options.from === "today") {
        fromTs = new Date().setHours(0, 0, 0, 0);
      } else {
        const parsed = Date.parse(options.from);
        if (!isNaN(parsed)) fromTs = parsed;
      }
    }

    if (fromTs > toTs) {
      throw new YandexApiError("Invalid time range: 'from' must be earlier than 'to'.");
    }

    // Default resolution based on range duration
    let res = options.resolution;
    if (!res) {
      const durationMs = toTs - fromTs;
      if (durationMs <= 4 * 60 * 60 * 1000) {
        res = "max";
      } else if (durationMs <= 24 * 60 * 60 * 1000) {
        res = "5m";
      } else {
        res = "15m";
      }
    }

    const storage = this.getStorage();
    const result = storage.queryHistory({
      deviceId: device.id,
      metric: options.metric || "power",
      from: fromTs,
      to: toTs,
      resolution: res,
    });

    // Ensure resolved human-readable device and room name
    result.deviceName = device.name;
    result.roomName = roomName;

    return result;
  }
}

