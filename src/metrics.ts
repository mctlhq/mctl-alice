/**
 * Prometheus metrics in the text exposition format, without a client library.
 *
 * Every label value comes from a fixed set chosen here (a route template, a
 * bucket name, an outcome), never from the request: a raw path, a query
 * string or a token would make the series count unbounded and leak secrets
 * into the time-series database.
 */
import { VERSION } from "./version.js";

type Labels = Record<string, string>;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabels(labels: Labels): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

const keyOf = (labels: Labels) => JSON.stringify(labels);

class Counter {
  private readonly series = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string) {}

  inc(labels: Labels, by = 1): void {
    const key = keyOf(labels);
    const entry = this.series.get(key);
    if (entry) entry.value += by;
    else this.series.set(key, { labels, value: by });
  }

  get(labels: Labels): number {
    return this.series.get(keyOf(labels))?.value ?? 0;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.series.values()) lines.push(`${this.name}${formatLabels(labels)} ${value}`);
    return lines.join("\n");
  }
}

class Histogram {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string, readonly buckets: number[]) {}

  observe(labels: Labels, value: number): void {
    const key = keyOf(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    this.buckets.forEach((le, i) => { if (value <= le) entry!.counts[i]++; });
    entry.sum += value;
    entry.count++;
  }

  count(labels: Labels): number {
    return this.series.get(keyOf(labels))?.count ?? 0;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, counts, sum, count } of this.series.values()) {
      this.buckets.forEach((le, i) => lines.push(`${this.name}_bucket${formatLabels({ ...labels, le: String(le) })} ${counts[i]}`));
      lines.push(`${this.name}_bucket${formatLabels({ ...labels, le: "+Inf" })} ${count}`);
      lines.push(`${this.name}_sum${formatLabels(labels)} ${sum}`);
      lines.push(`${this.name}_count${formatLabels(labels)} ${count}`);
    }
    return lines.join("\n");
  }
}

export const httpRequests = new Counter(
  "mctl_alice_http_requests_total",
  "HTTP requests by route template, method and status class.",
);
export const authFailures = new Counter(
  "mctl_alice_auth_failures_total",
  "Rejected authentication attempts by reason.",
);
export const rateLimited = new Counter(
  "mctl_alice_rate_limited_total",
  "Requests answered 429 by rate-limit bucket.",
);
export const upstreamRequests = new Counter(
  "mctl_alice_upstream_requests_total",
  "Outbound Yandex calls by upstream and outcome (ok, 3xx, 4xx, 5xx, timeout, error).",
);
export const upstreamDuration = new Histogram(
  "mctl_alice_upstream_request_duration_seconds",
  "Outbound Yandex call latency, including reading the response body.",
  [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30],
);

/** Every route the server answers, as written in http-server.ts; anything else is "other". */
const ROUTES = new Set([
  "/", "/healthz", "/readyz", "/metrics", "/favicon.svg", "/favicon.ico", "/robots.txt", "/openapi.json", "/openapi.yaml",
  "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/mcp/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp", "/.well-known/openid-configuration",
  "/oauth/register", "/oauth/authorize", "/oauth/token", "/oauth/revoke", "/oauth/yandex/callback",
  "/mcp", "/sse", "/mcp/sse", "/messages", "/mcp/messages",
  "/api/info", "/api/devices", "/api/say", "/api/command", "/api/volume", "/api/media", "/api/scenarios/trigger",
  "/about", "/privacy", "/terms", "/security",
  "/account", "/account/delete", "/account/delete-all", "/account/logout", "/account/disconnect-quasar", "/account/revoke-grant",
  "/auth/login", "/auth/callback", "/auth/save-token", "/auth/cookie", "/auth/qr-code", "/auth/qr-status", "/auth/save-cookie",
]);

export function routeTemplate(pathname: string): string {
  if (ROUTES.has(pathname)) return pathname;
  if (pathname.startsWith("/assets/")) return "/assets/*";
  return "other";
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]);

/** Counts one finished (or abandoned) response; call once, from the response's "close" event. */
export function recordHttpRequest(rawUrl: string | undefined, method: string | undefined, statusCode: number, headersSent: boolean): void {
  let pathname = "/";
  try { pathname = new URL(rawUrl || "/", "http://localhost").pathname; } catch { pathname = ""; }
  const statusClass = headersSent && statusCode >= 100 && statusCode < 600 ? `${Math.floor(statusCode / 100)}xx` : "aborted";
  httpRequests.inc({
    route: routeTemplate(pathname),
    method: method && METHODS.has(method) ? method : "other",
    status_class: statusClass,
  });
}

const UPSTREAMS: Record<string, string> = {
  "Yandex Quasar": "quasar",
  "Yandex OAuth": "oauth",
  "Yandex IoT": "iot",
  "Yandex Passport": "passport",
  "Yandex login": "login",
};

export function upstreamLabel(upstream: string): string {
  return UPSTREAMS[upstream] ?? "other";
}

export type UpstreamOutcome = "ok" | "3xx" | "4xx" | "5xx" | "timeout" | "error";

export function outcomeForStatus(status: number): UpstreamOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "error";
}

export function recordUpstream(upstream: string, outcome: UpstreamOutcome, seconds: number): void {
  const name = upstreamLabel(upstream);
  upstreamRequests.inc({ upstream: name, outcome });
  upstreamDuration.observe({ upstream: name }, seconds);
}

export function renderMetrics(): string {
  return [
    "# HELP mctl_alice_build_info The running version; always 1.",
    "# TYPE mctl_alice_build_info gauge",
    `mctl_alice_build_info${formatLabels({ version: VERSION })} 1`,
    httpRequests.render(),
    authFailures.render(),
    rateLimited.render(),
    upstreamRequests.render(),
    upstreamDuration.render(),
  ].join("\n") + "\n";
}

/**
 * Headers a reverse proxy adds. /metrics is for the in-cluster scrape, which
 * connects to the pod directly; a request that came through the ingress
 * carries at least one of these and is refused, behind the edge deny route.
 */
const PROXY_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded", "cf-connecting-ip", "x-forwarded-host"];

export function cameThroughProxy(headers: Record<string, string | string[] | undefined>): boolean {
  return PROXY_HEADERS.some((h) => headers[h] !== undefined);
}
