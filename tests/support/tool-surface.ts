import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Shared by tests/tool-descriptors.test.ts and tests/pa-pinned-tools.test.ts.
 *
 * The canonical form and the hashes below reproduce what the Personal
 * Assistant in mctlhq/mctl-telegram computes for a tool of a live tools/list
 * (internal/pa/catalog/canonical.go and listing.go), so a value in
 * docs/pa-pinned-tools.json can be compared with that repository's
 * internal/pa/catalog/pin.json character for character:
 *
 *   description_sha256   hex SHA-256 of the UTF-8 description ("" if absent)
 *   input_schema_sha256  hex SHA-256 of the canonical inputSchema
 *   annotations          the object itself; absent, null and {} are equal
 *
 * Canonical JSON is Go's encoding/json output with HTML escaping off: object
 * keys sorted, no insignificant whitespace.
 */

export const DESCRIPTORS_FILE = "docs/tool-descriptors.json";
export const DESCRIPTORS_SCHEMA = "mctl-alice.tool-descriptors/v1";
export const PA_PIN_FILE = "docs/pa-pinned-tools.json";
export const PA_PIN_SCHEMA = "mctl-alice.pa-pinned-tools/v1";
export const RUNBOOK = "docs/runbooks/tool-surface.md";

export const REGENERATE_DESCRIPTORS = "npm run update:tool-descriptors";
export const REFRESH_PA_PIN =
  `A tool the Personal Assistant pins has changed. The PA denies a pinned tool whose live descriptor differs from its pin, ` +
  `so this change makes that tool unavailable to the PA until the pin is refreshed. Either revert the change, or: ` +
  `(1) in mctlhq/mctl-telegram update internal/pa/catalog/testdata/alice.tools.json from this repository's ${DESCRIPTORS_FILE} ` +
  `and run \`go test ./internal/pa/catalog -run TestPinMatchesUpstream -update-pin\`; ` +
  `(2) in this pull request run \`npm run update:pa-pin\` and commit ${PA_PIN_FILE}, which is the explicit acknowledgement. ` +
  `See ${RUNBOOK}.`;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    // Go sorts keys by UTF-8 bytes, which is code point order. The default
    // JS sort is UTF-16 code unit order; the two differ only for keys with
    // astral characters, so compare by code point.
    const keys = Object.keys(src).sort((a, b) => {
      const x = Array.from(a, (c) => c.codePointAt(0)!);
      const y = Array.from(b, (c) => c.codePointAt(0)!);
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        if (x[i] !== y[i]) return x[i] - y[i];
      }
      return x.length - y.length;
    });
    return Object.fromEntries(keys.map((k) => [k, sortKeys(src[k])]));
  }
  return value;
}

/** Canonical JSON text of a value, as mctl-telegram's canonicalJSON emits it. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
    // encoding/json escapes these two even with HTML escaping off.
    .split(String.fromCharCode(0x2028)).join("\\u2028")
    .split(String.fromCharCode(0x2029)).join("\\u2029");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// docs/tool-descriptors.json: every registered tool as tools/list returns it.
// ---------------------------------------------------------------------------

export function renderDescriptors(tools: Tool[], scopes: Record<string, string[]>): string {
  const doc = {
    $comment:
      `Every tool this server registers, as tools/list returns it, plus the OAuth scopes that admit a call ` +
      `(any one is enough). Generated from src/tools/definitions.ts and TOOL_SCOPES in src/tools/handlers.ts; ` +
      `do not edit by hand. tests/tool-descriptors.test.ts fails when it is stale: ${REGENERATE_DESCRIPTORS}. See ${RUNBOOK}.`,
    schema: DESCRIPTORS_SCHEMA,
    tools: tools.map((tool) => {
      const accepted = scopes[tool.name];
      if (!Array.isArray(accepted) || accepted.length === 0) {
        throw new Error(`tool ${tool.name} has no entry in TOOL_SCOPES`);
      }
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        scopes: accepted,
      };
    }),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Problems that make the committed descriptor differ from the registry. Empty means equal. */
export function checkDescriptors(fileText: string, tools: Tool[], scopes: Record<string, string[]>): string[] {
  const want = renderDescriptors(tools, scopes);
  if (fileText === want) return [];
  const hint = `Regenerate it with \`${REGENERATE_DESCRIPTORS}\` and commit the result.`;
  let have: unknown;
  try {
    have = parseJson(DESCRIPTORS_FILE, fileText);
  } catch (err) {
    return [`${(err as Error).message}. ${hint}`];
  }
  if (!isObject(have) || !Array.isArray(have.tools)) {
    return [`${DESCRIPTORS_FILE} has no "tools" array. ${hint}`];
  }
  const haveByName = new Map<string, unknown>();
  for (const entry of have.tools) {
    if (isObject(entry) && typeof entry.name === "string") haveByName.set(entry.name, entry);
  }
  const wantTools = (JSON.parse(want) as { tools: Array<{ name: string }> }).tools;
  const names: string[] = [];
  for (const tool of wantTools) {
    const entry = haveByName.get(tool.name);
    if (entry === undefined) names.push(`${tool.name} (registered, not in the file)`);
    else if (canonicalJson(entry) !== canonicalJson(tool)) names.push(`${tool.name} (differs)`);
    haveByName.delete(tool.name);
  }
  for (const name of haveByName.keys()) names.push(`${name} (in the file, not registered)`);
  const what = names.length > 0 ? `Tools: ${names.join(", ")}.` : "The tools match but the order, header or formatting does not.";
  return [`${DESCRIPTORS_FILE} is not equal to the registered tools. ${what} ${hint}`];
}

// ---------------------------------------------------------------------------
// docs/pa-pinned-tools.json: the tools the PA pins, with the compared fields.
// ---------------------------------------------------------------------------

export interface PinnedFields {
  description: string;
  description_sha256: string;
  input_schema: Record<string, unknown>;
  input_schema_sha256: string;
  annotations: Record<string, unknown>;
}

export interface PaPinFile {
  $comment: string;
  schema: string;
  required_scope: string;
  tools: Record<string, PinnedFields>;
}

const PIN_TOP_KEYS = ["$comment", "required_scope", "schema", "tools"];
const PIN_TOOL_KEYS = ["annotations", "description", "description_sha256", "input_schema", "input_schema_sha256"];

/** The fields the PA compares, computed from a registered tool. */
export function pinnedFields(tool: Tool): PinnedFields {
  const description = tool.description ?? "";
  return {
    description,
    description_sha256: sha256Hex(description),
    input_schema: tool.inputSchema as Record<string, unknown>,
    input_schema_sha256: sha256Hex(canonicalJson(tool.inputSchema)),
    annotations: (tool.annotations ?? {}) as Record<string, unknown>,
  };
}

/**
 * Parses the pin file strictly. A file that cannot be read as a pin throws:
 * it never parses to "no pinned tools", which every check would pass.
 */
export function parsePaPin(fileText: string): PaPinFile {
  const doc = parseJson(PA_PIN_FILE, fileText);
  if (!isObject(doc)) throw new Error(`${PA_PIN_FILE} is not a JSON object`);
  const keys = Object.keys(doc).sort();
  if (canonicalJson(keys) !== canonicalJson(PIN_TOP_KEYS)) {
    throw new Error(`${PA_PIN_FILE} must have exactly the keys ${PIN_TOP_KEYS.join(", ")}; it has ${keys.join(", ")}`);
  }
  if (doc.schema !== PA_PIN_SCHEMA) throw new Error(`${PA_PIN_FILE} schema is ${JSON.stringify(doc.schema)}, want ${PA_PIN_SCHEMA}`);
  if (typeof doc.required_scope !== "string" || doc.required_scope.trim() === "" || /\s/.test(doc.required_scope)) {
    throw new Error(`${PA_PIN_FILE} required_scope must be one scope name`);
  }
  if (!isObject(doc.tools) || Object.keys(doc.tools).length === 0) {
    throw new Error(`${PA_PIN_FILE} pins no tools; an empty pin would pass every check`);
  }
  for (const [name, entry] of Object.entries(doc.tools)) {
    if (!isObject(entry)) throw new Error(`${PA_PIN_FILE} tool ${name} is not an object`);
    const entryKeys = Object.keys(entry).sort();
    if (canonicalJson(entryKeys) !== canonicalJson(PIN_TOOL_KEYS)) {
      throw new Error(`${PA_PIN_FILE} tool ${name} must have exactly the keys ${PIN_TOOL_KEYS.join(", ")}; it has ${entryKeys.join(", ")}`);
    }
    if (typeof entry.description !== "string") throw new Error(`${PA_PIN_FILE} tool ${name}: description is not a string`);
    if (!isObject(entry.input_schema)) throw new Error(`${PA_PIN_FILE} tool ${name}: input_schema is not an object`);
    if (!isObject(entry.annotations)) throw new Error(`${PA_PIN_FILE} tool ${name}: annotations is not an object`);
    // The readable fields and the hashes must agree, so a reviewer who reads
    // the text and a script that compares the hashes see the same pin.
    if (entry.description_sha256 !== sha256Hex(entry.description)) {
      throw new Error(`${PA_PIN_FILE} tool ${name}: description_sha256 does not match description`);
    }
    if (entry.input_schema_sha256 !== sha256Hex(canonicalJson(entry.input_schema))) {
      throw new Error(`${PA_PIN_FILE} tool ${name}: input_schema_sha256 does not match input_schema`);
    }
  }
  return doc as unknown as PaPinFile;
}

/**
 * Problems that would make the PA deny a pinned tool. Empty means every
 * pinned tool is registered, admits the pinned scope and equals its pin.
 * checkScope is the server's own scope check (src/tools/handlers.ts).
 */
export function checkPaPin(
  fileText: string,
  tools: Tool[],
  checkScope: (name: string, scope?: string) => boolean,
): string[] {
  const pin = parsePaPin(fileText);
  const problems: string[] = [];
  for (const [name, want] of Object.entries(pin.tools)) {
    const matches = tools.filter((tool) => tool.name === name);
    if (matches.length === 0) {
      problems.push(`${name}: pinned by the PA but no longer registered`);
      continue;
    }
    if (matches.length > 1) {
      problems.push(`${name}: registered ${matches.length} times`);
      continue;
    }
    if (!checkScope(name, pin.required_scope)) {
      problems.push(`${name}: no longer accepts the scope ${pin.required_scope}, the only one the PA holds`);
    }
    const have = pinnedFields(matches[0]);
    if (have.description_sha256 !== want.description_sha256) problems.push(`${name}: description changed`);
    if (have.input_schema_sha256 !== want.input_schema_sha256) problems.push(`${name}: input schema changed`);
    if (canonicalJson(have.annotations) !== canonicalJson(want.annotations)) problems.push(`${name}: annotations changed`);
  }
  return problems.length > 0 ? [...problems, REFRESH_PA_PIN] : [];
}

/**
 * Rewrites the compared fields of the tools the file already pins. It does
 * not add or drop a pinned tool and does not change the scope: a pinned tool
 * that is gone still fails in checkPaPin after the rewrite.
 */
export function renderPaPin(fileText: string, tools: Tool[]): string {
  const pin = parsePaPin(fileText);
  const updated: Record<string, PinnedFields> = {};
  for (const [name, entry] of Object.entries(pin.tools)) {
    const tool = tools.find((t) => t.name === name);
    updated[name] = tool ? pinnedFields(tool) : entry;
  }
  return JSON.stringify({ ...pin, tools: updated }, null, 2) + "\n";
}
