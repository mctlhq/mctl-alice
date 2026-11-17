import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createHttpServer } from "../src/server/http-server.js";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { TelemetryStorage } from "../src/storage/telemetry-storage.js";
import { LOCALIZED_PATHS, enPath, matchLocalizedPath } from "../src/server/localize.js";

const ORIGIN = "https://alice.example.test";
const html = { Accept: "text/html" };
const INDEXABLE = ["/", "/setup", "/about", "/security"];
const variants = LOCALIZED_PATHS.flatMap((p) => [
  { lang: "ru", path: p, url: p },
  { lang: "en", path: p, url: enPath(p) },
]);

function alternates(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)) out[m[1]] = m[2];
  return out;
}

describe("English and Russian have their own crawlable URLs", () => {
  let server: http.Server;
  let selfHosted: http.Server;
  let storage: OAuthStorage;
  let history: TelemetryStorage;
  let base: string;
  let plainBase: string;

  const listen = async (s: http.Server) => {
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(s.address() as import("node:net").AddressInfo).port}`;
  };

  beforeAll(async () => {
    storage = new OAuthStorage(":memory:");
    history = new TelemetryStorage(":memory:");
    server = createHttpServer(0, { publicBaseUrl: ORIGIN, authRequired: false, oauthStorage: storage, storage: history, enableSampler: false });
    selfHosted = createHttpServer(0, { authRequired: false, oauthStorage: storage, storage: history, enableSampler: false });
    base = await listen(server);
    plainBase = await listen(selfHosted);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => selfHosted.close(() => resolve()));
    storage.close();
    history.close();
  });

  const get = async (p: string, headers: Record<string, string> = html, b = base) => {
    const res = await fetch(b + p, { headers, redirect: "manual" });
    return { res, body: await res.text() };
  };

  it.each(variants)("$lang $url is a real page with its own head tags", async ({ lang, path, url }) => {
    const { res, body } = await get(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(body).toContain(`<html lang="${lang}"`);
    // Self-referencing canonical, per language.
    expect(body).toContain(`<link rel="canonical" href="${ORIGIN}${url}">`);
    // Reciprocal set: self, the other language and x-default (the Russian default).
    expect(alternates(body)).toEqual({
      ru: ORIGIN + path,
      en: ORIGIN + enPath(path),
      "x-default": ORIGIN + path,
    });
    // Language switcher: real links with lang/hreflang, current one marked.
    const nav = /<nav class="lang-switcher"[\s\S]*?<\/nav>/.exec(body)![0];
    expect(nav).toContain(`<a class="lang-btn is-active" lang="${lang}" hreflang="${lang}" href="${lang === "en" ? enPath(path) : path}"`);
    expect(nav).toContain('aria-current="page"');
    expect(nav).toContain(`lang="ru" hreflang="ru" href="${path}"`);
    expect(nav).toContain(`lang="en" hreflang="en" href="${enPath(path)}"`);
    expect(nav).not.toContain("<button");
  });

  it.each(LOCALIZED_PATHS)("%s: every alternate points at a page that points back", async (p) => {
    const ruSet = alternates((await get(p)).body);
    const enSet = alternates((await get(enPath(p))).body);
    expect(ruSet).toEqual(enSet);
    for (const href of [ruSet.ru, ruSet.en]) {
      const target = href.slice(ORIGIN.length);
      const back = alternates((await get(target)).body);
      expect(Object.values(back)).toContain(ORIGIN + p);
      expect(Object.values(back)).toContain(ORIGIN + enPath(p));
    }
  });

  it.each(LOCALIZED_PATHS)("%s: the English variant is English text, with English metadata", async (p) => {
    const { body } = await get(enPath(p));
    // The switcher labels itself in both languages on purpose; everything else must be translated.
    const rest = body.replace(/<nav class="lang-switcher"[\s\S]*?<\/nav>/, "");
    expect(rest.match(/[А-Яа-яЁё]+/g) ?? []).toEqual([]);
    expect(rest).not.toMatch(/data-i18n(?:-html)?="[^"]+"[^>]*>[^<]*[А-Яа-яЁё]/);
    const ru = (await get(p)).body;
    expect(/<title>([^<]*)<\/title>/.exec(body)![1]).not.toBe(/<title>([^<]*)<\/title>/.exec(ru)![1]);
  });

  it("English pages keep the visitor in English and Russian pages in Russian", async () => {
    const en = (await get("/en/")).body;
    for (const p of ["/en/setup", "/en/about", "/en/privacy", "/en/terms", "/en/security"]) expect(en).toContain(`href="${p}"`);
    // Only the switcher's own Russian link may point at an unprefixed page.
    expect(en.replace(/<nav class="lang-switcher"[\s\S]*?<\/nav>/, "")).not.toMatch(/href="\/(?:setup|about|privacy|terms|security)?"/);
    // The account pages have no English URL and stay shared.
    expect(en).toContain('href="/account"');
    const ru = (await get("/")).body;
    expect(ru).toContain('href="/setup"');
    expect(ru).not.toContain('href="/en/setup"');
  });

  it("the English home carries translated structured data", async () => {
    const { body } = await get("/en/");
    const ld = [...body.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)].map((m) => JSON.parse(m[1]));
    const text = JSON.stringify(ld);
    expect(text).toContain("Is it safe to connect smart home through mctl-alice?");
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
    const crumbs = JSON.stringify([...(await get("/en/security")).body.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)].map((m) => JSON.parse(m[1])));
    expect(crumbs).toContain(`${ORIGIN}/en/security`);
    expect(crumbs).not.toMatch(/[А-Яа-яЁё]/);
  });

  it("sitemap lists every page in both languages with reciprocal alternates", async () => {
    const { res, body } = await get("/sitemap.xml");
    expect(res.status).toBe(200);
    expect(body).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    const entries = [...body.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
    const locs = entries.map((e) => /<loc>([^<]+)<\/loc>/.exec(e)![1]);
    expect(locs.sort()).toEqual(INDEXABLE.flatMap((p) => [p, enPath(p)]).map((p) => ORIGIN + p).sort());
    for (const entry of entries) {
      const links = Object.fromEntries([...entry.matchAll(/<xhtml:link rel="alternate" hreflang="([^"]+)" href="([^"]+)"\/>/g)].map((m) => [m[1], m[2]]));
      const loc = /<loc>([^<]+)<\/loc>/.exec(entry)![1];
      expect(Object.values(links)).toContain(loc);
      const p = matchLocalizedPath(loc.slice(ORIGIN.length))!.path;
      expect(links).toEqual({ ru: ORIGIN + p, en: ORIGIN + enPath(p), "x-default": ORIGIN + p });
    }
  });

  it("does not negotiate on Accept-Language and does not redirect by it", async () => {
    const ru = await get("/", { ...html, "Accept-Language": "en-US,en;q=0.9" });
    expect(ru.res.status).toBe(200);
    expect(ru.body).toContain('<html lang="ru"');
    const en = await get("/en/", { ...html, "Accept-Language": "ru-RU,ru;q=0.9" });
    expect(en.res.status).toBe(200);
    expect(en.body).toContain('<html lang="en"');
    expect(en.res.headers.get("vary") ?? "").not.toMatch(/accept-language/i);
    expect(ru.res.headers.get("vary") ?? "").not.toMatch(/accept-language/i);
  });

  it("/en without a slash goes to /en/; other unknown paths are still 404", async () => {
    const r = await get("/en");
    expect(r.res.status).toBe(301);
    expect(r.res.headers.get("location")).toBe("/en/");
    for (const p of ["/en/nope", "/en/account", "/en/en/setup", "/en/auth/login", "/en//setup", "/en/setup/", "/fr/", "/ru/", "/en/sitemap.xml"]) {
      const { res } = await get(p);
      expect(res.status, p).toBe(404);
    }
  });

  it("state-changing methods are not routed through the /en prefix", async () => {
    const res = await fetch(base + "/en/setup", { method: "POST", headers: { Origin: ORIGIN } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    // The /en -> /en/ normalisation is for reads only.
    const post = await fetch(base + "/en", { method: "POST", headers: { Origin: ORIGIN }, redirect: "manual" });
    expect(post.status).toBe(404);
  });

  it("the JSON info answer at / is unchanged and /en/ is always the page", async () => {
    const json = await get("/", { Accept: "application/json" });
    expect(json.res.headers.get("content-type")).toContain("application/json");
    const en = await get("/en/", { Accept: "application/json" });
    expect(en.res.headers.get("content-type")).toContain("text/html");
  });

  it("without a public origin there are no absolute alternates, but the pages and switcher work", async () => {
    for (const url of ["/", "/en/", "/setup", "/en/setup"]) {
      const { res, body } = await get(url, html, plainBase);
      expect(res.status, url).toBe(200);
      expect(body, url).not.toContain('rel="alternate" hreflang');
      expect(body, url).not.toContain("__BASE_URL__");
      expect(body, url).toContain('<nav class="lang-switcher"');
    }
  });

  it("the saved-language scripts leave pages that already have a language URL alone", async () => {
    const fs = await import("node:fs");
    const init = fs.readFileSync("public/assets/theme-init.js", "utf8");
    expect(init).toMatch(/!document\.documentElement\.hasAttribute\("data-lang-static"\)/);
    const site = fs.readFileSync("public/assets/site.js", "utf8");
    expect(site).toMatch(/if \(root\.hasAttribute\("data-lang-static"\)\) \{[\s\S]*?\} else \{\s*applyLanguage\(initialLang\);/);
  });

  it("language pages are served under the existing CSP, with no inline script added", async () => {
    const ru = await get("/en/setup");
    const csp = ru.res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src");
    expect(ru.body).not.toMatch(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/);
    expect(ru.body).not.toMatch(/\son[a-z]+="/);
  });
});
