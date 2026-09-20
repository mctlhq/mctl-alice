import { StationService } from "./station-service.js";
import { ITelemetryStorage, TelemetrySample } from "../storage/telemetry-storage.js";

export interface TelemetrySamplerOptions {
  intervalMs?: number;
  retentionDays?: number;
  enabled?: boolean;
}

export class TelemetrySampler {
  private timer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private isSampling = false;
  private intervalMs: number;
  private retentionDays: number;
  private enabled: boolean;

  constructor(
    private stationService: StationService,
    private storage: ITelemetryStorage,
    options: TelemetrySamplerOptions = {}
  ) {
    this.intervalMs =
      options.intervalMs ??
      parseInt(process.env.TELEMETRY_SAMPLE_INTERVAL_MS || "60000", 10);
    this.retentionDays =
      options.retentionDays ??
      parseInt(process.env.TELEMETRY_RETENTION_DAYS || "30", 10);
    this.enabled =
      options.enabled ?? (process.env.TELEMETRY_SAMPLING_ENABLED !== "false");
  }

  /**
   * Start periodic sampling in background
   */
  start(): void {
    if (!this.enabled) {
      console.log("ℹ️ [TelemetrySampler] Background sampling disabled by configuration.");
      return;
    }

    if (this.timer) {
      return;
    }

    console.log(
      `📊 [TelemetrySampler] Started background sampling every ${Math.round(
        this.intervalMs / 1000
      )}s (retention: ${this.retentionDays} days)`
    );

    // Initial sample with small delay so server startup finishes
    setTimeout(() => {
      this.collectSample().catch((err) => {
        console.warn(`⚠️ [TelemetrySampler] Initial sample error: ${err.message}`);
      });
    }, 2000);

    this.timer = setInterval(() => {
      this.collectSample().catch((err) => {
        console.warn(`⚠️ [TelemetrySampler] Sample collection error: ${err.message}`);
      });
    }, this.intervalMs);

    // Prune old samples once every 24 hours
    this.pruneTimer = setInterval(async () => {
      try {
        const deleted = await this.storage.pruneOld(this.retentionDays);
        if (deleted > 0) {
          console.log(`🧹 [TelemetrySampler] Pruned ${deleted} old telemetry samples.`);
        }
      } catch (err: any) {
        console.warn(`⚠️ [TelemetrySampler] Prune error: ${err.message}`);
      }
    }, 24 * 60 * 60 * 1000);
  }

  /**
   * Stop periodic sampling
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    console.log("🛑 [TelemetrySampler] Stopped background sampling.");
  }

  /**
   * Run one single collection round from Yandex IoT Cloud
   */
  async collectSample(): Promise<number> {
    if (this.isSampling) return 0;
    this.isSampling = true;

    try {
      const info = await this.stationService.getUserInfo();
      const roomsById = new Map<string, string>();
      for (const room of info.rooms || []) {
        roomsById.set(room.id, room.name);
      }

      const now = Date.now();
      const samples: TelemetrySample[] = [];

      for (const device of info.devices || []) {
        const roomName = (device.room && roomsById.get(device.room)) || undefined;

        // 1. Collect numeric/float properties (power, voltage, temperature, humidity, etc.)
        if (device.properties && device.properties.length > 0) {
          for (const prop of device.properties) {
            if (prop.state && typeof prop.state.value === "number") {
              const metric = prop.state.instance || prop.parameters?.instance || "unknown";
              samples.push({
                deviceId: device.id,
                deviceName: device.name,
                roomName,
                metric,
                value: prop.state.value,
                unit: prop.parameters?.unit,
                timestamp: now,
              });
            }
          }
        }

        // 2. Collect on/off capability state
        if (device.capabilities && device.capabilities.length > 0) {
          const onOffCap = device.capabilities.find(
            (c) => c.type === "devices.capabilities.on_off"
          );
          if (onOffCap?.state && typeof onOffCap.state.value === "boolean") {
            samples.push({
              deviceId: device.id,
              deviceName: device.name,
              roomName,
              metric: "on_off",
              value: onOffCap.state.value ? 1 : 0,
              timestamp: now,
            });
          }
        }
      }

      if (samples.length > 0) {
        await this.storage.saveSamples(samples);
      }

      return samples.length;
    } finally {
      this.isSampling = false;
    }
  }
}
