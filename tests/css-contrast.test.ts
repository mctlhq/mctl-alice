import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.resolve(__dirname, "..", "public", "assets", "components.css"), "utf8");

// Returns the declarations of the first rule whose selector list contains
// `selector` inside the text `scope`, or undefined when there is none.
function ruleBody(scope: string, selector: string): string | undefined {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{]*\\{([^}]*)\\}`);
  return scope.match(re)?.[1];
}

describe("contrast that must not depend on the data-theme attribute", () => {
  it("the BETA chip follows a light operating system when no theme was saved", () => {
    // A visitor on a light OS with no saved choice has no data-theme attribute,
    // so a light rule that only matches [data-theme="light"] never applies and
    // the chip kept its dark tint with a dark label (contrast 1.84:1).
    const media = css.match(/@media \(prefers-color-scheme: light\) \{([\s\S]*?)\n\}/g)?.join("\n") ?? "";
    const body = ruleBody(media, ".chip-beta");
    expect(body, "no .chip-beta rule inside a prefers-color-scheme: light block").toBeDefined();
    expect(body).toContain("background: var(--accent-soft)");
    expect(body).toContain("color: var(--accent-deep)");
  });

  it("links inside the footer sentence are underlined, not told apart by colour alone", () => {
    const body = ruleBody(css, "footer .footer-row > span:first-child a");
    expect(body, "no footer sentence link rule").toBeDefined();
    expect(body).toContain("text-decoration: underline");
  });
});
