import { describe, it, expect } from "vitest";
import http from "node:http";
import { createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
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
    ["a daily analytics salt, while Umami rotates monthly", /daily salt|ежедневной солью/],
    ["cryptographic tenant isolation, while all accounts share one key", /enforced cryptographically|на криптографическом уровне/],
    ["scenarios purged after each run, while they are reused until disconnect", /purges them immediately|сразу после выполнения/],
  ])("does not claim %s", (_claim, pattern) => {
    for (const file of ["src/server/pages.ts", "public/assets/site.js", "src/server/http-server.ts"]) {
      expect(read(file), file).not.toMatch(pattern);
    }
  });
});

describe("HSTS", () => {
  async function hstsHeader(publicBaseUrl: string): Promise<string | null> {
    const storage = new OAuthStorage(":memory:");
    const server: http.Server = createHttpServer(0, { publicBaseUrl, authRequired: false, oauthStorage: storage, retention: false });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as import("node:net").AddressInfo).port;
      return (await fetch(`http://127.0.0.1:${port}/security`)).headers.get("strict-transport-security");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      storage.close();
    }
  }

  it("is sent for an https deployment, for this host only, as the security page claims", async () => {
    const header = await hstsHeader("https://alice.example");
    expect(header).toBe("max-age=31536000");
    expect(read("src/server/pages.ts")).toContain("HSTS");
  });

  it("is not sent for a plain http deployment", async () => {
    expect(await hstsHeader("http://localhost")).toBeNull();
  });
});

describe("contact details", () => {
  const NAME = /Машков|Mashkov/;
  const CITY = /Подгорица|Podgorica/;

  it("names the operator on the privacy page and nowhere else", () => {
    const pages = read("src/server/pages.ts");
    const privacyStart = pages.indexOf("export function renderPrivacyPage");
    const privacyEnd = pages.indexOf("export function ", privacyStart + 1);
    expect(privacyStart).toBeGreaterThan(-1);
    expect(privacyEnd).toBeGreaterThan(privacyStart);
    expect(pages.slice(privacyStart, privacyEnd)).toMatch(NAME);
    expect(pages.slice(0, privacyStart) + pages.slice(privacyEnd)).not.toMatch(NAME);

    const named = read("public/assets/site.js")
      .split("\n")
      .filter((line) => NAME.test(line))
      .map((line) => line.trim().split(":")[0]);
    expect(named).toEqual(["privacy_sec5_desc", "privacy_sec5_desc"]);
  });

  it("names no city", () => {
    for (const file of ["src/server/pages.ts", "public/assets/site.js"]) {
      expect(read(file), file).not.toMatch(CITY);
    }
  });
});
