import { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

const TOOL_DEFINITIONS: Tool[] = [
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
      "Get historical telemetry time-series, energy consumption (total kWh, peak/min/average power in Watts), and sensor charts for a smart home device. Works only on a self-hosted single-user server, which samples devices every minute; the hosted service (alice.mctl.ai) does not record history and returns an error.",
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
  {
    name: "alice_set_light",
    description:
      "Control smart lights, lamps, and chandeliers: turn on/off, adjust brightness (1-100%), adjust color temperature in Kelvin (1500K-6500K: warm, daylight, cool white), or set built-in lighting scenes (night, reading, party, candle, ocean, romance, alice, neon, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description:
            "Light device name or ID (e.g. 'Люстра', 'Лампа', 'Свет над столом').",
        },
        room: {
          type: "string",
          description:
            "Room name where the light is located (e.g. 'Кухня', 'Детская', 'Спальня').",
        },
        state: {
          type: "string",
          enum: ["on", "off"],
          description: "Turn the light on or off.",
        },
        brightness: {
          type: "number",
          description: "Brightness level percentage from 1 to 100.",
        },
        color_temp_k: {
          type: "number",
          description:
            "Color temperature in Kelvin (e.g. 2700 for warm incandescent, 4000 for neutral daylight, 6500 for cool white). Valid range: 1500 to 6500.",
        },
        scene: {
          type: "string",
          enum: [
            "night",
            "reading",
            "party",
            "candle",
            "ocean",
            "romance",
            "alice",
            "neon",
            "christmas",
            "siren",
            "alarm",
            "fantasy",
            "miracle",
            "autumn",
            "dawn",
            "sunset",
          ],
          description: "Built-in dynamic or static lighting scene.",
        },
      },
      required: ["device"],
    },
  },
  {
    name: "alice_control_room",
    description:
      "Batch control devices in a specific room or across the entire home in a single request (e.g. turn off all lights on the kitchen, turn off all devices in the living room, turn on all lights in the house).",
    inputSchema: {
      type: "object",
      properties: {
        room: {
          type: "string",
          description:
            "Target room name (e.g. 'Кухня', 'Гостиная', 'Спальня') or 'all'/'все' to target the entire home.",
        },
        action: {
          type: "string",
          enum: ["turn_on", "turn_off"],
          description: "Action to perform on matching devices.",
        },
        device_type: {
          type: "string",
          enum: ["light", "socket", "climate", "all"],
          description:
            "Filter target devices by category: 'light' (bulbs, chandeliers), 'socket' (outlets, plugs), 'climate' (AC, heaters, humidifiers), or 'all' (all on/off controllable devices). Defaults to 'all'.",
        },
      },
      required: ["room", "action"],
    },
  },
  {
    name: "alice_get_home_summary",
    description:
      "Get a single comprehensive status overview and health dashboard of the smart home (or a specific room): climate conditions (°C, humidity, pressure), security sensors (door open/closed, motion, illumination), lighting status, active sockets & power draw (Watts), and sensor battery levels.",
    inputSchema: {
      type: "object",
      properties: {
        room: {
          type: "string",
          description:
            "Optional room name to filter summary (e.g. 'Кухня', 'Спальня'). If omitted, returns summary for the whole home.",
        },
      },
    },
  },
  {
    name: "alice_get_my_identity",
    description:
      "Get the stable account ID of the mctl-alice account this connection is signed in to. Returns only the ID that the account page shows as \"ID\"; no name, login, e-mail, home or device data. Takes no arguments, reads nothing from Yandex and changes nothing. Works on the hosted service only.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

/**
 * MCP tool annotations, keyed by tool name. They are hints for clients and
 * approval flows (a client can auto-approve a read and ask before a write),
 * never a security control: access is enforced by the OAuth scopes in
 * handlers.ts. Without them a client cannot tell reading a sensor from
 * switching off every socket in the home.
 *
 * Every tool that reaches Yandex has openWorldHint true, which is the default
 * applied below. alice_get_my_identity is the one exception: it reads the
 * account record this server stores and calls no external service, so it
 * says false explicitly.
 * destructiveHint is true where one call can have wide or hard-to-undo
 * effect: an arbitrary voice command, a scenario (which can switch many
 * devices at once) and a bulk room/home switch. That is a conservative
 * judgement, not a claim that the call cannot be reversed. idempotentHint is
 * true only where the call sets an absolute state; next/prev, a spoken
 * phrase and a scenario run repeat their effect.
 */
const ANNOTATIONS: Record<string, ToolAnnotations> = {
  alice_list_devices: { title: "List Alice devices and rooms", readOnlyHint: true, idempotentHint: true },
  alice_get_device_state: { title: "Get device state", readOnlyHint: true, idempotentHint: true },
  alice_get_device_history: { title: "Get device history (self-hosted only)", readOnlyHint: true, idempotentHint: true },
  alice_get_home_summary: { title: "Get home summary", readOnlyHint: true, idempotentHint: true },
  alice_get_my_identity: { title: "Get my mctl-alice account ID", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  alice_say_phrase: { title: "Make a speaker say a phrase", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  alice_send_command: { title: "Send a voice command to Alice", readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  alice_set_volume: { title: "Set speaker volume", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  alice_media_control: { title: "Control speaker playback", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  alice_trigger_scenario: { title: "Run a smart home scenario", readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  alice_control_device: { title: "Control a device", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  alice_set_light: { title: "Control a light", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  alice_control_room: { title: "Switch devices in a room or the whole home", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

/**
 * The exported list is built from the definitions above and refuses to load
 * if a tool has no annotation entry, or an entry has no tool. A new tool that
 * is added without a decision about whether it reads or writes must fail at
 * startup and in the tests, not ship unannotated.
 */
export const ALICE_TOOLS: Tool[] = TOOL_DEFINITIONS.map((tool) => {
  const hints = ANNOTATIONS[tool.name];
  if (!hints) throw new Error(`tool ${tool.name} has no entry in ANNOTATIONS`);
  // openWorldHint stays the last key, so adding the exception did not
  // reorder the serialized annotations of the tools that existed before it.
  return { ...tool, annotations: { ...hints, openWorldHint: hints.openWorldHint ?? true } };
});

for (const name of Object.keys(ANNOTATIONS)) {
  if (!TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
    throw new Error(`ANNOTATIONS names ${name}, which is not a defined tool`);
  }
}
