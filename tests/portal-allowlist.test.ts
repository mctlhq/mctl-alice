import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ALICE_TOOLS } from "../src/tools/definitions.js";

/**
 * Drift guard for the Cloudflare MCP portal mapping of server `alice`
 * (mctlhq/.github#35). The portal hides only what it has an explicit entry
 * for, so a tool added to this server without a decision in
 * docs/portal-allowlist.json would surface on the shared portal the moment
 * it re-syncs. Failing the build is the decision being asked for.
 *
 * Modeled on mctlhq/seerrsense tests/portal-allowlist.test.ts, the TS sibling
 * of mctl-telegram/mctl-api's Go guard. ALICE_TOOLS has no readOnlyHint
 * annotation (unlike seerrsense's registered-tool objects), so mutating
 * tools are named by hand in mutatingOnPortal rather than detected from an
 * annotation -- the same shape as seerrsense's writeToolsOnPortal, adapted
 * to the source this repository actually has.
 */

const ALLOWLIST = "docs/portal-allowlist.json";

/** A floor on the decision, not a quality bar: it rejects a placeholder. */
const MIN_REASON_LEN = 40;

/**
 * mutatingOnPortal names every tool that changes something in the smart
 * home (a device, a scene, a speaker) and is exposed on the portal anyway,
 * by owner decision 2026-09-22 (mctlhq/.github#35, mctlhq/mctl-gitops#1330
 * portal_member_alice: the portal's only members are the two named owner
 * addresses, not a shared surface).
 *
 * This is visibility, not permission: the portal switch is per-server and
 * user-blind. The value says what the tool changes, for whoever would have
 * to undo it.
 */
const mutatingOnPortal: Record<string, string> = {
  alice_send_command:
    "sends an arbitrary voice command to a speaker, equivalent to speaking to Alice aloud",
  alice_say_phrase: "makes a speaker say a phrase aloud via TTS",
  alice_set_volume: "sets a speaker's volume level",
  alice_media_control: "controls playback (play/pause/stop/next/prev) on a speaker",
  alice_trigger_scenario:
    "runs a predefined Yandex Smart Home scenario, which can affect many devices at once",
  alice_control_device:
    "turns a device on/off or sets AC temperature/mode via the Yandex IoT API",
  alice_set_light: "controls a light's on/off state, brightness, color temperature or scene",
  alice_control_room:
    "batch turns devices in a room or the whole home on/off by category; the widest blast radius of any tool here",
};

type Entry = { name: string; enabled?: boolean; reason?: string };
type Allowlist = {
  portal: string;
  server: string;
  default_disabled: boolean;
  tools: Entry[];
};

const list = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as Allowlist;
const names = ALICE_TOOLS.map((t) => t.name);
const isMutating = (name: string): boolean => name in mutatingOnPortal;

describe("portal allowlist", () => {
  it("targets the right mapping and stays fail-closed", () => {
    expect(list.portal).toBe("mcp");
    expect(list.server).toBe("alice");
    expect(list.default_disabled).toBe(true);
  });

  it("enumerates the tools it is guarding", () => {
    expect(names.length).toBeGreaterThan(0);
    expect(names.some(isMutating)).toBe(true);
  });

  it("carries an explicit decision for every registered tool, and no stale entry", () => {
    const listed = list.tools.map((t) => t.name);
    expect(new Set(listed).size, "a tool is listed twice").toBe(listed.length);
    expect([...listed].sort()).toEqual([...names].sort());
    for (const tool of list.tools) {
      expect(typeof tool.enabled, `${tool.name}: no "enabled" key`).toBe("boolean");
    }
  });

  it("requires a reason that says what an enabled tool exposes", () => {
    for (const tool of list.tools.filter((t) => t.enabled)) {
      expect(
        (tool.reason ?? "").length,
        `${tool.name}: enabled but the reason is a placeholder`,
      ).toBeGreaterThanOrEqual(MIN_REASON_LEN);
    }
  });

  it("lets a mutating tool be enabled only with a reviewed vouch", () => {
    for (const tool of list.tools.filter((t) => t.enabled && isMutating(t.name))) {
      expect(
        mutatingOnPortal[tool.name],
        `${tool.name}: enabled on the portal and mutating, but mutatingOnPortal does not name it`,
      ).toBeTruthy();
    }
  });

  it("keeps no vouch that has stopped describing an enabled mutating tool", () => {
    const enabled = new Set(list.tools.filter((t) => t.enabled).map((t) => t.name));
    for (const name of Object.keys(mutatingOnPortal)) {
      expect(names, `${name}: vouched for but no longer registered`).toContain(name);
      expect(enabled.has(name), `${name}: vouched for but disabled in the file`).toBe(true);
    }
  });
});
