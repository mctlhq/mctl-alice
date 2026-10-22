import type http from "node:http";

export type RateLimitBucket = "register" | "token" | "authorize" | "login" | "qr" | "qrstatus" | "mcp";

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSec: number };

/**
 * In-process sliding-window counter (current window plus the weighted previous
 * one). State is bounded by `maxKeys`; when full, the oldest keys are dropped,
 * so a swept key restarts with a fresh budget (fail open, bounded memory).
 */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly entries = new Map<string, { windowStart: number; count: number; previous: number }>();

  constructor({ limit, windowMs = 60_000, maxKeys = 10_000 }: { limit: number; windowMs?: number; maxKeys?: number }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  get size(): number {
    return this.entries.size;
  }

  hit(key: string, now = Date.now()): RateLimitResult {
    let entry = this.entries.get(key);
    if (entry) {
      const elapsedWindows = Math.floor((now - entry.windowStart) / this.windowMs);
      if (elapsedWindows >= 2) entry = undefined;
      else if (elapsedWindows === 1) entry = { windowStart: entry.windowStart + this.windowMs, count: 0, previous: entry.count };
    }
    if (!entry) {
      this.makeRoom(now);
      entry = { windowStart: now, count: 0, previous: 0 };
    }
    // Refresh recency so Map insertion order tracks last use.
    this.entries.delete(key);
    this.entries.set(key, entry);

    const progress = (now - entry.windowStart) / this.windowMs;
    const used = entry.previous * (1 - progress) + entry.count;
    if (used >= this.limit) {
      // Time until the weighted previous window has decayed enough for one more hit.
      const needed = used - this.limit + 1;
      const waitMs = entry.previous > 0 ? Math.min(this.windowMs, (needed / entry.previous) * this.windowMs) : entry.windowStart + this.windowMs - now;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    entry.count++;
    return { allowed: true };
  }

  private makeRoom(now: number): void {
    if (this.entries.size < this.maxKeys) return;
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart >= 2 * this.windowMs) this.entries.delete(key);
    }
    // Still full: drop the least recently used keys.
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxKeys) break;
      this.entries.delete(key);
    }
  }
}

/**
 * The client address. With `trustProxyHops` N > 0 it is the N-th entry from
 * the right of X-Forwarded-For; only set that behind a proxy you control, or
 * clients can pick their own key.
 */
export function clientAddress(req: http.IncomingMessage, trustProxyHops = trustProxyHopsFromEnv()): string {
  if (trustProxyHops > 0) {
    const header = req.headers["x-forwarded-for"];
    const parts = (Array.isArray(header) ? header.join(",") : header || "").split(",").map((p) => p.trim()).filter(Boolean);
    const candidate = parts[parts.length - trustProxyHops];
    if (candidate) return candidate;
  }
  return req.socket.remoteAddress || "unknown";
}

export function trustProxyHopsFromEnv(): number {
  const n = Number.parseInt(process.env.TRUST_PROXY_HOPS || "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Maps a route to its rate-limit bucket, or null for routes that are never limited. */
export function rateLimitBucket(pathname: string, method: string | undefined, accept = ""): RateLimitBucket | null {
  if (pathname === "/oauth/register") return "register";
  if (pathname === "/oauth/token" || pathname === "/oauth/revoke") return "token";
  if (pathname === "/oauth/authorize") return "authorize";
  if (pathname === "/auth/qr-code") return "qr";
  if (pathname === "/auth/qr-status") return "qrstatus";
  if (["/auth/login", "/auth/callback", "/auth/save-cookie", "/auth/save-token"].includes(pathname)) return "login";
  if (["/mcp", "/sse", "/mcp/sse", "/messages", "/mcp/messages"].includes(pathname)) return "mcp";
  // GET / is the landing page unless the client asks for an event stream.
  if (pathname === "/") return (method === "GET" || method === "HEAD") && !accept.includes("text/event-stream") ? null : "mcp";
  if (pathname.startsWith("/api/") && pathname !== "/api/info") return "mcp";
  return null;
}

export const DEFAULT_RATE_LIMITS: Record<RateLimitBucket, number> = {
  register: 10,
  token: 30,
  authorize: 30,
  login: 30,
  qr: 10,
  qrstatus: 90,
  mcp: 300,
};

export function resolveRateLimits(overrides: Partial<Record<RateLimitBucket, number>> = {}): Record<RateLimitBucket, number> {
  const out = { ...DEFAULT_RATE_LIMITS };
  for (const bucket of Object.keys(out) as RateLimitBucket[]) {
    const fromEnv = Number.parseInt(process.env[`RATE_LIMIT_${bucket.toUpperCase()}`] || "", 10);
    if (Number.isFinite(fromEnv) && fromEnv > 0) out[bucket] = fromEnv;
    const override = overrides[bucket];
    if (override !== undefined && override > 0) out[bucket] = override;
  }
  return out;
}
