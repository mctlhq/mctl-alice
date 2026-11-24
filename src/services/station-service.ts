import { YandexIoTClient, YandexApiError } from "../client/yandex-api.js";
import { QuasarClient } from "../client/quasar-client.js";
import {
  YandexDevice,
  YandexRoom,
  YandexScenario,
  YandexUserInfo,
  SpeakerInfo,
} from "../client/types.js";
import { ITelemetryStorage, TelemetryHistoryResult } from "../storage/telemetry-storage.js";
import { createTelemetryStorage } from "../storage/index.js";
import { playMusicCommand } from "../tools/music-query.js";

/** The hosted service runs no sampler (2.2.2), so it has no history to serve. */
export const HOSTED_HISTORY_UNAVAILABLE =
  "Device history is not recorded in the hosted service, so there is no history to return. " +
  "Use alice_get_device_state for current readings.";

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

/**
 * One device of the structured listing. `room` and `household` are the names
 * Yandex reports and null when it reports none: a missing name is never
 * replaced by a placeholder a reader could take for a real one.
 */
export interface ListedDevice {
  id: string;
  name: string;
  /** The raw Yandex type, e.g. "devices.types.light". */
  type: string;
  isSpeaker: boolean;
  room: string | null;
  household: string | null;
}

export interface DeviceListResult {
  /** Every listed device (speakers only when asked), in the order Yandex returns them. */
  devices: ListedDevice[];
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

/**
 * A write that was refused before anything was sent to Yandex: a value
 * outside the range the device reports, a setting the device has no
 * capability for, or a target that is not what the tool accepts. The write
 * tools refuse instead of clamping, rounding or dropping, because a caller
 * that was told "done" must be able to rely on the value it asked for.
 */
export class WriteRefusedError extends Error {
  /** For the REST routes, which answer with err.statusCode: the request was understood and refused. */
  readonly statusCode = 422;
  constructor(message: string) {
    super(`${message} Nothing was sent.`);
    this.name = "WriteRefusedError";
  }
}

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Refuses a value that is not a number inside [min, max]; whole numbers only when `whole`. */
function requireInRange(what: string, value: number, min: number, max: number, deviceName: string, whole: boolean): void {
  const range = `${min} to ${max}`;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WriteRefusedError(`${what} must be a number from ${range} for "${deviceName}".`);
  }
  if (whole && !Number.isInteger(value)) {
    throw new WriteRefusedError(`${what} must be a whole number from ${range} for "${deviceName}"; ${value} is not.`);
  }
  if (value < min || value > max) {
    throw new WriteRefusedError(`${what} ${value} is outside the allowed range ${range} for "${deviceName}".`);
  }
}

function requireOnOff(state: unknown): void {
  if (state !== "on" && state !== "off") {
    throw new WriteRefusedError(`state must be "on" or "off".`);
  }
}

/** The shape alice_play_music accepts as a device id: never a name or a room. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Throws when Yandex answered the request but reported the action itself as
 * failed. Yandex returns HTTP 200 with a per-device or per-capability
 * action_result in that case, so the HTTP status alone says nothing.
 */
function assertActionDone(response: any, deviceName: string): void {
  const failed = (result: any): string | null =>
    result?.status === "ERROR" ? String(result.error_code || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 64) || "ERROR" : null;
  if (response?.status !== "ok") {
    throw new YandexApiError(`Yandex did not confirm the action on "${deviceName}".`);
  }
  for (const device of Array.isArray(response.devices) ? response.devices : []) {
    const codes = [failed(device?.action_result)];
    for (const cap of Array.isArray(device?.capabilities) ? device.capabilities : []) {
      codes.push(failed(cap?.state?.action_result));
    }
    const code = codes.find((c) => c !== null);
    if (code) throw new YandexApiError(`Yandex reported that the action on "${deviceName}" failed (${code}).`);
  }
}

/**
 * Picks the match from the first non-empty tier. Several matches in that tier
 * are an error: acting on the first one would control a device or run a
 * scenario the caller did not mean.
 */
function uniqueMatch<T extends { id: string }>(tiers: T[][], subject: string, label: (item: T) => string): T | undefined {
  for (const tier of tiers) {
    const distinct = tier.filter((item, i) => tier.findIndex((other) => other.id === item.id) === i);
    if (distinct.length === 1) return distinct[0];
    if (distinct.length > 1) {
      throw new YandexApiError(`${subject} is ambiguous: ${distinct.map(label).join(", ")}. Use the id or a more specific name.`);
    }
  }
  return undefined;
}

/**
 * Resolves a room by id, exact name, then substring, with the same ambiguity
 * rule as devices. Throws when nothing matches.
 */
function resolveRoom(rooms: Array<{ id: string; name: string }>, query: string): { id: string; name: string } {
  const norm = query.trim().toLowerCase();
  const room = uniqueMatch(
    [
      rooms.filter((r) => r.id === query),
      rooms.filter((r) => r.name.toLowerCase() === norm),
      rooms.filter((r) => r.name.toLowerCase().includes(norm)),
    ],
    `Room "${query}"`,
    (r) => `"${r.name}" (id: ${r.id})`,
  );
  if (!room) {
    const available = rooms.map((r) => `"${r.name}"`).join(", ");
    throw new YandexApiError(`Room "${query}" was not found. Available rooms: ${available || "none"}`);
  }
  return room;
}

/** Settles with `work`, or rejects after `ms`; the late result of `work` is swallowed. */
function withinMs<T>(work: Promise<T>, ms: number): Promise<T> {
  work.catch(() => {});
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("user info budget exhausted")), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export class StationService {
  private client: YandexIoTClient | null = null;
  private quasarClient: QuasarClient | null = null;
  private cachedUserInfo: YandexUserInfo | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 30000; // 30 seconds
  /** Total time getUserInfo may take across the IoT call and the Quasar fallback. Equals the IoT deadline. */
  private readonly USER_INFO_BUDGET_MS = 15000;

  private storage: ITelemetryStorage | null = null;

  constructor(
    client?: YandexIoTClient,
    quasarClient?: QuasarClient,
    storage?: ITelemetryStorage,
    private credentialsMode: "local" | "hosted" = "local"
  ) {
    if (client) {
      this.client = client;
    } else if (credentialsMode === "local") {
      try {
        this.client = new YandexIoTClient();
      } catch {
        this.client = null;
      }
    }
    if (quasarClient) {
      this.quasarClient = quasarClient;
    } else if (credentialsMode === "local") {
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

  getStorage(): ITelemetryStorage {
    if (!this.storage) {
      if (this.credentialsMode === "hosted") throw new Error(HOSTED_HISTORY_UNAVAILABLE);
      this.storage = createTelemetryStorage();
    }
    return this.storage;
  }

  setStorage(storage: ITelemetryStorage): void {
    this.storage = storage;
  }

  getQuasarClient(): QuasarClient | null {
    return this.quasarClient;
  }

  private getClient(): YandexIoTClient {
    if (!this.client) {
      if (this.credentialsMode === "hosted") throw new YandexApiError("Reconnect your Yandex IoT account.");
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
   * Fetch user info with simple in-memory caching and fallback to Quasar client if IoT token is missing/forbidden.
   * The IoT call and the fallback share one budget: before this, an IoT timeout (15 s) was followed by a
   * Quasar attempt of up to 10 s more, so a caller waited about 25 s for a single answer.
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
      const remainingMs = this.USER_INFO_BUDGET_MS - (Date.now() - now);
      if (remainingMs > 0 && this.quasarClient && this.quasarClient.hasCookie()) {
        try {
          const quasarInfo = await withinMs(this.getUserInfoFromQuasar(), remainingMs);
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
    const listed: ListedDevice[] = [];

    const householdNames = new Map<string, string>();
    for (const h of info.households || []) {
      if (h && typeof h.id === "string" && typeof h.name === "string" && h.name) householdNames.set(h.id, h.name);
    }
    const roomHousehold = new Map<string, string>();
    for (const r of info.rooms || []) {
      if (r.household_id) roomHousehold.set(r.id, r.household_id);
    }

    for (const device of info.devices || []) {
      const isSpeaker = this.isSpeaker(device);
      if (isSpeaker || !onlySpeakers) {
        const householdId = device.household_id || (device.room ? roomHousehold.get(device.room) : undefined);
        listed.push({
          id: device.id,
          name: device.name,
          type: device.type,
          isSpeaker,
          room: (device.room && roomMap.get(device.room)) || null,
          household: (householdId && householdNames.get(householdId)) || null,
        });
      }
      const roomName = (device.room && roomMap.get(device.room)) || "Не указана";
      const item = {
        id: device.id,
        name: device.name,
        room: roomName,
        type: device.type,
        state: device.state,
      };

      if (isSpeaker) {
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
      devices: listed,
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

    const inRoom = (s: (typeof speakers)[number]) => {
      const rName = (s.room && roomMap.get(s.room))?.toLowerCase() || "";
      return rName === searchQuery || rName.includes(searchQuery);
    };
    // ID, exact name, substring name, then room (smart speakers first).
    const match = uniqueMatch(
      [
        speakers.filter((s) => s.id === query),
        speakers.filter((s) => s.name.toLowerCase() === searchQuery),
        speakers.filter((s) => s.name.toLowerCase().includes(searchQuery)),
        speakers.filter((s) => inRoom(s) && s.type.startsWith("devices.types.smart_speaker")),
        speakers.filter(inRoom),
      ],
      `Speaker "${query}"`,
      (s) => `"${s.name}" (room: ${s.room ? roomMap.get(s.room) : "none"}, id: ${s.id})`,
    );
    if (match) return match;

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
    if (this.credentialsMode === "hosted" && !this.quasarClient?.hasCookie()) throw new Error("Connect Quasar in /auth/cookie to send commands.");
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
    if (this.credentialsMode === "hosted" && !this.quasarClient?.hasCookie()) throw new Error("Connect Quasar in /auth/cookie to speak phrases.");
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
   * Set speaker volume: a whole number inside the range the speaker reports (1-10 when it reports none)
   */
  async setVolume(level: number, targetSpeaker?: string) {
    const speaker = await this.resolveSpeaker(targetSpeaker);

    // Find volume capability parameters if present
    const volumeCap = speaker.capabilities.find(
      (c) => c.type === "devices.capabilities.range" && c.parameters?.instance === "volume"
    );

    // The range the speaker reports, else the 1-10 scale the tool documents.
    // A speaker does not always list a volume capability, so its absence is
    // not a refusal: that is the one case here where the range is assumed.
    // A level outside the range, or not a whole number, is refused; it used
    // to be clamped or rounded and reported as set.
    const range = volumeCap?.parameters?.range;
    requireInRange("Volume level", level, finiteOr(range?.min, 1), finiteOr(range?.max, 10), speaker.name, true);
    const targetValue = level;

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
   * Starts music on one speaker from a short query (alice_play_music).
   *
   * The speaker is named by its exact id and by nothing else. The command is
   * a fixed prefix plus the validated query, sent once through the official
   * IoT API as a quasar.server_action / text_action: there is no Quasar
   * cookie path and no fallback, so one call reaches the speaker at most
   * once. Every refusal happens before anything is sent.
   */
  async playMusic(deviceId: string, query: string) {
    // Throws on a query that is not plain words; see tools/music-query.ts.
    let command: string;
    try {
      command = playMusicCommand(query);
    } catch (err: any) {
      throw new WriteRefusedError(`The ${err.message}.`);
    }
    if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
      throw new WriteRefusedError("device must be the exact ID of a speaker from alice_list_devices, not a name or a room.");
    }
    const info = await this.getUserInfo();
    const matches = (info.devices || []).filter((d) => d.id === deviceId);
    if (matches.length !== 1 || !this.isSpeaker(matches[0])) {
      throw new WriteRefusedError(`No speaker has the ID "${deviceId}". Use an ID from alice_list_devices.`);
    }
    const speaker = matches[0];
    const canTakeText = (speaker.capabilities || []).some((c) => {
      if (c.type !== "devices.capabilities.quasar.server_action") return false;
      const instance = c.parameters?.instance ?? c.state?.instance;
      return instance === undefined || instance === "text_action";
    });
    if (!canTakeText) {
      throw new WriteRefusedError(`Speaker "${speaker.name}" does not report the capability that accepts a text command through the Yandex IoT API.`);
    }

    const response = await this.getClient().sendDeviceActions([
      {
        id: speaker.id,
        actions: [
          {
            type: "devices.capabilities.quasar.server_action",
            state: { instance: "text_action", value: command },
          },
        ],
      },
    ]);
    assertActionDone(response, speaker.name);

    return {
      status: "ok",
      speaker: { id: speaker.id, name: speaker.name },
      query,
      commandSent: command,
    };
  }

  /**
   * Trigger scenario by name or ID
   */
  async triggerScenario(nameOrId: string) {
    const info = await this.getUserInfo();
    const scenarios = info.scenarios || [];

    const query = nameOrId.trim().toLowerCase();
    const target = uniqueMatch(
      [
        scenarios.filter((s) => s.id === nameOrId),
        scenarios.filter((s) => s.name.toLowerCase() === query),
        scenarios.filter((s) => s.name.toLowerCase().includes(query)),
      ],
      `Scenario "${nameOrId}"`,
      (s) => `"${s.name}" (id: ${s.id})`,
    );

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
    // Filter by room if specified
    const room = roomQuery && roomQuery.trim() ? resolveRoom(info.rooms || [], roomQuery) : undefined;
    const candidates = room ? devices.filter((d) => d.room === room.id) : devices;

    // ID, exact name, then substring name, within the room when one is given.
    const match = uniqueMatch(
      [
        candidates.filter((d) => d.id === deviceQuery),
        candidates.filter((d) => d.name.toLowerCase() === dQuery),
        candidates.filter((d) => d.name.toLowerCase().includes(dQuery)),
      ],
      `Device "${deviceQuery}"${roomQuery ? ` in room "${roomQuery}"` : ""}`,
      (d) => `"${d.name}" (${d.room ? roomMap.get(d.room) : "no room"}, id: ${d.id})`,
    );

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

    // Each requested setting is either sent as asked or refuses the whole
    // call: a setting the device has no capability for used to be dropped,
    // and a temperature outside the device's range clamped, while the tool
    // reported success.
    const lacks = (what: string) =>
      new WriteRefusedError(`Device "${device.name}" (type ${device.type}) has no ${what} capability.`);

    // 1. On / Off capability
    if (options.state !== undefined) {
      requireOnOff(options.state);
      if (!device.capabilities?.some((c) => c.type === "devices.capabilities.on_off")) throw lacks("on/off");
      actions.push({
        type: "devices.capabilities.on_off",
        state: { instance: "on", value: options.state === "on" },
      });
    }

    // 2. Temperature capability (thermostat/AC range)
    if (options.temperature !== undefined) {
      const tempCap = device.capabilities?.find(
        (c) =>
          c.type === "devices.capabilities.range" &&
          c.parameters?.instance === "temperature"
      );
      if (!tempCap) throw lacks("temperature");
      const range = tempCap.parameters?.range;
      requireInRange("Temperature", options.temperature, finiteOr(range?.min, 16), finiteOr(range?.max, 30), device.name, false);
      actions.push({
        type: "devices.capabilities.range",
        state: { instance: "temperature", value: options.temperature },
      });
    }

    // 3. Mode capability (thermostat mode: cool, heat, auto, dry, fan_only)
    if (options.mode !== undefined) {
      const modeCap = device.capabilities?.find(
        (c) =>
          c.type === "devices.capabilities.mode" &&
          c.parameters?.instance === "thermostat"
      );
      if (!modeCap) throw lacks("thermostat mode");
      const modes = modeCap.parameters?.modes;
      if (Array.isArray(modes) && !modes.some((m: any) => m?.value === options.mode)) {
        const allowed = modes.map((m: any) => m?.value).filter((v: unknown) => typeof v === "string").join(", ");
        throw new WriteRefusedError(`Mode "${options.mode}" is not one "${device.name}" supports. Allowed: ${allowed || "none"}.`);
      }
      actions.push({
        type: "devices.capabilities.mode",
        state: { instance: "thermostat", value: options.mode },
      });
    }

    if (actions.length === 0) {
      throw new WriteRefusedError("No setting was given: pass state, temperature or mode.");
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

    // As in controlDevice: every requested setting is sent as asked or the
    // whole call is refused. Brightness and color temperature used to be
    // rounded and clamped into the device's range, and a setting the device
    // has no capability for dropped, with success reported either way.
    const lacks = (what: string) =>
      new WriteRefusedError(`Device "${device.name}" (type ${device.type}) has no ${what} capability.`);
    const colorCap = device.capabilities?.find(
      (c) => c.type === "devices.capabilities.color_setting"
    );

    // 1. On / Off capability
    if (options.state !== undefined) {
      requireOnOff(options.state);
      if (!device.capabilities?.some((c) => c.type === "devices.capabilities.on_off")) throw lacks("on/off");
      actions.push({
        type: "devices.capabilities.on_off",
        state: { instance: "on", value: options.state === "on" },
      });
    }

    // 2. Brightness capability
    if (options.brightness !== undefined) {
      const brightnessCap = device.capabilities?.find(
        (c) =>
          c.type === "devices.capabilities.range" &&
          c.parameters?.instance === "brightness"
      );
      if (!brightnessCap) throw lacks("brightness");
      const range = brightnessCap.parameters?.range;
      requireInRange("Brightness", options.brightness, finiteOr(range?.min, 1), finiteOr(range?.max, 100), device.name, true);
      actions.push({
        type: "devices.capabilities.range",
        state: { instance: "brightness", value: options.brightness },
      });
    }

    // 3. Color temperature capability (Kelvin). A color_setting capability
    // without temperature_k is a color-only light: it has no temperature.
    if (options.color_temp_k !== undefined) {
      const kelvin = colorCap?.parameters?.temperature_k;
      if (!kelvin || typeof kelvin !== "object") throw lacks("color temperature");
      requireInRange("Color temperature", options.color_temp_k, finiteOr(kelvin.min, 1500), finiteOr(kelvin.max, 6500), device.name, true);
      actions.push({
        type: "devices.capabilities.color_setting",
        state: { instance: "temperature_k", value: options.color_temp_k },
      });
    }

    // 4. Lighting scene capability (night, reading, party, candle, etc.)
    if (options.scene !== undefined) {
      const scenes = colorCap?.parameters?.color_scene?.scenes;
      if (!Array.isArray(scenes)) throw lacks("lighting scene");
      const sceneId = String(options.scene).trim().toLowerCase();
      if (!scenes.some((sc: any) => sc?.id === sceneId)) {
        const allowed = scenes.map((sc: any) => sc?.id).filter((v: unknown) => typeof v === "string").join(", ");
        throw new WriteRefusedError(`Scene "${sceneId}" is not one "${device.name}" supports. Allowed: ${allowed || "none"}.`);
      }
      actions.push({
        type: "devices.capabilities.color_setting",
        state: { instance: "scene", value: sceneId },
      });
    }

    if (actions.length === 0) {
      throw new WriteRefusedError("No setting was given: pass state, brightness, color_temp_k or scene.");
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
      const matchedRoom = resolveRoom(info.rooms || [], options.room);
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
      // Same id / exact / substring tiers and ambiguity rule as the other tools.
      const matchedRoom = resolveRoom(info.rooms || [], roomQuery);
      scope = matchedRoom.name;
      devices = devices.filter((d) => d.room === matchedRoom.id);
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
    if (this.credentialsMode === "hosted") throw new Error(HOSTED_HISTORY_UNAVAILABLE);
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
    const result = await storage.queryHistory({
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

