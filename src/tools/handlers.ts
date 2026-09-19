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
