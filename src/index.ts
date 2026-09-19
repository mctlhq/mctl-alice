#!/usr/bin/env node
import dotenv from "dotenv";
dotenv.config();

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ALICE_TOOLS } from "./tools/definitions.js";
import { handleToolCall } from "./tools/handlers.js";
import { StationService } from "./services/station-service.js";
import { YandexIoTClient } from "./client/yandex-api.js";

async function main() {
  const token = process.env.YANDEX_OAUTH_TOKEN;
  if (!token) {
    console.error(
      "⚠️ [mctl-alice] Warning: YANDEX_OAUTH_TOKEN is not set in environment or .env file."
    );
    console.error(
      "Please set YANDEX_OAUTH_TOKEN to control Yandex Alice smart speakers."
    );
  }

  let stationService: StationService;
  try {
    const client = new YandexIoTClient(token);
    stationService = new StationService(client);
  } catch (err: any) {
    console.error(`⚠️ [mctl-alice] Init warning: ${err.message}`);
    // Still allow server to start, requests will fail with informative message
    stationService = new StationService();
  }

  const server = new Server(
    {
      name: "mctl-alice",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tools list
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ALICE_TOOLS,
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, args, stationService);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 [mctl-alice] Server started on stdio transport");
}

main().catch((err) => {
  console.error("❌ [mctl-alice] Fatal error:", err);
  process.exit(1);
});
