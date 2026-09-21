import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

describe("Internationalization (i18n) Coverage & Symmetry", () => {
  const siteJsPath = path.join(rootDir, "public", "assets", "site.js");
  const siteJsContent = fs.readFileSync(siteJsPath, "utf-8");

  // Extract ru and en translation blocks
  const ruMatch = siteJsContent.match(/ru:\s*\{([\s\S]*?)\n\s*\},/);
  const enMatch = siteJsContent.match(/en:\s*\{([\s\S]*?)\n\s*\}\s*\};/);

  expect(ruMatch).not.toBeNull();
  expect(enMatch).not.toBeNull();

  // Extract strict keys (keys formatted as "      key_name:")
  const ruKeys = new Set(Array.from(ruMatch![1].matchAll(/^\s{6}(\w+):/gm), (m) => m[1]));
  const enKeys = new Set(Array.from(enMatch![1].matchAll(/^\s{6}(\w+):/gm), (m) => m[1]));

  it("should have identical translation keys in both RU and EN dictionaries", () => {
    expect(ruKeys.size).toBeGreaterThan(150);
    expect(enKeys.size).toBeGreaterThan(150);

    const missingInEn = Array.from(ruKeys).filter((k) => !enKeys.has(k));
    const missingInRu = Array.from(enKeys).filter((k) => !ruKeys.has(k));

    expect(missingInEn).toEqual([]);
    expect(missingInRu).toEqual([]);
  });

  it("should provide translations for every data-i18n key used in HTML and TS templates", () => {
    const templateFiles = [
      path.join(rootDir, "public", "index.html"),
      path.join(rootDir, "src", "server", "account-page.ts"),
      path.join(rootDir, "src", "server", "pages.ts"),
      path.join(rootDir, "src", "server", "http-server.ts"),
    ];

    const missingFromRu: Array<{ key: string; file: string }> = [];
    const missingFromEn: Array<{ key: string; file: string }> = [];

    const attrRegex = /data-i18n(?:-html|-placeholder)?=["']([^"'\s]+)["']/g;

    for (const filePath of templateFiles) {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf-8");
      const matches = content.matchAll(attrRegex);

      for (const match of matches) {
        const key = match[1];
        if (!ruKeys.has(key)) {
          missingFromRu.push({ key, file: path.basename(filePath) });
        }
        if (!enKeys.has(key)) {
          missingFromEn.push({ key, file: path.basename(filePath) });
        }
      }
    }

    expect(missingFromRu).toEqual([]);
    expect(missingFromEn).toEqual([]);
  });
});
