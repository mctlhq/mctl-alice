/**
 * Live usage numbers for the public home page. Public and unauthenticated, so it serves a
 * snapshot sampled in the background, never a database query per request, and the snapshot
 * carries only aggregates.
 */
import type { IStorage, UsageTotals } from "../storage/storage-interface.js";

export interface PublicStats extends UsageTotals {
  /** Open long-lived MCP streams at response time. */
  sessionsOnline: number;
  sampledAt: string;
}

export class PublicStatsCache {
  private totals: (UsageTotals & { sampledAt: string }) | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly storage: IStorage,
    private readonly sessionsOnline: () => number,
  ) {}

  /** Keeps the previous snapshot when a sample fails: a failed read is not a zero. */
  async sample(): Promise<void> {
    try {
      this.totals = { ...(await this.storage.getUsageTotals()), sampledAt: new Date().toISOString() };
    } catch (err) {
      console.warn(`[public-stats] sample failed: ${err instanceof Error ? err.name : "error"}`);
    }
  }

  start(refreshMs: number): void {
    if (refreshMs <= 0 || this.timer) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Null until the first successful sample. */
  snapshot(): PublicStats | null {
    return this.totals ? { ...this.totals, sessionsOnline: this.sessionsOnline() } : null;
  }
}

export function publicStatsRefreshMs(underTest = false): number {
  const raw = process.env.PUBLIC_STATS_REFRESH_MS;
  const fallback = underTest ? 0 : 300_000;
  const n = raw === undefined ? fallback : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
