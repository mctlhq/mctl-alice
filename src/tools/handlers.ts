import { StationService } from "../services/station-service.js";
import { YandexApiError } from "../client/yandex-api.js";

export function checkScope(name: string, scope?: string): boolean {
  if (!scope) return true; // Local or unrestricted mode
  const granted = new Set(scope.split(/\s+/));
  if (granted.has("*")) return true;

  switch (name) {
    case "alice_list_devices":
    case "alice_get_device_state":
    case "alice_get_home_summary":
    case "alice_get_device_history":
      return granted.has("iot:view") || granted.has("iot:control");

    case "alice_control_device":
    case "alice_control_devices_batch":
    case "alice_control_room":
    case "alice_execute_scenario":
    case "alice_set_volume":
    case "alice_playback_control":
      return granted.has("iot:control");

    case "alice_send_command":
    case "alice_say_phrase":
      return granted.has("quasar") || granted.has("iot:control");

    default:
      return true;
  }
}

export async function handleToolCall(
  name: string,
  args: any,
  stationService: StationService,
  scope?: string
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (scope && !checkScope(name, scope)) {
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

        return {
          content: [{ type: "text", text: text.trim() }],
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
        const level = Number(args?.level);
        if (isNaN(level)) {
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
        const state = args?.state as "on" | "off" | undefined;
        const temperature = typeof args?.temperature === "number" ? args.temperature : undefined;
        const mode = args?.mode ? String(args.mode).trim() : undefined;

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
        const state = args?.state as any;
        const brightness = args?.brightness !== undefined ? Number(args.brightness) : undefined;
        const color_temp_k = args?.color_temp_k !== undefined ? Number(args.color_temp_k) : undefined;
        const scene = args?.scene ? String(args.scene).trim() : undefined;

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

