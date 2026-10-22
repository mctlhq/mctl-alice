import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // Every test that does not inject a telemetry store gets a private
      // in-memory one: parallel workers sharing ./data/telemetry.db raced on
      // its schema setup ("database is locked"), and a test run must never
      // open a contributor's real history.
      TELEMETRY_DB_PATH: ":memory:",
    },
  },
});
