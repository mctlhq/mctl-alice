/** Bounded outbound calls to Yandex, and error text that never carries a raw upstream body. */
import { createHash } from "node:crypto";
import { outcomeForStatus, recordUpstream } from "../metrics.js";

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;

export class UpstreamTimeoutError extends Error {
  readonly statusCode = 504;
  constructor(readonly upstream: string, readonly timeoutMs: number) {
    super(`${upstream} did not respond within ${Math.round(timeoutMs / 1000)}s`);
    this.name = "UpstreamTimeoutError";
  }
}

/** The caller's own signal (for example a cleanup deadline) stopped the call, not the upstream's deadline. */
export class UpstreamCancelledError extends Error {
  // A deadline ran out before the upstream answered: a gateway timeout to our client, like UpstreamTimeoutError.
  readonly statusCode = 504;
  constructor(readonly upstream: string, reason: unknown) {
    super(`${upstream} call stopped: ${reason instanceof Error && reason.name === "TimeoutError" ? "the caller's deadline expired" : "cancelled by the caller"}`);
    this.name = "UpstreamCancelledError";
  }
}

export class UpstreamError extends Error {
  readonly statusCode = 502;
  constructor(message: string, readonly upstream: string, readonly status?: number) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface UpstreamOptions {
  /** Human name used in error messages, for example "Yandex Quasar". */
  upstream: string;
  timeoutMs?: number;
  /** An additional caller deadline or cancellation, for example a cleanup deadline. */
  signal?: AbortSignal;
  /** Opaque short reference to the calling user (see `userRef`), for the failure log line only. Never a metric label. */
  userRef?: string;
}

/** Stable, non-reversible 8-hex tag of an internal user id: lets a log reader count distinct affected users without learning who they are. */
export const userRef = (userId: string) => createHash("sha256").update(userId).digest("hex").slice(0, 8);

/**
 * One line per failed outbound call. Only fixed, non-secret fields: the error class and the
 * network-level cause code (ECONNRESET, ENOTFOUND, ...), never the message, URL, headers or body.
 */
function logUpstreamFailure(upstream: string, outcome: "error" | "timeout", seconds: number, userRef: string | undefined, err?: unknown): void {
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code ?? (err as { code?: unknown } | undefined)?.code;
  const fields = [
    `upstream=${JSON.stringify(upstream)}`,
    `outcome=${outcome}`,
    `elapsed_s=${seconds.toFixed(2)}`,
    `user=${userRef ?? "-"}`,
    ...(err instanceof Error ? [`error=${err.name}`] : []),
    ...(typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? [`cause=${code}`] : []),
  ];
  console.error(`[upstream-failure] ${fields.join(" ")}`);
}

const isAbort = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

/** fetch with a deadline that also bounds reading the response body: use `read` for that. */
export async function upstreamFetch<T = Response>(
  url: string,
  init: RequestInit,
  { upstream, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS, signal, userRef }: UpstreamOptions,
  read?: (res: Response) => Promise<T>,
): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([deadline, ...(signal ? [signal] : []), ...(init.signal ? [init.signal] : [])]);
  const started = performance.now();
  const elapsed = () => (performance.now() - started) / 1000;
  try {
    const res = await fetch(url, { ...init, signal: combined });
    const out = read ? await read(res) : (res as unknown as T);
    recordUpstream(upstream, outcomeForStatus(res.status), elapsed());
    return out;
  } catch (err) {
    if (deadline.aborted && isAbort(err)) {
      recordUpstream(upstream, "timeout", elapsed());
      logUpstreamFailure(upstream, "timeout", elapsed(), userRef);
      throw new UpstreamTimeoutError(upstream, timeoutMs);
    }
    if (!deadline.aborted && signal?.aborted && isAbort(err)) {
      recordUpstream(upstream, "cancelled", elapsed());
      throw new UpstreamCancelledError(upstream, signal.reason);
    }
    recordUpstream(upstream, "error", elapsed());
    logUpstreamFailure(upstream, "error", elapsed(), userRef, err);
    throw err;
  }
}

/**
 * At most `maxBytes` of a body as text, then the rest is cancelled unread. For bodies
 * only ever turned into a short error message, so they are bounded by size and not
 * only by the deadline.
 */
export async function readTextPrefix(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    if (size >= maxBytes) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes.subarray(0, maxBytes));
}

const MAX_MESSAGE_CHARS = 120;
const KNOWN_FIELDS = ["message", "error_description", "error", "code"] as const;

function clean(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/<[^>]*>?/g, " ")
    .replace(/[<>"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS)
    .trim();
}

/** A short message taken from a known JSON field of an upstream body, else a fixed fallback. */
export function sanitizeUpstreamMessage(bodyText: unknown): string {
  const fallback = "unexpected response";
  if (typeof bodyText !== "string") return fallback;
  let parsed: unknown;
  try { parsed = JSON.parse(bodyText); } catch { return fallback; }
  if (!parsed || typeof parsed !== "object") return fallback;
  for (const field of KNOWN_FIELDS) {
    const value = (parsed as Record<string, unknown>)[field];
    if (typeof value === "string" || typeof value === "number") {
      const text = clean(String(value));
      if (text) return text;
    }
  }
  return fallback;
}

export function upstreamError(upstream: string, status: number, bodyText: string): UpstreamError {
  return new UpstreamError(`${upstream} error (${status}): ${sanitizeUpstreamMessage(bodyText)}`, upstream, status);
}
