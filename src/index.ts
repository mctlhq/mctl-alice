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
import { createHttpServer } from "./server/http-server.js";

async function runStdioServer() {
  const token = process.env.YANDEX_OAUTH_TOKEN;
  if (!token) {
    console.error(
      "⚠️ [mctl-alice] Warning: YANDEX_OAUTH_TOKEN is not set in environment or .env file."
    );
    console.error(
      "Run 'npm run auth' to log in via browser and save the token automatically."
    );
  }

  let stationService: StationService;
  try {
    const client = new YandexIoTClient(token);
    stationService = new StationService(client);
  } catch (err: any) {
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

async function runHttpServer(port: number) {
  const server = createHttpServer(port);
  server.listen(port, "0.0.0.0", () => {
    console.log(`🚀 [mctl-alice] HTTP server listening on http://0.0.0.0:${port}`);
    console.log(`   - MCP JSON-RPC: POST /mcp`);
    console.log(`   - Health check: GET /healthz`);
    console.log(`   - Web login:    GET /auth/login`);
  });
}

async function main() {
  const isHttpMode = Boolean(process.env.PORT) || process.argv.includes("--http");
  if (isHttpMode) {
    const port = parseInt(process.env.PORT || "8080", 10);
    await runHttpServer(port);
  } else {
    await runStdioServer();
  }
}

main().catch((err) => {
  console.error("❌ [mctl-alice] Fatal error:", err);
  process.exit(1);
});
