import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHttpServer, contentSecurityPolicy } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { TelemetryStorage } from "../src/storage/telemetry-storage.js";

const rootDir = path.resolve(__dirname, "..");
const PUBLIC_ORIGIN = "https://alice.example.test";

describe("Public site basics: /setup, 404 page, sitemap, fonts, social preview", () => {
  let server: http.Server;
  let storage: OAuthStorage;
  let history: TelemetryStorage;
  let base: string;

  beforeAll(async () => {
    storage = new OAuthStorage(":memory:");
    history = new TelemetryStorage(":memory:");
    // A trailing slash in the configured origin must not leak into URLs.
    server = createHttpServer(0, { publicBaseUrl: PUBLIC_ORIGIN + "/", authRequired: false, oauthStorage: storage, storage: history, enableSampler: false });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close();
    history.close();
  });

  const html = { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };

  it("serves the connection guide at /setup with the MCP URL, tested clients and revocation steps", async () => {
    const res = await fetch(base + "/setup", { headers: html });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain(`<code id="mcp-url">${PUBLIC_ORIGIN}/mcp</code>`);
    expect(body).toContain('data-i18n="setup_tested_title"');
    expect(body).toContain('data-i18n-html="setup_data_list"');
    expect(body).toContain("id.yandex.ru");
    expect(body).toContain(`<link rel="canonical" href="${PUBLIC_ORIGIN}/setup">`);
    expect(body).toContain(`<meta property="og:image" content="${PUBLIC_ORIGIN}/og-image.png">`);
    expect(body).not.toContain('name="robots"');
    // The snippets follow the host the page is opened on, like the copy button.
    expect(body).toContain(`alice <span class="mcp-url-slot">${PUBLIC_ORIGIN}/mcp</span>`);
  });

  it("keeps private pages out of search results", async () => {
    // Every page is checked or fails: a status change cannot silently drop one.
    const checked: string[] = [];
    for (const page of ["/account", "/auth/login", "/auth/cookie", "/auth/callback"]) {
      const res = await fetch(base + page, { headers: html, redirect: "manual" });
      if (page === "/auth/login") {
        // Redirects to Yandex ID; it has no page of its own to index.
        expect(res.status, page).toBe(302);
        continue;
      }
      expect(res.status, page).toBe(200);
      const body = await res.text();
      expect(body, page).toContain('<meta name="robots" content="noindex">');
      expect(body, page).not.toContain('rel="canonical"');
      checked.push(page);
    }
    expect(checked).toEqual(["/account", "/auth/cookie", "/auth/callback"]);
  });

  it("answers HEAD like GET on every page the sitemap lists", async () => {
    for (const page of ["/", "/setup", "/about", "/privacy", "/terms", "/security"]) {
      const res = await fetch(base + page, { method: "HEAD", headers: html });
      expect(res.status, page).toBe(200);
      expect(res.headers.get("content-type"), page).toContain("text/html");
    }
  });

  it("links every internal page from the public pages to something that exists", async () => {
    const seen = new Set<string>();
    for (const page of ["/", "/setup", "/about", "/privacy", "/terms", "/security"]) {
      const body = await (await fetch(base + page, { headers: html })).text();
      for (const [, href] of body.matchAll(/href="(\/[^"#?]*)/g)) seen.add(href);
    }
    expect(seen).toContain("/setup");
    for (const href of seen) {
      const res = await fetch(base + href, { headers: html, redirect: "manual" });
      expect(res.status, href).toBeLessThan(400);
    }
  });

  it("answers an unknown page with an HTML 404 for browsers", async () => {
    const res = await fetch(base + "/no-such-page", { headers: html });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe(contentSecurityPolicy());
    const body = await res.text();
    expect(body).toContain('data-i18n="notfound_title"');
    expect(body).toContain('<meta name="robots" content="noindex">');
    expect(body).toContain('href="/setup"');
  });

  it("keeps JSON 404s for API, MCP and OAuth clients", async () => {
    const cases: Array<[string, RequestInit]> = [
      ["/no-such-page", { method: "HEAD", headers: html }],
      ["/no-such-page", { headers: { Accept: "application/json" } }],
      ["/no-such-page", {}],
      ["/no-such-page", { method: "POST", headers: html }],
      ["/api/nope", { headers: html }],
      ["/oauth/nope", { headers: html }],
      ["/.well-known/nope", { headers: html }],
      ["/mcp/nope", { headers: html }],
      ["/openapi.xml", { headers: html }],
    ];
    for (const [p, init] of cases) {
      const res = await fetch(base + p, init);
      const label = `${init.method || "GET"} ${p} ${JSON.stringify(init.headers || {})}`;
      expect(res.status, label).toBe(404);
      expect(res.headers.get("content-type"), label).toContain("application/json");
      if (init.method !== "HEAD") expect(await res.json(), label).toEqual({ error: "not_found", message: "Route not found" });
    }
  });

  it("publishes robots.txt with the sitemap and a sitemap of the public pages", async () => {
    const robots = await fetch(base + "/robots.txt");
    expect(robots.status).toBe(200);
    const robotsText = await robots.text();
    expect(robotsText).toContain(`Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`);
    expect(robotsText).toContain("Disallow: /account");

    const sitemap = await fetch(base + "/sitemap.xml");
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("content-type")).toContain("application/xml");
    const locs = Array.from((await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g), m => m[1]);
    expect(locs).toEqual(["/", "/setup", "/about", "/privacy", "/terms", "/security"].map(p => PUBLIC_ORIGIN + p));
  });

  it("fills canonical and social preview URLs on the landing page from the configured origin", async () => {
    const body = await (await fetch(base + "/", { headers: html })).text();
    expect(body).not.toContain("__BASE_URL__");
    expect(body).toContain(`<link rel="canonical" href="${PUBLIC_ORIGIN}/">`);
    expect(body).toContain(`<meta property="og:image" content="${PUBLIC_ORIGIN}/og-image.png">`);

    const image = await fetch(base + "/og-image.png");
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await image.arrayBuffer());
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
  });

  it("serves its own fonts and allows no third-party font or style origin", async () => {
    const csp = contentSecurityPolicy();
    expect(csp).toContain("font-src 'self';");
    expect(csp).toContain("style-src 'self';");
    expect(csp).not.toMatch(/googleapis|gstatic/);

    for (const page of ["/", "/setup", "/about", "/no-such-page"]) {
      const res = await fetch(base + page, { headers: html });
      const body = await res.text();
      expect(body, page).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
      expect(body, page).toContain("/assets/fonts.css");
      expect(res.headers.get("content-security-policy"), page).not.toMatch(/googleapis|gstatic/);
    }

    const css = await (await fetch(base + "/assets/fonts.css")).text();
    const fonts = Array.from(css.matchAll(/url\((\/assets\/fonts\/[^)?]+\.woff2)(\?v=[0-9a-f]+)?\)/g), m => [m[1], m[2] ?? ""]);
    expect(fonts.length).toBe(4);
    for (const [font, version] of fonts) {
      const res = await fetch(base + font + version);
      expect(res.status, font).toBe(200);
      expect(res.headers.get("content-type"), font).toBe("font/woff2");
      // Fonts are cached for a week: a changed file must change its URL too.
      const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(rootDir, "public", font))).digest("hex").slice(0, 8);
      expect(version, font).toBe(`?v=${hash}`);
    }
  });

  it("sends long cache headers for the font files", async () => {
    const res = await fetch(base + "/assets/fonts/onest-latin-wght-normal.woff2");
    expect(res.headers.get("cache-control")).toBe("public, max-age=604800");
  });

  it("does not describe the Yandex refresh token as permanent", () => {
    for (const file of ["public/assets/site.js", "src/server/http-server.ts", "src/auth/oauth-helper.ts", "src/auth/cli.ts"]) {
      const text = fs.readFileSync(path.join(rootDir, file), "utf8");
      expect(text, file).not.toMatch(/permanent refresh|постоянн\S* refresh/i);
    }
  });
});

describe("Public site without a configured public origin", () => {
  let server: http.Server;
  let storage: OAuthStorage;
  let history: TelemetryStorage;
  let base: string;
  const saved = process.env.PUBLIC_BASE_URL;

  beforeAll(async () => {
    delete process.env.PUBLIC_BASE_URL;
    storage = new OAuthStorage(":memory:");
    history = new TelemetryStorage(":memory:");
    server = createHttpServer(0, { authRequired: false, oauthStorage: storage, storage: history, enableSampler: false });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });

  afterAll(async () => {
    if (saved !== undefined) process.env.PUBLIC_BASE_URL = saved;
    await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close();
    history.close();
  });

  it("does not claim a localhost canonical, og:url or sitemap", async () => {
    for (const page of ["/", "/setup", "/about"]) {
      const body = await (await fetch(base + page, { headers: { Accept: "text/html" } })).text();
      expect(body, page).not.toContain('rel="canonical"');
      expect(body, page).not.toContain("og:url");
      expect(body, page).not.toContain("__BASE_URL__");
      expect(body, page).not.toContain("og:image");
      expect(body, page).not.toContain("twitter:card");
    }
    expect(await (await fetch(base + "/robots.txt")).text()).not.toContain("Sitemap:");
    expect((await fetch(base + "/sitemap.xml")).status).toBe(404);
  });

  it("keeps the public pages indexable, like the landing page, and private ones not", async () => {
    for (const page of ["/", "/setup", "/about", "/privacy", "/terms", "/security"]) {
      const body = await (await fetch(base + page, { headers: { Accept: "text/html" } })).text();
      expect(body, page).not.toContain('name="robots"');
    }
    const account = await (await fetch(base + "/account", { headers: { Accept: "text/html" } })).text();
    expect(account).toContain('<meta name="robots" content="noindex">');
  });
});

describe("Public origin edge cases", () => {
  it("inserts a PUBLIC_BASE_URL with $ patterns literally", async () => {
    const storage = new OAuthStorage(":memory:");
    const history = new TelemetryStorage(":memory:");
    const origin = "https://alice.example.test/$&$'";
    const server = createHttpServer(0, { publicBaseUrl: origin, authRequired: false, oauthStorage: storage, storage: history, enableSampler: false });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const body = await (await fetch(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/`, { headers: { Accept: "text/html" } })).text();
      expect(body).toContain(`<link rel="canonical" href="https://alice.example.test/$&amp;$&#039;/">`);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      storage.close();
      history.close();
    }
  });

  it("warns at startup when a hosted server has no public origin", () => {
    const saved = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = new OAuthStorage(":memory:");
    try {
      createHttpServer(0, { authRequired: true, oauthStorage: storage, enableSampler: false });
      expect(warn.mock.calls.some(args => String(args[0]).includes("PUBLIC_BASE_URL is not set"))).toBe(true);
      warn.mockClear();
      createHttpServer(0, { publicBaseUrl: "https://alice.example.test", authRequired: true, oauthStorage: storage, enableSampler: false });
      expect(warn.mock.calls.some(args => String(args[0]).includes("PUBLIC_BASE_URL is not set"))).toBe(false);
    } finally {
      warn.mockRestore();
      storage.close();
      if (saved !== undefined) process.env.PUBLIC_BASE_URL = saved;
    }
  });
});
