import { randomUUID } from "node:crypto";
import { ALICE_TOOLS } from "./tools/definitions.js";

export type LogLevel = "info" | "warn" | "error";

/**
 * One JSON object per line on stdout/stderr. `ts`, `level` and `msg` are
 * written last so a caller's field can never overwrite them. Callers pass
 * only fixed-vocabulary values (a route template, a tool name from the
 * registry, an error class): never a URL, a query string, a header value, a
 * message or a credential. The sibling `[upstream-failure]` lines keep their
 * key=value form, which existing log searches rely on.
 */
export function logEvent(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ...fields, ts: new Date().toISOString(), level, msg });
  if (level === "info") console.log(line);
  else if (level === "warn") console.warn(line);
  else console.error(line);
}

/**
 * The id a request is logged under: Cloudflare's cf-ray when it looks like
 * one, so a log line can be matched to an edge log, else a fresh UUID. The
 * header is client-controlled, so anything that is not a short token of
 * letters, digits and dashes is ignored rather than echoed.
 */
export function requestId(cfRay: unknown): string {
  return typeof cfRay === "string" && /^[A-Za-z0-9-]{1,64}$/.test(cfRay) ? cfRay : randomUUID();
}

/**
 * The product token of a User-Agent ("codex-mcp-client" from
 * "codex-mcp-client/0.163.0"), enough to tell client families apart in a log
 * and nothing that identifies a person or a device. Anything that does not
 * start with a plain token is "other".
 */
export function uaFamily(userAgent: unknown): string {
  if (typeof userAgent !== "string") return "none";
  const m = /^([A-Za-z][A-Za-z0-9._-]{0,39})(?:[/\s;(]|$)/.exec(userAgent);
  return m ? m[1] : "other";
}

const KNOWN_TOOLS = new Set(ALICE_TOOLS.map((t) => t.name));

/** A tool name safe to log: a registered name, else "unknown" (the name is client-supplied). */
export function toolLabel(name: unknown): string {
  return typeof name === "string" && KNOWN_TOOLS.has(name) ? name : "unknown";
}

/** Routes that are probed or scraped continuously and carry no information per request. */
export const QUIET_ROUTES = new Set(["/healthz", "/readyz", "/metrics"]);
