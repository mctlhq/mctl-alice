import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => fs.readFileSync(path.join(rootDir, file), "utf-8");

const SITE_FILES = [
  "src/server/pages.ts",
  "src/server/account-page.ts",
  "public/assets/site.js",
  "public/assets/auth-cookie.js",
  "public/assets/auth-callback.js",
];

// Pictographs and dingbats. A plain multiplication sign, arrows and typographic
// punctuation fall outside these ranges on purpose.
const PICTOGRAPH = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

describe("public site copy", () => {
  it.each(SITE_FILES)("%s carries no pictographs", (file) => {
    const hits = read(file)
      .split("\n")
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => PICTOGRAPH.test(text));
    expect(hits).toEqual([]);
  });

  it("carries no pictographs in the HTML that http-server.ts renders", () => {
    // Console messages may keep a warning sign: they are logs, not pages.
    const hits = read("src/server/http-server.ts")
      .split("\n")
      .filter((line) => PICTOGRAPH.test(line) && !/console\.(warn|error|log)/.test(line));
    expect(hits).toEqual([]);
  });

  it.each([
    ["HSTS, which the service does not send", /HSTS/],
    ["a daily analytics salt, while Umami rotates monthly", /daily salt|ежедневной солью/],
    ["cryptographic tenant isolation, while all accounts share one key", /enforced cryptographically|на криптографическом уровне/],
    ["scenarios purged after each run, while they are reused until disconnect", /purges them immediately|сразу после выполнения/],
  ])("does not claim %s", (_claim, pattern) => {
    for (const file of ["src/server/pages.ts", "public/assets/site.js", "src/server/http-server.ts"]) {
      expect(read(file), file).not.toMatch(pattern);
    }
  });
});
