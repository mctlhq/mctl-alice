import { StationService } from "../services/station-service.js";
import { YandexApiError } from "../client/yandex-api.js";

export async function handleToolCall(
  name: string,
  args: any,
  stationService: StationService
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
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

