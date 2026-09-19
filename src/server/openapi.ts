export function getOpenApiSpec(baseUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Yandex Alice Smart Speaker Control API",
      description:
        "REST API for ChatGPT Actions and external clients to control Yandex Alice smart speakers (Яндекс Станция) and Smart Home scenarios.",
      version: "1.0.0",
    },
    servers: [
      {
        url: baseUrl,
        description: "mctl-alice API server",
      },
    ],
    security: [
      {
        BearerAuth: [],
      },
    ],
    paths: {
      "/api/devices": {
        get: {
          operationId: "listDevices",
          summary: "List all smart speakers, rooms, and scenarios",
          description:
            "Returns all discovered Yandex Alice speakers, household rooms, and available automation scenarios.",
          parameters: [
            {
              name: "only_speakers",
              in: "query",
              required: false,
              schema: {
                type: "boolean",
                default: false,
              },
              description: "If true, only returns speakers instead of all IoT devices.",
            },
          ],
          responses: {
            "200": {
              description: "List of devices and scenarios",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", example: "ok" },
                      speakers: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            room: { type: "string" },
                            type: { type: "string" },
                            state: { type: "string" },
                          },
                        },
                      },
                      rooms: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                          },
                        },
                      },
                      scenarios: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            isActive: { type: "boolean" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/say": {
        post: {
          operationId: "sayPhrase",
          summary: "Speak a phrase aloud through a Yandex Alice smart speaker (TTS)",
          description:
            "Pronounces the given text phrase through the target smart speaker using Alice's voice. If device is omitted, the default speaker is used.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["phrase"],
                  properties: {
                    phrase: {
                      type: "string",
                      description: "The text phrase for Alice to say aloud.",
                      example: "Завтрак готов, идите к столу!",
                    },
                    device: {
                      type: "string",
                      description:
                        "Target speaker name, room name (e.g. 'Кухня', 'Детская'), or speaker ID. Defaults to first available speaker.",
                      example: "Кухня",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Phrase spoken successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", example: "ok" },
                      phrase: { type: "string" },
                      speaker: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                          room: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/command": {
        post: {
          operationId: "sendCommand",
          summary: "Execute a voice command on a Yandex Alice speaker",
          description:
            "Simulates a voice command as if spoken directly to Alice (e.g. 'включи джаз', 'выключи свет', 'погода на завтра').",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["command"],
                  properties: {
                    command: {
                      type: "string",
                      description: "Voice command to execute.",
                      example: "включи джаз",
                    },
                    device: {
                      type: "string",
                      description: "Target speaker name, room name, or ID.",
                      example: "Станция Миди",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Command executed successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", example: "ok" },
                      command: { type: "string" },
                      speaker: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                          room: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/volume": {
        post: {
          operationId: "setVolume",
          summary: "Set volume level on a Yandex Alice speaker",
          description: "Sets the volume level from 1 (minimum) to 10 (maximum).",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["level"],
                  properties: {
                    level: {
                      type: "integer",
                      minimum: 1,
                      maximum: 10,
                      description: "Volume level between 1 and 10.",
                      example: 5,
                    },
                    device: {
                      type: "string",
                      description: "Target speaker name, room name, or ID.",
                      example: "Кухня",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Volume updated successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", example: "ok" },
                      volume: { type: "integer" },
                      speaker: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                          room: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/media": {
        post: {
          operationId: "mediaControl",
          summary: "Control media playback on a speaker",
          description: "Controls playback: play, pause, stop, next track, or previous track.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["action"],
                  properties: {
                    action: {
                      type: "string",
                      enum: ["play", "pause", "stop", "next", "prev"],
                      description: "Playback action to perform.",
                      example: "pause",
                    },
                    device: {
                      type: "string",
                      description: "Target speaker name, room name, or ID.",
                      example: "Кухня",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Media action executed successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", example: "ok" },
                      action: { type: "string" },
                      speaker: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                          room: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/scenarios/trigger": {
        post: {
          operationId: "triggerScenario",
          summary: "Trigger a Smart Home automation scenario",
          description: "Executes a predefined smart home scenario by name or scenario ID.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["scenario"],
                  properties: {
                    scenario: {
                      type: "string",
                      description: "Name (e.g. 'Тишины хочу', 'Доброе утро') or ID of the scenario.",
                      example: "Тишины хочу",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Scenario triggered successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", example: "ok" },
                      scenario: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Yandex OAuth token or API Key provided as Bearer token.",
        },
      },
    },
  };
}
