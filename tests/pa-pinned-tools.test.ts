import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ALICE_TOOLS } from "../src/tools/definitions.js";
import { checkScope } from "../src/tools/handlers.js";
import {
  PA_PIN_FILE,
  REFRESH_PA_PIN,
  canonicalJson,
  checkPaPin,
  parsePaPin,
  renderPaPin,
  sha256Hex,
} from "./support/tool-surface.js";

/**
 * Drift guard for the tools the Personal Assistant pins
 * (mctlhq/mctl-alice#191, part of mctlhq/mctl-telegram#1312).
 *
 * The PA in mctlhq/mctl-telegram pins this server's read tools in
 * internal/pa/catalog/pin.json and, at run time, denies a pinned tool whose
 * live name, description, input schema or annotations differ from the pin.
 * That is deliberate there and silent here: before this test nothing told a
 * change in this repository that it was about to take a tool away from the
 * PA. It already happened once: the pin was taken before the annotations
 * were added to every tool, and nothing flagged it.
 *
 * docs/pa-pinned-tools.json is this repository's copy of that pin. Changing a
 * pinned tool fails here until the file is updated in the same pull request,
 * which is the acknowledgement that the pin in mctl-telegram is refreshed
 * too. docs/runbooks/tool-surface.md has the procedure.
 */

const clone = (): Tool[] => structuredClone(ALICE_TOOLS);
const PINNED = "alice_get_device_state";

describe("docs/pa-pinned-tools.json", () => {
  it("matches the registered tools the PA pins", () => {
    if (process.env.UPDATE_PA_PIN === "1") {
      writeFileSync(PA_PIN_FILE, renderPaPin(readFileSync(PA_PIN_FILE, "utf8"), ALICE_TOOLS));
    }
    // A missing or unparseable file throws here and fails the test.
    const problems = checkPaPin(readFileSync(PA_PIN_FILE, "utf8"), ALICE_TOOLS, checkScope);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("pins the four iot:view read tools", () => {
    // A pinned tool cannot leave the guard by being deleted from the file
    // alone: this list has to change too, in a diff a reviewer reads.
    const pin = parsePaPin(readFileSync(PA_PIN_FILE, "utf8"));
    expect(pin.required_scope).toBe("iot:view");
    expect(Object.keys(pin.tools).sort()).toEqual([
      "alice_get_device_history",
      "alice_get_device_state",
      "alice_get_home_summary",
      "alice_list_devices",
    ]);
  });

  it("hashes like mctl-telegram's catalog", () => {
    // Fixed vectors, so the canonical form cannot change without notice.
    // encoding/json with HTML escaping off: sorted keys, no whitespace,
    // "<" kept, U+2028 escaped, non-ASCII kept as UTF-8.
    expect(canonicalJson({ b: [1, { d: null, c: "<Кухня>" + String.fromCharCode(0x2028) }], a: true })).toBe(
      '{"a":true,"b":[1,{"c":"<Кухня>\\u2028","d":null}]}',
    );
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("Кухня")).toBe("535971f5724eb252837256f81c8e9c332fdf85137582a8df867ad9b427aab9dc");
  });

  // The cases below prove the guard can fail: each feeds it a registry that
  // differs from the committed pin in one way.
  const committed = () => readFileSync(PA_PIN_FILE, "utf8");
  const expectRefused = (problems: string[], finding: string) => {
    expect(problems).toContain(finding);
    expect(problems[problems.length - 1]).toBe(REFRESH_PA_PIN);
    expect(REFRESH_PA_PIN).toContain("go test ./internal/pa/catalog -run TestPinMatchesUpstream -update-pin");
  };

  it("fails on a changed description of a pinned tool", () => {
    const tools = clone();
    tools.find((t) => t.name === PINNED)!.description += " Changed.";
    expectRefused(checkPaPin(committed(), tools, checkScope), `${PINNED}: description changed`);
  });

  it("fails on a changed input schema of a pinned tool", () => {
    const tools = clone();
    (tools.find((t) => t.name === PINNED)!.inputSchema.properties as any).room.description += " Changed.";
    expectRefused(checkPaPin(committed(), tools, checkScope), `${PINNED}: input schema changed`);
  });

  it("fails on a changed, an added and a removed annotation of a pinned tool", () => {
    const changed = clone();
    changed.find((t) => t.name === PINNED)!.annotations!.title = "Changed";
    expectRefused(checkPaPin(committed(), changed, checkScope), `${PINNED}: annotations changed`);
    const added = clone();
    added.find((t) => t.name === PINNED)!.annotations!.destructiveHint = false;
    expectRefused(checkPaPin(committed(), added, checkScope), `${PINNED}: annotations changed`);
    const removed = clone();
    delete removed.find((t) => t.name === PINNED)!.annotations;
    expectRefused(checkPaPin(committed(), removed, checkScope), `${PINNED}: annotations changed`);
  });

  it("fails when a pinned tool is no longer registered", () => {
    const tools = clone().filter((t) => t.name !== PINNED);
    expectRefused(checkPaPin(committed(), tools, checkScope), `${PINNED}: pinned by the PA but no longer registered`);
  });

  it("fails when a pinned tool no longer accepts iot:view", () => {
    const controlOnly = (name: string, scope?: string) => (name === PINNED ? scope === "iot:control" : checkScope(name, scope));
    expectRefused(
      checkPaPin(committed(), ALICE_TOOLS, controlOnly),
      `${PINNED}: no longer accepts the scope iot:view, the only one the PA holds`,
    );
  });

  it("ignores a change to a tool the PA does not pin", () => {
    const tools = clone();
    tools.find((t) => t.name === "alice_set_volume")!.description += " Changed.";
    expect(checkPaPin(committed(), tools, checkScope)).toEqual([]);
  });

  it("refuses a pin file it cannot read as a pin, rather than passing with nothing pinned", () => {
    const good = JSON.parse(committed());
    const broken: Array<[string, unknown]> = [
      ["no tools key", { ...good, tools: undefined }],
      ["empty tools", { ...good, tools: {} }],
      ["tools as a list", { ...good, tools: [] }],
      ["wrong schema", { ...good, schema: "other/v1" }],
      ["no scope", { ...good, required_scope: "" }],
      ["two scopes", { ...good, required_scope: "iot:view iot:control" }],
      ["unknown key", { ...good, extra: 1 }],
      ["tool with a missing field", { ...good, tools: { [PINNED]: { ...good.tools[PINNED], annotations: undefined } } }],
      ["tool with an unknown field", { ...good, tools: { [PINNED]: { ...good.tools[PINNED], tier: "auto" } } }],
      ["stale description hash", { ...good, tools: { [PINNED]: { ...good.tools[PINNED], description: "edited by hand" } } }],
      ["stale schema hash", { ...good, tools: { [PINNED]: { ...good.tools[PINNED], input_schema: { type: "object" } } } }],
    ];
    for (const [label, doc] of broken) {
      expect(() => checkPaPin(JSON.stringify(doc), ALICE_TOOLS, checkScope), label).toThrow(PA_PIN_FILE);
    }
    for (const text of ["", "{", "null", "[]"]) {
      expect(() => checkPaPin(text, ALICE_TOOLS, checkScope), JSON.stringify(text)).toThrow(PA_PIN_FILE);
    }
  });

  it("update mode rewrites the compared fields but never drops a pinned tool that is gone", () => {
    const tools = clone();
    tools.find((t) => t.name === PINNED)!.description += " Changed.";
    expect(checkPaPin(renderPaPin(committed(), tools), tools, checkScope)).toEqual([]);
    const without = clone().filter((t) => t.name !== PINNED);
    expectRefused(
      checkPaPin(renderPaPin(committed(), without), without, checkScope),
      `${PINNED}: pinned by the PA but no longer registered`,
    );
  });
});
