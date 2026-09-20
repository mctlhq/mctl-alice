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
  {
    name: "alice_control_device",
    description:
      "Directly control a smart home device (air conditioner, light, socket, heater, fan, switch) via official Yandex IoT API without needing speaker cookies. Turn on/off, set temperature or AC mode.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name or ID (e.g. 'Кондиционер', 'Свет над столом', 'Розетка', 'Обогреватель', 'Вентилятор').",
        },
        room: {
          type: "string",
          description:
            "Room name where the device is located (e.g. 'Кухня', 'Детская'). Helpful when multiple devices share the same name.",
        },
        state: {
          type: "string",
          enum: ["on", "off"],
          description: "Turn the device on or off.",
        },
        temperature: {
          type: "number",
          description:
            "Target temperature in Celsius (for air conditioners or thermostats, e.g. 22).",
        },
        mode: {
          type: "string",
          enum: ["auto", "cool", "dry", "fan_only", "heat"],
          description: "Operating mode for AC or thermostat.",
        },
      },
      required: ["device"],
    },
  },
  {
    name: "alice_get_device_state",
    description:
      "Get real-time status and telemetry of any smart home device (socket power in Watts, voltage, current, climate sensor temperature, humidity, pressure, battery level, or on/off state) via official Yandex IoT API.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Device name or ID (e.g. 'Розетка', 'Кондиционер', 'Датчик климата', 'Вентилятор').",
        },
        room: {
          type: "string",
          description:
            "Room name where the device is located (e.g. 'Кухня', 'Детская'). Helpful when multiple devices share the same name.",
        },
      },
      required: ["device"],
    },
  },
  {
    name: "alice_get_device_history",
    description:
      "Get historical telemetry time-series, energy consumption (total kWh, peak/min/average power in Watts), and sensor charts for a smart home device. Data is sampled every minute.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description: "Device name or ID (e.g. 'Розетка', 'Датчик климата').",
        },
        room: {
          type: "string",
          description:
            "Room name where the device is located (e.g. 'Кухня', 'Спальня').",
        },
        metric: {
          type: "string",
          description:
            "Telemetry metric to retrieve: 'power' (Watts & kWh), 'voltage', 'amperage', 'temperature', 'humidity', 'pressure', 'battery_level', 'on_off', or 'all'. Defaults to 'power'.",
        },
        from: {
          type: "string",
          description:
            "Start of time range (ISO 8601 string e.g. '2026-09-20T00:00:00+02:00', or 'today', '24h', '7d'). Defaults to start of today.",
        },
        to: {
          type: "string",
          description:
            "End of time range (ISO 8601 string or 'now'). Defaults to current time.",
        },
        resolution: {
          type: "string",
          enum: ["max", "1m", "5m", "15m", "1h"],
          description:
            "Aggregation resolution: 'max' (or '1m') returns raw 1-minute samples; '5m', '15m', or '1h' groups by average to keep response compact.",
        },
      },
      required: ["device"],
    },
  },
];

