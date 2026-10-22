import { ITelemetryStorage } from "../storage/telemetry-storage.js";

export interface TelemetryRetentionOptions {
  /** Samples older than this are deleted; defaults to TELEMETRY_RETENTION_DAYS or 30. */
  retentionDays?: number;
  /** Time between runs (default 6 h). */
  intervalMs?: number;
  /** Delay before the first run, so startup finishes first (default 60 s). */
  initialDelayMs?: number;
  /** Rows deleted per statement (default 5000). */
  batchSize?: number;
  /** Pause between statements (default 200 ms). */
  batchPauseMs?: number;
}

export interface RetentionRunResult {
  deleted: number;
  batches: number;
  durationMs: number;
}

const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** TELEMETRY_RETENTION_DAYS as a positive integer; anything else keeps the default. */
export function retentionDaysFromEnv(value = process.env.TELEMETRY_RETENTION_DAYS): number {
  if (value === undefined || value.trim() === "") return DEFAULT_RETENTION_DAYS;
  const days = Number(value);
  if (Number.isInteger(days) && days > 0) return days;
  console.warn(`⚠️ [TelemetryRetention] Ignoring invalid TELEMETRY_RETENTION_DAYS; keeping ${DEFAULT_RETENTION_DAYS} days.`);
  return DEFAULT_RETENTION_DAYS;
}

/**
 * Deletes telemetry samples past the retention period for every owner. It runs
 * in every mode, independent of the sampler: hosted mode records nothing new,
 * but rows written before still have to age out.
 */
export class TelemetryRetention {
  private readonly retentionDays: number;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly batchSize: number;
  private readonly batchPauseMs: number;
  private startTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private storage: ITelemetryStorage, options: TelemetryRetentionOptions = {}) {
    this.retentionDays = options.retentionDays ?? retentionDaysFromEnv();
    this.intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000;
    this.initialDelayMs = options.initialDelayMs ?? 60_000;
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? 5000));
    this.batchPauseMs = options.batchPauseMs ?? 200;
  }

  start(): void {
    if (this.startTimer || this.timer) return;
    this.stopped = false;
    const tick = () => { void this.runOnce().catch(() => { /* logged in runOnce */ }); };
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.stopped) return;
      tick();
      this.timer = setInterval(tick, this.intervalMs);
      this.timer.unref();
    }, this.initialDelayMs);
    this.startTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.timer) clearInterval(this.timer);
    this.startTimer = null;
    this.timer = null;
  }

  /**
   * One pass: deletes in batches until a batch comes back short. Returns null
   * when a pass is already in progress in this process.
   */
  async runOnce(): Promise<RetentionRunResult | null> {
    if (this.running) return null;
    this.running = true;
    const started = Date.now();
    const cutoff = started - this.retentionDays * DAY_MS;
    let deleted = 0;
    let batches = 0;
    try {
      for (;;) {
        const n = await this.storage.pruneBatch(cutoff, this.batchSize);
        deleted += n;
        batches++;
        if (n < this.batchSize || this.stopped) break;
        if (this.batchPauseMs > 0) await new Promise((resolve) => setTimeout(resolve, this.batchPauseMs).unref());
        // stop() may land during the pause; on shutdown the store is closing.
        if (this.stopped) break;
      }
      const result = { deleted, batches, durationMs: Date.now() - started };
      console.log(
        `🧹 [TelemetryRetention] Deleted ${deleted} samples older than ${this.retentionDays} days in ${batches} batches (${result.durationMs} ms).`
      );
      return result;
    } catch (err: any) {
      console.warn(
        `⚠️ [TelemetryRetention] Run failed after deleting ${deleted} samples in ${batches} batches (${Date.now() - started} ms): ${err?.message ?? String(err)}`
      );
      throw err;
    } finally {
      this.running = false;
    }
  }
}
