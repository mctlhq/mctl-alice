import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ALICE_TOOLS } from "../src/tools/definitions.js";
import { TOOL_SCOPES } from "../src/tools/handlers.js";
import { DESCRIPTORS_FILE, REGENERATE_DESCRIPTORS, checkDescriptors, renderDescriptors } from "./support/tool-surface.js";

/**
 * docs/tool-descriptors.json is the committed tool surface of this server:
 * what tools/list returns, plus the scopes that admit each tool. A consumer
 * that snapshots the surface (the Personal Assistant in mctlhq/mctl-telegram)
 * reads it from there, and a reviewer sees every surface change as a diff of
 * one file. This test keeps the file equal to the registered tools
 * (mctlhq/mctl-alice#191).
 */

const clone = (): Tool[] => structuredClone(ALICE_TOOLS);

describe("docs/tool-descriptors.json", () => {
  it("equals the registered tools", () => {
    if (process.env.UPDATE_TOOL_DESCRIPTORS === "1") {
      writeFileSync(DESCRIPTORS_FILE, renderDescriptors(ALICE_TOOLS, TOOL_SCOPES));
    }
    // A missing file throws here and fails the test.
    const problems = checkDescriptors(readFileSync(DESCRIPTORS_FILE, "utf8"), ALICE_TOOLS, TOOL_SCOPES);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // The cases below prove the check can fail: each feeds it a registry that
  // differs from the committed file in one way.
  const committed = () => readFileSync(DESCRIPTORS_FILE, "utf8");

  it("fails on a changed description and names the tool and the command", () => {
    const tools = clone();
    tools.find((t) => t.name === "alice_set_volume")!.description += " Changed.";
    const problems = checkDescriptors(committed(), tools, TOOL_SCOPES);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("alice_set_volume (differs)");
    expect(problems[0]).toContain(REGENERATE_DESCRIPTORS);
  });

  it("fails on a changed input schema", () => {
    const tools = clone();
    (tools.find((t) => t.name === "alice_set_volume")!.inputSchema.properties as any).level.type = "integer";
    expect(checkDescriptors(committed(), tools, TOOL_SCOPES)[0]).toContain("alice_set_volume (differs)");
  });

  it("fails on a changed annotation", () => {
    const tools = clone();
    tools.find((t) => t.name === "alice_set_volume")!.annotations!.idempotentHint = false;
    expect(checkDescriptors(committed(), tools, TOOL_SCOPES)[0]).toContain("alice_set_volume (differs)");
  });

  it("fails on a changed scope", () => {
    const scopes = { ...TOOL_SCOPES, alice_set_volume: ["quasar"] };
    expect(checkDescriptors(committed(), ALICE_TOOLS, scopes)[0]).toContain("alice_set_volume (differs)");
  });

  it("fails on an added and on a removed tool", () => {
    const added = [...clone(), { ...clone()[0], name: "alice_new_tool" }];
    const scopes = { ...TOOL_SCOPES, alice_new_tool: ["iot:view"] };
    expect(checkDescriptors(committed(), added, scopes)[0]).toContain("alice_new_tool (registered, not in the file)");
    const removed = clone().filter((t) => t.name !== "alice_set_volume");
    expect(checkDescriptors(committed(), removed, TOOL_SCOPES)[0]).toContain("alice_set_volume (in the file, not registered)");
  });

  it("fails on a reordered registry", () => {
    expect(checkDescriptors(committed(), clone().reverse(), TOOL_SCOPES)[0]).toContain("order");
  });

  it("refuses a tool without a scope entry instead of listing it with none", () => {
    const { alice_set_volume: _dropped, ...scopes } = TOOL_SCOPES;
    expect(() => checkDescriptors(committed(), ALICE_TOOLS, scopes)).toThrow(/alice_set_volume has no entry in TOOL_SCOPES/);
  });

  it("fails on an unreadable file rather than treating it as empty", () => {
    for (const text of ["", "{", "[]", "{}", '{"tools":null}', '{"tools":[]}']) {
      const problems = checkDescriptors(text, ALICE_TOOLS, TOOL_SCOPES);
      expect(problems, `accepted ${JSON.stringify(text)}`).toHaveLength(1);
      expect(problems[0]).toContain(REGENERATE_DESCRIPTORS);
    }
  });
});
