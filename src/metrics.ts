/**
 * Prometheus metrics in the text exposition format, without a client library.
 *
 * Every label value comes from a fixed set chosen here (a route template, a
 * bucket name, an outcome), never from the request: a raw path, a query
 * string or a token would make the series count unbounded and leak secrets
 * into the time-series database.
 */
import http from "node:http";
import { VERSION } from "./version.js";

type Labels = Record<string, string>;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabels(labels: Labels): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

// Sorted, so the same label set built in a different property order is the same series.
const keyOf = (labels: Labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

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
  "Outbound Yandex calls by upstream and outcome (ok, 3xx, 4xx, 5xx, timeout, cancelled, error).",
);
export const upstreamDuration = new Histogram(
  "mctl_alice_upstream_request_duration_seconds",
  "Outbound Yandex call latency; includes reading the body when the caller reads it inside upstreamFetch.",
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
  // Own keys only: "constructor" must not resolve to Object.prototype's.
  return Object.hasOwn(UPSTREAMS, upstream) ? UPSTREAMS[upstream] : "other";
}

export type UpstreamOutcome = "ok" | "3xx" | "4xx" | "5xx" | "timeout" | "cancelled" | "error";

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

let sseStreams: () => number = () => 0;
/**
 * Reads the open SSE stream count at scrape time instead of counting opens and closes, so a
 * missed close cannot make the gauge drift. Each stream holds a socket and about 0.15 MiB.
 */
export function setSseStreamsSource(count: () => number): void {
  sseStreams = count;
}

export function renderMetrics(): string {
  return [
    "# HELP mctl_alice_build_info The running version; always 1.",
    "# TYPE mctl_alice_build_info gauge",
    `mctl_alice_build_info${formatLabels({ version: VERSION })} 1`,
    "# HELP mctl_alice_sse_streams_open Open long-lived SSE streams (GET /mcp, /sse) held by this process.",
    "# TYPE mctl_alice_sse_streams_open gauge",
    `mctl_alice_sse_streams_open ${sseStreams()}`,
    httpRequests.render(),
    authFailures.render(),
    rateLimited.render(),
    upstreamRequests.render(),
    upstreamDuration.render(),
  ].join("\n") + "\n";
}

/** METRICS_PORT, or null when unset or invalid: metrics are then not served at all. */
export function metricsPortFromEnv(): number | null {
  // Digits only: parseInt would read "9464x" as 9464 and Number "0x24e8" as 9448.
  const raw = (process.env.METRICS_PORT || "").trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * A listener of its own that serves only GET/HEAD /metrics. It is kept off the
 * application port on purpose: the Service and ingress route that port to the
 * public, so separating them makes /metrics unreachable from outside by
 * construction rather than by a check on request headers.
 */
export function createMetricsServer(): http.Server {
  return http.createServer((req, res) => {
    let pathname = "";
    try { pathname = new URL(req.url || "/", "http://localhost").pathname; } catch { /* answered 404 below */ }
    if (pathname !== "/metrics" || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : renderMetrics());
  });
}

/**
 * Starts the metrics listener. Metrics are optional, so a bind failure (for
 * example METRICS_PORT equal to PORT) is logged and leaves the application
 * server running instead of crashing the process.
 */
export function listenMetrics(port: number, host = "0.0.0.0"): http.Server {
  const server = createMetricsServer();
  server.on("error", (err) => console.error(`❌ [mctl-alice] metrics listener on port ${port} failed, metrics are off:`, err.message));
  server.listen(port, host, () => console.log(`   - Metrics:      GET /metrics on port ${port}`));
  return server;
}
