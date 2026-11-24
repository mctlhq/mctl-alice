import { StationService } from "../services/station-service.js";
import { YandexApiError } from "../client/yandex-api.js";

export const TOOL_SCOPES: Record<string, string[]> = {
  alice_list_devices: ["iot:view", "iot:control"],
  alice_get_device_state: ["iot:view", "iot:control"],
  alice_get_home_summary: ["iot:view", "iot:control"],
  alice_get_device_history: ["iot:view", "iot:control"],
  alice_get_my_identity: ["iot:view", "iot:control"],
  alice_control_device: ["iot:control"],
  alice_set_light: ["iot:control"],
  alice_control_room: ["iot:control"],
  alice_trigger_scenario: ["iot:control"],
  alice_set_volume: ["iot:control"],
  alice_media_control: ["iot:control"],
  alice_play_music: ["iot:control"],
  alice_send_command: ["quasar"],
  alice_say_phrase: ["quasar"],
};

export function validScope(scope: string | undefined): scope is string {
  return !!scope?.trim() && scope.trim().split(/\s+/).every(s => ["iot:view", "iot:control", "quasar"].includes(s));
}

export function checkScope(name: string, scope?: string): boolean {
  if (scope === "*") return true; // Explicit local access only.
  const granted = new Set(scope?.split(/\s+/) || []);
  return (TOOL_SCOPES[name] || []).some(s => granted.has(s));
}

/**
 * What a tool may know about the caller beyond its scope. Only the hosted
 * multi-user server fills it in, from the access token of the request.
 */
export interface ToolCallContext {
  /**
   * Reads the stored account the access token belongs to. Left out wherever
   * there is no real per-request account: stdio and single-user HTTP mode.
   */
  getAccount?: () => Promise<AccountRecord | null | undefined> | AccountRecord | null | undefined;
}

interface AccountRecord {
  id?: unknown;
  yandexUid?: unknown;
}

export type ToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Reads an optional numeric argument. Absent (undefined, null) is undefined;
 * a number or a plain decimal string is that number; anything else is NaN,
 * which the service refuses with the allowed range. Number() alone would
 * turn null, "" and false into 0 and true into 1, and the write would then
 * carry a value nobody asked for.
 */
function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return NaN;
}

/** Reads an optional string argument; absent, null and "" are undefined. */
function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

/** Ids of the placeholder accounts that stand for "no real user". */
const PLACEHOLDER_ACCOUNT_IDS = ["legacy_user", "usr_local"];

/**
 * Longest account id the tool will return, and its alphabet: printable ASCII
 * without spaces. A client shows the id to a person for comparison with the
 * account page, so a value that could carry whitespace or control characters
 * is refused rather than passed on.
 */
export const MAX_ACCOUNT_ID_LENGTH = 128;
const ACCOUNT_ID_PATTERN = /^[\x21-\x7e]+$/;

const IDENTITY_UNAVAILABLE =
  "Ошибка: не удалось определить аккаунт mctl-alice для этого подключения. Идентификатор доступен только на размещённом сервисе для подключения, выполненного через вход в аккаунт.";

/**
 * alice_get_my_identity: the stable id of the account the token belongs to
 * and nothing else. It never calls Yandex and never writes. Every case in
 * which the id could not be read, or is not a usable id, is an error result:
 * a client that pins an account must not be handed an empty or invented id.
 */
async function getMyIdentity(context: ToolCallContext | undefined): Promise<ToolCallResult> {
  const unavailable: ToolCallResult = { content: [{ type: "text", text: IDENTITY_UNAVAILABLE }], isError: true };
  if (!context?.getAccount) return unavailable;
  let account: AccountRecord | null | undefined;
  try {
    account = await context.getAccount();
  } catch {
    // The storage error stays out of the result; it may describe the store.
    return unavailable;
  }
  if (!account || typeof account.id !== "string" || !account.id || PLACEHOLDER_ACCOUNT_IDS.includes(account.id)) return unavailable;
  const accountId = account.yandexUid;
  if (typeof accountId !== "string" || accountId.length > MAX_ACCOUNT_ID_LENGTH || !ACCOUNT_ID_PATTERN.test(accountId)) return unavailable;
  return {
    content: [{ type: "text", text: `account_id: ${accountId}` }],
    structuredContent: { account_id: accountId },
  };
}

export async function handleToolCall(
  name: string,
  args: any,
  stationService: StationService,
  scope: string = "*",
  context?: ToolCallContext
): Promise<ToolCallResult> {
  if (!checkScope(name, scope)) {
    return {
      content: [
        {
          type: "text",
          text: `Ошибка: недостаточно прав доступа. Для вызова инструмента '${name}' требуются соответствующие разрешения (текущий scope: '${scope}').`,
        },
      ],
      isError: true,
    };
  }

  if (name === "alice_get_my_identity") return getMyIdentity(context);

  try {
    switch (name) {
      case "alice_list_devices": {
        const onlySpeakers = Boolean(args?.only_speakers);
        const result = await stationService.listDevices(onlySpeakers);

        let text = `### Умный дом Яндекса\n\n`;

        text += `**Колонки с Алисой (${result.speakers.length}):**\n`;
        if (result.speakers.length === 0) {
          text += `  _(колонки не найдены)_\n`;
        } else {
          for (const s of result.speakers) {
            text += `- **${s.name}** (Комната: ${s.room}, ID: \`${s.id}\`, Статус: ${s.state || "онлайн"})\n`;
          }
        }

        if (result.rooms.length > 0) {
          text += `\n**Комнаты:** ${result.rooms.map((r) => r.name).join(", ")}\n`;
        }

        if (result.scenarios.length > 0) {
          text += `\n**Сценарии (${result.scenarios.length}):**\n`;
          for (const sc of result.scenarios) {
            text += `- ${sc.name} (ID: \`${sc.id}\`, ${sc.isActive ? "активен" : "выключен"})\n`;
          }
        }

        if (result.otherDevices && result.otherDevices.length > 0) {
          text += `\n**Другие устройства (${result.otherDevices.length}):**\n`;
          for (const d of result.otherDevices) {
            text += `- ${d.name} (${d.room}, тип: \`${d.type}\`)\n`;
          }
        }

        // The text above is unchanged and stays the only place a person
        // reads. structuredContent is for a program: every listed device
        // with its id and raw type, which the text gives for speakers only.
        return {
          content: [{ type: "text", text: text.trim() }],
          structuredContent: {
            only_speakers: onlySpeakers,
            devices: result.devices.map((d) => ({
              id: d.id,
              name: d.name,
              type: d.type,
              is_speaker: d.isSpeaker,
              room: d.room,
              household: d.household,
            })),
          },
        };
      }

      case "alice_send_command": {
        const command = String(args?.command || "").trim();
        if (!command) {
          return {
            content: [{ type: "text", text: "Ошибка: параметр 'command' обязателен." }],
            isError: true,
          };
        }
        const target = args?.device ? String(args.device) : undefined;
        const result = await stationService.sendCommand(command, target);

        return {
          content: [
            {
              type: "text",
              text: `Команда "${result.command}" успешно отправлена на колонку **${result.speaker.name}** (ID: \`${result.speaker.id}\`).`,
            },
          ],
        };
      }

      case "alice_say_phrase": {
        const phrase = String(args?.phrase || "").trim();
        if (!phrase) {
          return {
            content: [{ type: "text", text: "Ошибка: параметр 'phrase' обязателен." }],
            isError: true,
          };
        }
        const target = args?.device ? String(args.device) : undefined;
        const result = await stationService.sayPhrase(phrase, target);

        return {
          content: [
            {
              type: "text",
              text: `Алиса озвучила фразу "${result.phrase}" через колонку **${result.speaker.name}** (ID: \`${result.speaker.id}\`).`,
            },
          ],
        };
      }

      case "alice_set_volume": {
        const level = optionalNumber(args?.level);
        if (level === undefined || isNaN(level)) {
          return {
            content: [{ type: "text", text: "Ошибка: параметр 'level' должен быть числом." }],
            isError: true,
          };
        }
        const target = args?.device ? String(args.device) : undefined;
        const result = await stationService.setVolume(level, target);

        return {
          content: [
            {
              type: "text",
              text: `Громкость на колонке **${result.speaker.name}** установлена на **${result.volume}**.`,
            },
          ],
        };
      }

      case "alice_media_control": {
        const action = args?.action as "play" | "pause" | "stop" | "next" | "prev";
        if (!action || !["play", "pause", "stop", "next", "prev"].includes(action)) {
          return {
            content: [
              {
                type: "text",
                text: "Ошибка: параметр 'action' должен быть одним из: play, pause, stop, next, prev.",
              },
            ],
            isError: true,
          };
        }
        const target = args?.device ? String(args.device) : undefined;
        const result = await stationService.mediaControl(action, target);

        return {
          content: [
            {
              type: "text",
              text: `Действие медиа-контроля "${action}" (команда: "${result.commandSent}") отправлено на колонку **${result.speaker.name}**.`,
            },
          ],
        };
      }

      case "alice_play_music": {
        // Only these two arguments exist. An extra one is refused rather
        // than ignored: a caller that sent it expected it to matter.
        const extra = Object.keys(args && typeof args === "object" ? args : {}).filter((k) => k !== "device" && k !== "query");
        if (extra.length > 0 || typeof args?.device !== "string" || typeof args?.query !== "string") {
          return {
            content: [{ type: "text", text: "Ошибка: alice_play_music принимает только строковые параметры 'device' (точный ID колонки) и 'query'. Ничего не отправлено." }],
            isError: true,
          };
        }
        const result = await stationService.playMusic(args.device, args.query);

        return {
          content: [
            {
              type: "text",
              text: `Запрос музыки "${result.query}" (команда: "${result.commandSent}") отправлен на колонку **${result.speaker.name}** (ID: \`${result.speaker.id}\`).`,
            },
          ],
        };
      }

      case "alice_trigger_scenario": {
        const scenario = String(args?.scenario || "").trim();
        if (!scenario) {
          return {
            content: [{ type: "text", text: "Ошибка: параметр 'scenario' обязателен." }],
            isError: true,
          };
        }
        const result = await stationService.triggerScenario(scenario);

        return {
          content: [
            {
              type: "text",
              text: `Сценарий умного дома **${result.scenario.name}** (ID: \`${result.scenario.id}\`) успешно запущен.`,
            },
          ],
        };
      }

      case "alice_control_device": {
        const device = String(args?.device || "").trim();
        if (!device) {
          return {
            content: [{ type: "text", text: "Ошибка: параметр 'device' обязателен." }],
            isError: true,
          };
        }
        const room = args?.room ? String(args.room).trim() : undefined;
        const state = optionalString(args?.state) as "on" | "off" | undefined;
        const temperature = optionalNumber(args?.temperature);
        const mode = optionalString(args?.mode);

        const result = await stationService.controlDevice({
          device,
          room,
          state,
          temperature,
          mode,
        });

        const actionsSummary: string[] = [];
        if (state) actionsSummary.push(`состояние: ${state === "on" ? "включено" : "выключено"}`);
        if (temperature !== undefined) actionsSummary.push(`температура: ${temperature}°C`);
        if (mode) actionsSummary.push(`режим: ${mode}`);

        return {
          content: [
            {
              type: "text",
              text: `Устройство **${result.device.name}** (${result.device.room}) успешно обновлено: ${actionsSummary.join(", ")}.`,
            },
          ],
        };
      }

      case "alice_get_device_state": {
        const device = String(args?.device || "").trim();
        if (!device) {
          return {
            content: [{ type: "text", text: "Ошибка: параметр 'device' обязателен." }],
            isError: true,
          };
        }
        const room = args?.room ? String(args.room).trim() : undefined;
        const result = await stationService.getDeviceState({ device, room });

        let text = `### Состояние устройства: ${result.device.name}\n\n`;
        text += `- **Комната:** ${result.device.room}\n`;
        text += `- **Тип:** \`${result.device.type}\`\n`;
        text += `- **Статус сети:** ${result.device.state === "online" ? "🟢 В сети (online)" : "🔴 Не в сети (offline)"}\n`;

        const onOffCap = result.capabilities.find((c) => c.type === "devices.capabilities.on_off");
        if (onOffCap && onOffCap.value !== undefined) {
          text += `- **Состояние питания:** ${onOffCap.value ? "Включено" : "Выключено"}\n`;
        }

        if (result.properties.length > 0) {
          text += `\n**Телеметрия и показания датчиков:**\n`;
          for (const prop of result.properties) {
            const label = formatPropertyLabel(prop.instance);
            const unit = formatUnit(prop.unit);
            text += `- **${label}:** ${prop.value}${unit ? ` ${unit}` : ""}\n`;
          }
        } else {
          text += `\n_(нет доступных свойств датчиков/телеметрии)_\n`;
        }

        return {
          content: [{ type: "text", text: text.trim() }],
        };
      }

      case "alice_get_device_history": {
        const device = String(args?.device || "").trim();
        if (!device) {
          return {
            content: [{ type: "text", text: "Ошибка: параметр 'device' обязателен." }],
            isError: true,
          };
        }
        const room = args?.room ? String(args.room).trim() : undefined;
        const metric = args?.metric ? String(args.metric).trim() : "power";
        const from = args?.from ? String(args.from).trim() : undefined;
        const to = args?.to ? String(args.to).trim() : undefined;
        const resolution = args?.resolution as any;

        const result = await stationService.getDeviceHistory({
          device,
          room,
          metric,
          from,
          to,
          resolution,
        });

        const unitStr = formatUnit(result.unit);
        const metricLabel = formatPropertyLabel(result.metric);

        let text = `### История телеметрии: ${result.deviceName}${result.roomName ? ` (${result.roomName})` : ""}\n\n`;
        text += `- **Метрика:** ${metricLabel}${unitStr ? ` (${unitStr})` : ""}\n`;
        text += `- **Период:** ${result.fromIso} — ${result.toIso}\n`;
        text += `- **Дискретизация:** ${result.resolution} (${result.count} измерений)\n`;

        if (result.count === 0) {
          text += `\n⚠️ _За выбранный период накопленных измерений не найдено._ ` +
            `Фоновый сэмплинг записывает показатели каждую минуту. Попробуйте запросить данные позже.`;
          return { content: [{ type: "text", text: text.trim() }] };
        }

        if (result.metric === "power" && result.totalEnergyKWh !== undefined) {
          text += `\n**⚡ Энергетическая сводка:**\n`;
          text += `- **Суммарное потребление:** **${result.totalEnergyKWh} кВт·ч**\n`;
          text += `- **Пиковая (макс.) мощность:** **${result.max} Вт**\n`;
          text += `- **Минимальная мощность:** **${result.min} Вт**\n`;
          text += `- **Средняя мощность:** **${result.avg} Вт**\n`;
          text += `- **Текущая (последняя) мощность:** **${result.latest} Вт**\n`;
        } else {
          text += `\n**Статистика:**\n`;
          text += `- **Максимум:** ${result.max}${unitStr ? ` ${unitStr}` : ""}\n`;
          text += `- **Минимум:** ${result.min}${unitStr ? ` ${unitStr}` : ""}\n`;
          text += `- **Среднее:** ${result.avg}${unitStr ? ` ${unitStr}` : ""}\n`;
          text += `- **Последнее значение:** ${result.latest}${unitStr ? ` ${unitStr}` : ""}\n`;
        }

        text += `\n**Точки измерений:**\n`;
        const previewPoints =
          result.points.length > 60
            ? [...result.points.slice(0, 30), ...result.points.slice(-30)]
            : result.points;

        text += `| Время (ISO) | Значение${unitStr ? ` (${unitStr})` : ""} |${
          result.points[0]?.minValue !== undefined ? " Мин | Макс | Точек в корзине |" : ""
        }\n`;
        text += `|---|---|${
          result.points[0]?.minValue !== undefined ? "---|---|---|" : ""
        }\n`;

        let skippedDividerInserted = false;
        for (let i = 0; i < previewPoints.length; i++) {
          if (result.points.length > 60 && i === 30 && !skippedDividerInserted) {
            text += `| ... | ... (пропущено ${result.points.length - 60} точек) |${
              result.points[0]?.minValue !== undefined ? " ... | ... | ... |" : ""
            }\n`;
            skippedDividerInserted = true;
          }
          const p = previewPoints[i];
          const time = p.timeIso.replace("T", " ").substring(0, 19);
          if (p.minValue !== undefined) {
            text += `| ${time} | ${p.value} | ${p.minValue} | ${p.maxValue} | ${p.sampleCount} |\n`;
          } else {
            text += `| ${time} | ${p.value} |\n`;
          }
        }

        return {
          content: [{ type: "text", text: text.trim() }],
        };
      }

      case "alice_set_light": {
        const device = String(args?.device || "").trim();
        if (!device) {
          return {
            content: [{ type: "text", text: "Ошибка: параметр 'device' обязателен." }],
            isError: true,
          };
        }
        const room = args?.room ? String(args.room).trim() : undefined;
        const state = optionalString(args?.state) as "on" | "off" | undefined;
        const brightness = optionalNumber(args?.brightness);
        const color_temp_k = optionalNumber(args?.color_temp_k);
        const scene = optionalString(args?.scene);

        const result = await stationService.setLight({
          device,
          room,
          state,
          brightness,
          color_temp_k,
          scene,
        });

        let text = `### Управление светом: ${result.device.name}\n\n`;
        text += `- **Комната:** ${result.device.room}\n`;
        text += `- **Примененные изменения:**\n`;
        for (const action of result.actionsApplied) {
          if (action.type === "devices.capabilities.on_off") {
            text += `  • Питание: **${action.state.value ? "Включено" : "Выключено"}**\n`;
          } else if (action.type === "devices.capabilities.range" && action.state.instance === "brightness") {
            text += `  • Яркость: **${action.state.value}%**\n`;
          } else if (action.type === "devices.capabilities.color_setting" && action.state.instance === "temperature_k") {
            text += `  • Цветовая температура: **${action.state.value} K**\n`;
          } else if (action.type === "devices.capabilities.color_setting" && action.state.instance === "scene") {
            text += `  • Световая сцена: **${action.state.value}**\n`;
          } else {
            text += `  • ${action.state.instance}: ${action.state.value}\n`;
          }
        }

        return {
          content: [{ type: "text", text: text.trim() }],
        };
      }

      case "alice_control_room": {
        const room = String(args?.room || "").trim();
        if (!room) {
          return {
            content: [{ type: "text", text: "Ошибка: параметр 'room' обязателен." }],
            isError: true,
          };
        }
        const action = String(args?.action || "").trim() as any;
        if (!["turn_on", "turn_off"].includes(action)) {
          return {
            content: [{ type: "text", text: "Ошибка: параметр 'action' должен быть 'turn_on' или 'turn_off'." }],
            isError: true,
          };
        }
        const device_type = args?.device_type ? (String(args.device_type).trim() as any) : "all";

        const result = await stationService.controlRoom({
          room,
          action,
          device_type,
        });

        const actionText = action === "turn_on" ? "включены" : "выключены";
        let text = `### Пакетное управление: ${result.room}\n\n`;
        text += `Успешно **${actionText}** устройства (${result.affectedCount} шт., категория: \`${result.deviceType}\`):\n\n`;
        for (const d of result.affectedDevices) {
          text += `- **${d.name}** (${d.room}, тип: \`${d.type}\`)\n`;
        }

        return {
          content: [{ type: "text", text: text.trim() }],
        };
      }

      case "alice_get_home_summary": {
        const room = args?.room ? String(args.room).trim() : undefined;
        const summary = await stationService.getHomeSummary(room);

        let text = `### Сводка умного дома: ${summary.scope}\n\n`;
        text += `_Всего устройств в отчете: ${summary.totalDevices}_\n\n`;

        // 1. Climate
        text += `#### 🌡 Климат и температура\n`;
        if (summary.climate.length === 0) {
          text += `_(данные климата отсутствуют)_\n\n`;
        } else {
          for (const c of summary.climate) {
            const parts: string[] = [];
            if (c.temperature !== undefined) parts.push(`Температура: **${c.temperature}°C**`);
            if (c.humidity !== undefined) parts.push(`Влажность: **${c.humidity}%**`);
            if (c.pressure !== undefined) parts.push(`Давление: **${c.pressure} мм рт. ст.**`);
            text += `- **${c.room}:** ${parts.join(", ")} _(${c.devices.join(", ")})_\n`;
          }
          text += "\n";
        }

        // 2. Security
        text += `#### 🚪 Безопасность и датчики\n`;
        if (summary.security.length === 0) {
          text += `_(датчики безопасности не обнаружены)_\n\n`;
        } else {
          for (const s of summary.security) {
            text += `- **${s.name}** (${s.room}, ${s.type}): ${s.status}\n`;
          }
          text += "\n";
        }

        // 3. Lighting
        text += `#### 💡 Освещение\n`;
        text += `- Включено ламп: **${summary.lights.onCount}** из ${summary.lights.total}\n`;
        if (summary.lights.activeLights.length > 0) {
          for (const l of summary.lights.activeLights) {
            const bStr = l.brightness !== undefined ? `, яркость ${l.brightness}%` : "";
            text += `  • **${l.name}** (${l.room}${bStr})\n`;
          }
        }
        text += "\n";

        // 4. Sockets & Power
        text += `#### ⚡ Розетки и энергопотребление\n`;
        text += `- Включено розеток: **${summary.sockets.onCount}** из ${summary.sockets.total}\n`;
        text += `- Текущая суммарная мощность: **${summary.sockets.totalPowerW} Вт**\n`;
        if (summary.sockets.devices.length > 0) {
          for (const s of summary.sockets.devices) {
            const stateStr = s.isOn ? "Вкл 🟢" : "Выкл ⚪";
            const pStr = s.powerW !== undefined ? ` — **${s.powerW} Вт**` : "";
            const vStr = s.voltageV !== undefined ? `, ${s.voltageV} В` : "";
            text += `  • **${s.name}** (${s.room}): ${stateStr}${pStr}${vStr}\n`;
          }
        }
        text += "\n";

        // 5. Batteries
        if (summary.batteries.length > 0) {
          text += `#### 🔋 Заряд батарей\n`;
          for (const b of summary.batteries) {
            const warnIcon = b.warning ? " ⚠️ (низкий заряд)" : "";
            text += `- **${b.name}** (${b.room}): **${b.level}%**${warnIcon}\n`;
          }
          text += "\n";
        }

        // 6. Offline devices
        if (summary.offlineDevices.length > 0) {
          text += `#### 🔴 Не в сети (offline)\n`;
          for (const off of summary.offlineDevices) {
            text += `- **${off.name}** (${off.room}, тип: \`${off.type}\`)\n`;
          }
          text += "\n";
        }

        return {
          content: [{ type: "text", text: text.trim() }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Неизвестный инструмент: ${name}` }],
          isError: true,
        };
    }
  } catch (err: any) {
    const errorDetails =
      err instanceof YandexApiError
        ? `[YandexApiError ${err.statusCode || ""}] ${err.message}`
        : err.message || String(err);

    return {
      content: [{ type: "text", text: `Ошибка при выполнении ${name}: ${errorDetails}` }],
      isError: true,
    };
  }
}

function formatUnit(unit?: string): string {
  switch (unit) {
    case "unit.volt":
      return "В";
    case "unit.watt":
      return "Вт";
    case "unit.ampere":
      return "А";
    case "unit.temperature.celsius":
      return "°C";
    case "unit.percent":
      return "%";
    case "unit.pressure.mmhg":
      return "мм рт. ст.";
    case "unit.kilowatt_hour":
      return "кВт·ч";
    default:
      return unit ? unit.replace(/^unit\./, "") : "";
  }
}

function formatPropertyLabel(instance: string): string {
  switch (instance) {
    case "power":
      return "Текущая мощность";
    case "voltage":
      return "Напряжение";
    case "amperage":
      return "Сила тока";
    case "battery_level":
      return "Заряд батареи";
    case "temperature":
      return "Температура";
    case "humidity":
      return "Влажность";
    case "pressure":
      return "Давление";
    case "co2_level":
      return "Уровень CO2";
    case "electricity_meter":
      return "Суммарное энергопотребление";
    default:
      return instance;
  }
}

