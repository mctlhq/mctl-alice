import fs from "node:fs";
import vm from "node:vm";

/**
 * Server-side language variants of the public pages.
 *
 * The strings of both languages live once, in the `translations` table of
 * public/assets/site.js (the browser still uses it for the account and OAuth
 * pages, which have no per-language URL). This module reads that table and
 * renders the English variant of a Russian page by applying it to the
 * data-i18n markers, so /en/... is real HTML for crawlers and for visitors
 * without JavaScript. Russian stays the default at the unprefixed URLs.
 */

export type Lang = "ru" | "en";
export type Translations = Record<Lang, Record<string, string>>;

/** Pages that exist in both languages: Russian at the path, English under /en. */
export const LOCALIZED_PATHS = ["/", "/setup", "/about", "/privacy", "/terms", "/security"];

export function enPath(pagePath: string): string {
  return pagePath === "/" ? "/en/" : `/en${pagePath}`;
}

/** Maps a request path to its language and the Russian-variant path, or null. */
export function matchLocalizedPath(pathname: string): { lang: Lang; path: string } | null {
  if (LOCALIZED_PATHS.includes(pathname)) return { lang: "ru", path: pathname };
  if (pathname === "/en/") return { lang: "en", path: "/" };
  if (pathname.startsWith("/en/")) {
    const rest = pathname.slice(3);
    if (LOCALIZED_PATHS.includes(rest) && rest !== "/") return { lang: "en", path: rest };
  }
  return null;
}

const MARKER = "var translations = ";

/**
 * Reads the `translations` object literal out of site.js without running the
 * page script. A few entries are built from the page's own endpoint URLs; the
 * browser fills those from window.location, here `origin` stands in.
 */
export function loadTranslations(siteJsPath: string, origin: string): Translations {
  const src = fs.readFileSync(siteJsPath, "utf8");
  const start = src.indexOf(MARKER);
  const end = src.indexOf("\n  };", start);
  if (start < 0 || end < 0) throw new Error("site.js: translations table not found");
  const literal = src.slice(start + MARKER.length, end + "\n  }".length);
  const table = vm.runInNewContext(`(${literal})`, { mcpUrl: `${origin}/mcp`, sseUrl: `${origin}/sse` }, { timeout: 1000 }) as Translations;
  if (!table || typeof table.ru !== "object" || typeof table.en !== "object") throw new Error("site.js: translations table is malformed");
  return table;
}

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function stripTags(str: string): string {
  return str.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/** Value of an attribute on one opening tag, or undefined. */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : undefined;
}

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s${name}=")[^"]*(")`);
  const safe = esc(value);
  if (re.test(tag)) return tag.replace(re, (_m, a, b) => a + safe + b);
  return tag.replace(/\s*\/?>$/, (end) => ` ${name}="${safe}"${end}`);
}

/** End index (exclusive) of the element whose opening tag ends at `from`, or -1. */
function elementEnd(html: string, tagName: string, from: number): number {
  const re = new RegExp(`<(/?)${tagName}(?=[\\s>/])[^>]*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/** Applies the dictionary to every data-i18n marker, attribute and content form alike. */
function translateMarkers(html: string, dict: Record<string, string>): string {
  const openRe = /<([a-zA-Z][\w-]*)(\s[^<>]*)?>/g;
  let out = "";
  let last = 0;
  for (let m = openRe.exec(html); m; m = openRe.exec(html)) {
    let tag = m[0];
    const name = m[1].toLowerCase();
    if (name === "script" || name === "style") {
      const close = html.toLowerCase().indexOf(`</${name}>`, m.index);
      if (close > 0) openRe.lastIndex = close;
      continue;
    }
    if (!/\sdata-i18n/.test(tag)) continue;

    const ariaKey = attr(tag, "data-i18n-aria-label");
    if (ariaKey !== undefined && dict[ariaKey] !== undefined) tag = setAttr(tag, "aria-label", dict[ariaKey]);
    const phKey = attr(tag, "data-i18n-placeholder");
    if (phKey !== undefined && dict[phKey] !== undefined) tag = setAttr(tag, "placeholder", dict[phKey]);

    const textKey = attr(tag, "data-i18n");
    const htmlKey = attr(tag, "data-i18n-html");
    const key = textKey ?? htmlKey;
    let inner: string | undefined;
    if (key !== undefined && dict[key] !== undefined) inner = textKey !== undefined ? esc(dict[key]) : dict[key];

    if (inner === undefined || /\/>$/.test(tag)) {
      out += html.slice(last, m.index) + tag;
      last = m.index + m[0].length;
      continue;
    }
    const end = elementEnd(html, name, m.index + m[0].length);
    if (end < 0) continue;
    const closeTag = `</${name}>`;
    out += html.slice(last, m.index) + tag + inner + closeTag;
    last = end;
    openRe.lastIndex = end;
  }
  return out + html.slice(last);
}

function translateJsonLd(html: string, dict: Record<string, string>, titleKey: string): string {
  return html.replace(/(<script type="application\/ld\+json">\s*)([\s\S]*?)(\s*<\/script>)/g, (whole, open, body, close) => {
    let data: any;
    try { data = JSON.parse(body); } catch { return whole; }
    const visit = (node: any): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node["@graph"]) visit(node["@graph"]);
      if (node["@type"] === "SoftwareApplication" && dict.jsonld_description) node.description = dict.jsonld_description;
      if (node["@type"] === "FAQPage" && Array.isArray(node.mainEntity)) {
        node.mainEntity.forEach((q: any, i: number) => {
          const qs = dict[`faq_q${i + 1}`];
          const as = dict[`faq_a${i + 1}`];
          if (qs && as) { q.name = qs; q.acceptedAnswer.text = stripTags(as); }
        });
      }
      if (node["@type"] === "BreadcrumbList" && Array.isArray(node.itemListElement) && dict[titleKey]) {
        const last = node.itemListElement[node.itemListElement.length - 1];
        if (last && last.position === 3) last.name = dict[titleKey].replace(/^mctl-alice — /, "");
      }
    };
    visit(data);
    return open + JSON.stringify(data, null, 2) + close;
  });
}

const SWITCHER_RE = /<div class="lang-switcher"[\s\S]*?<\/div>/;

function switcherHtml(lang: Lang, pagePath: string): string {
  const link = (l: Lang, href: string, label: string, short: string): string =>
    `<a class="lang-btn${l === lang ? " is-active" : ""}" lang="${l}" hreflang="${l}" href="${href}" aria-label="${label}"${l === lang ? ' aria-current="page"' : ""}>${short}</a>`;
  return `<nav class="lang-switcher" id="lang-switcher" aria-label="Language / Язык">
        ${link("ru", pagePath, "Русский", "RU")}
        ${link("en", enPath(pagePath), "English", "EN")}
      </nav>`;
}

/**
 * Turns the Russian rendering of a public page into the requested variant:
 * <html lang>, real-link language switcher, reciprocal hreflang (with
 * x-default) and, for English, translated text and /en-prefixed internal links.
 *
 * `base` is the absolute origin used in <head> (self-hosted without a public
 * origin passes ""; absolute alternates are then omitted, as the canonical is).
 * The static landing passes the "__BASE_URL__" placeholder, which the static
 * file server fills in or strips together with the canonical.
 */
export function localizePage(
  html: string,
  { lang, path: pagePath, base, dict }: { lang: Lang; path: string; base: string; dict: Record<string, string> }
): string {
  let out = html.replace(/<html lang="[a-z]+"/, `<html lang="${lang}" data-lang-static`);

  if (lang === "en") {
    const titleKey = /<html[^>]*\sdata-page-title-key="([^"]+)"/.exec(out)?.[1] ?? "meta_title";
    const descKey = /<html[^>]*\sdata-page-description-key="([^"]+)"/.exec(out)?.[1] ?? "meta_desc";
    out = translateMarkers(out, dict);
    out = translateJsonLd(out, dict, titleKey);
    const title = dict[titleKey] ?? dict.meta_title;
    if (title) {
      out = out.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(title)}</title>`);
      out = out.replace(/(<meta property="og:title" content=")[^"]*(")/, (_m, a, b) => a + esc(title) + b);
    }
    const desc = dict[descKey] ?? dict.meta_desc;
    if (desc && /<meta name="description"/.test(out)) {
      for (const sel of ['name="description"', 'property="og:description"', 'name="twitter:description"']) {
        out = out.replace(new RegExp(`(<meta ${sel} content=")[^"]*(")`), (_m, a, b) => a + esc(desc) + b);
      }
    }
    if (dict.meta_og_image_alt) {
      out = out.replace(/(<meta property="og:image:alt" content=")[^"]*(")/, (_m, a, b) => a + esc(dict.meta_og_image_alt) + b);
    }
    if (/\sid="copy-url"/.test(out) && dict.hero_copy_idle) {
      out = out.replace(/<button[^>]*\sid="copy-url"[^>]*>[\s\S]*?<\/button>/, (btn) => {
        let tag = /^<button[^>]*>/.exec(btn)![0];
        tag = setAttr(setAttr(tag, "data-idle", dict.hero_copy_idle), "data-done", dict.hero_copy_done);
        return tag + esc(dict.hero_copy_idle) + "</button>";
      });
    }
    // Internal links to pages that have an English variant stay in English.
    out = out.replace(/href="(\/(?:setup|about|privacy|terms|security)?)([#?][^"]*)?"/g, (_m, p: string, rest = "") => `href="${enPath(p)}${rest}"`);
    if (base) {
      const url = base + enPath(pagePath);
      out = out.replace(/(<link rel="canonical" href=")[^"]*(")/, (_m, a, b) => a + esc(url) + b);
      out = out.replace(/(<meta property="og:url" content=")[^"]*(")/, (_m, a, b) => a + esc(url) + b);
    }
  }

  // After the link rewrite above: the switcher's own hrefs are fixed paths.
  out = out.replace(SWITCHER_RE, () => switcherHtml(lang, pagePath));

  if (base) {
    const alt = (hreflang: string, href: string): string => `<link rel="alternate" hreflang="${hreflang}" href="${esc(href)}">`;
    const block = [alt("ru", base + pagePath), alt("en", base + enPath(pagePath)), alt("x-default", base + pagePath)].join("\n");
    out = out.replace("</head>", () => `${block}\n</head>`);
  }
  return out;
}
