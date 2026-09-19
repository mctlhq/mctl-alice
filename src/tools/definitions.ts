import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const ALICE_TOOLS: Tool[] = [
  {
    name: "alice_list_devices",
    description:
      "List all Yandex Alice smart speakers, rooms, and devices in the user's smart home. Use this to discover available speakers and their IDs.",
    inputSchema: {
      type: "object",
      properties: {
        only_speakers: {
          type: "boolean",
          description: "If true, only returns Alice smart speakers. Defaults to false.",
        },
      },
    },
  },
  {
    name: "alice_send_command",
    description:
      "Send an arbitrary voice command to Alice as text (e.g. 'включи джаз', 'поставь таймер на 15 минут', 'какая сегодня погода', 'выключи свет на кухне'). Alice executes it as if you spoke it aloud.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command for Alice to execute in Russian or supported language.",
        },
        device: {
          type: "string",
          description:
            "Target speaker ID, speaker name, or room name (e.g. 'Колонка в зале', 'Кухня'). If omitted, defaults to the default speaker.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "alice_say_phrase",
    description:
      "Make Alice speak a specific phrase aloud through the smart speaker (TTS announcement, notification, or reminder).",
    inputSchema: {
      type: "object",
      properties: {
        phrase: {
          type: "string",
          description: "The text phrase for Alice to say out loud.",
        },
        device: {
          type: "string",
          description:
            "Target speaker ID, speaker name, or room name. If omitted, defaults to the default speaker.",
        },
      },
      required: ["phrase"],
    },
  },
  {
    name: "alice_set_volume",
    description:
      "Set the volume level of a Yandex Alice smart speaker (usually on a scale from 1 to 10).",
    inputSchema: {
      type: "object",
      properties: {
        level: {
          type: "number",
          description: "Volume level from 1 (minimum) to 10 (maximum).",
        },
        device: {
          type: "string",
          description: "Target speaker ID, speaker name, or room name.",
        },
      },
      required: ["level"],
    },
  },
  {
    name: "alice_media_control",
    description:
      "Control media playback on the Yandex Alice smart speaker (pause, play, stop, next track, previous track).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["play", "pause", "stop", "next", "prev"],
          description: "Playback action to perform.",
        },
        device: {
          type: "string",
          description: "Target speaker ID, speaker name, or room name.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "alice_trigger_scenario",
    description:
      "Trigger a predefined Yandex Smart Home automation scenario by name or ID (e.g. 'Доброе утро', 'Спокойной ночи', 'Я ушел').",
    inputSchema: {
      type: "object",
      properties: {
        scenario: {
          type: "string",
          description: "The name or ID of the scenario to execute.",
        },
      },
      required: ["scenario"],
    },
  },
];
