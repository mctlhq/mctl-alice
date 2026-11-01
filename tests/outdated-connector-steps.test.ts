import { describe, it, expect } from "vitest";
import fs from "node:fs";

// ChatGPT's custom-connector flow is Plugins -> "+" -> custom MCP server (OpenAI, apps-sdk
// "connect from ChatGPT"); the Settings -> Apps & Connectors -> Developer mode path is gone.
describe("setup instructions", () => {
  for (const file of ["public/index.html", "public/assets/site.js", "src/server/pages.ts"]) {
    it(`${file} no longer sends users through Developer mode`, () => {
      const text = fs.readFileSync(file, "utf-8");
      expect(text).not.toMatch(/Developer mode/i);
      expect(text).not.toContain("Apps &amp; Connectors");
    });
  }
});
