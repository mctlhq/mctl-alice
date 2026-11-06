import { IStorage } from "../storage/storage-interface.js";

export interface ExpiredRecordPrunerOptions {
  /** Time between runs (default 6 h, which the privacy page states). */
  intervalMs?: number;
  /** Delay before the first run, so startup finishes first (default 60 s). */
  initialDelayMs?: number;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 60 * 1000;

/** Runs the storage's pruneExpired on a timer. Pruning is idempotent, so replicas may overlap. */
export class ExpiredRecordPruner {
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private startTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private storage: Pick<IStorage, "pruneExpired">, options: ExpiredRecordPrunerOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  }

  start(): void {
    this.stopped = false;
    const tick = () => { void this.runOnce(); };
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

  /** One pass. A failure is logged and retried on the next tick. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.storage.pruneExpired?.();
    } catch (err: any) {
      console.error(`[ExpiredRecordPruner] Pruning failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
