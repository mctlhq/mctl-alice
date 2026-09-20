import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";

export interface TelemetrySample {
  deviceId: string;
  deviceName: string;
  roomName?: string;
  metric: string;
  value: number;
  unit?: string;
  timestamp: number; // Unix timestamp in ms
}

export interface HistoryDataPoint {
  timestamp: number;
  timeIso: string;
  value: number;
  minValue?: number;
  maxValue?: number;
  sampleCount?: number;
  metric: string;
  unit?: string;
}

export interface TelemetryHistoryResult {
  deviceId: string;
  deviceName: string;
  roomName?: string;
  metric: string;
  unit?: string;
  from: number;
  to: number;
  fromIso: string;
  toIso: string;
  resolution: string;
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  latest: number | null;
  totalEnergyKWh?: number; // Calculated when metric === "power"
  points: HistoryDataPoint[];
}

export interface QueryHistoryOptions {
  deviceId: string;
  metric?: string;
  from: number;
  to: number;
  resolution?: "max" | "1m" | "5m" | "15m" | "1h";
}

export class TelemetryStorage {
  private db: DatabaseSync;
  private insertStmt: StatementSync;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || process.env.TELEMETRY_DB_PATH || "./data/telemetry.db";

    if (resolvedPath !== ":memory:") {
      const dir = path.dirname(path.resolve(resolvedPath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(resolvedPath);
    this.initTables();
    this.insertStmt = this.db.prepare(
      `INSERT INTO telemetry_samples (device_id, device_name, room_name, metric, value, unit, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        room_name TEXT,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_query ON telemetry_samples(device_id, metric, timestamp);
      CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry_samples(timestamp);
    `);
  }

  /**
   * Batch insert telemetry samples in a single transaction
   */
  saveSamples(samples: TelemetrySample[]): void {
    if (samples.length === 0) return;

    this.db.exec("BEGIN");
    try {
      for (const s of samples) {
        this.insertStmt.run(
          s.deviceId,
          s.deviceName,
          s.roomName ?? null,
          s.metric,
          s.value,
          s.unit ?? null,
          s.timestamp
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Query historical data points and compute aggregate statistics and energy consumption
   */
  queryHistory(options: QueryHistoryOptions): TelemetryHistoryResult {
    const { deviceId, from, to } = options;
    const metric = options.metric || "power";
    const resolution = options.resolution || "max";

    const bucketMs = this.getBucketMs(resolution);
    let rows: any[] = [];

    if (bucketMs === 0) {
      // Raw / max resolution
      if (metric === "all") {
        const stmt = this.db.prepare(
          `SELECT device_id, device_name, room_name, metric, value, unit, timestamp
           FROM telemetry_samples
           WHERE device_id = ? AND timestamp >= ? AND timestamp <= ?
           ORDER BY timestamp ASC`
        );
        rows = stmt.all(deviceId, from, to);
      } else {
        const stmt = this.db.prepare(
          `SELECT device_id, device_name, room_name, metric, value, unit, timestamp
           FROM telemetry_samples
           WHERE device_id = ? AND metric = ? AND timestamp >= ? AND timestamp <= ?
           ORDER BY timestamp ASC`
        );
        rows = stmt.all(deviceId, metric, from, to);
      }
    } else {
      // Bucketed aggregation
      if (metric === "all") {
        const stmt = this.db.prepare(
          `SELECT device_id, device_name, room_name, metric, unit,
                  AVG(value) as value, MIN(value) as min_value, MAX(value) as max_value, COUNT(*) as sample_count,
                  CAST(timestamp / ? AS INTEGER) * ? as timestamp
           FROM telemetry_samples
           WHERE device_id = ? AND timestamp >= ? AND timestamp <= ?
           GROUP BY CAST(timestamp / ? AS INTEGER), metric
           ORDER BY timestamp ASC`
        );
        rows = stmt.all(bucketMs, bucketMs, deviceId, from, to, bucketMs);
      } else {
        const stmt = this.db.prepare(
          `SELECT device_id, device_name, room_name, metric, unit,
                  AVG(value) as value, MIN(value) as min_value, MAX(value) as max_value, COUNT(*) as sample_count,
                  CAST(timestamp / ? AS INTEGER) * ? as timestamp
           FROM telemetry_samples
           WHERE device_id = ? AND metric = ? AND timestamp >= ? AND timestamp <= ?
           GROUP BY CAST(timestamp / ? AS INTEGER)
           ORDER BY timestamp ASC`
        );
        rows = stmt.all(bucketMs, bucketMs, deviceId, metric, from, to, bucketMs);
      }
    }

    // Determine metadata from first row if available
    const first = rows[0];
    const deviceName = first?.device_name || deviceId;
    const roomName = first?.room_name || undefined;
    const unit = first?.unit || (metric === "power" ? "unit.watt" : undefined);

    let minVal: number | null = null;
    let maxVal: number | null = null;
    let sumVal = 0;
    let latestVal: number | null = null;

    const points: HistoryDataPoint[] = [];

    for (const r of rows) {
      const val = Number(r.value);
      const rowMin = r.min_value !== undefined ? Number(r.min_value) : val;
      const rowMax = r.max_value !== undefined ? Number(r.max_value) : val;

      if (minVal === null || rowMin < minVal) minVal = rowMin;
      if (maxVal === null || rowMax > maxVal) maxVal = rowMax;
      sumVal += val;
      latestVal = val;

      points.push({
        timestamp: Number(r.timestamp),
        timeIso: new Date(Number(r.timestamp)).toISOString(),
        value: Number(val.toFixed(2)),
        minValue: r.min_value !== undefined ? Number(rowMin.toFixed(2)) : undefined,
        maxValue: r.max_value !== undefined ? Number(rowMax.toFixed(2)) : undefined,
        sampleCount: r.sample_count ? Number(r.sample_count) : 1,
        metric: r.metric,
        unit: r.unit,
      });
    }

    const count = points.length;
    const avgVal = count > 0 ? Number((sumVal / count).toFixed(2)) : null;

    // Calculate energy consumption (kWh) if metric === "power"
    let totalEnergyKWh: number | undefined;
    if (metric === "power" && points.length >= 1) {
      totalEnergyKWh = this.calculateEnergyKWh(points);
    }

    return {
      deviceId,
      deviceName,
      roomName,
      metric,
      unit,
      from,
      to,
      fromIso: new Date(from).toISOString(),
      toIso: new Date(to).toISOString(),
      resolution,
      count,
      min: minVal !== null ? Number(minVal.toFixed(2)) : null,
      max: maxVal !== null ? Number(maxVal.toFixed(2)) : null,
      avg: avgVal,
      latest: latestVal !== null ? Number(latestVal.toFixed(2)) : null,
      totalEnergyKWh,
      points,
    };
  }

  /**
   * Numerical integration of power (W) over time (ms) to yield total energy in kWh
   * Uses trapezoidal rule: E = sum( (P_i + P_{i+1})/2 * delta_t ) / (3600 * 1000)
   * Caps maximum allowed time gap between adjacent samples to 10 minutes to prevent
   * integrating through long service downtime.
   */
  private calculateEnergyKWh(points: HistoryDataPoint[]): number {
    if (points.length === 0) return 0;
    if (points.length === 1) {
      // Single sample: estimate 1 minute duration
      return Number(((points[0].value * 60) / (3600 * 1000)).toFixed(4));
    }

    const MAX_GAP_MS = 10 * 60 * 1000; // 10 minutes max gap
    let totalWattHours = 0;

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const dtMs = p2.timestamp - p1.timestamp;

      if (dtMs > 0 && dtMs <= MAX_GAP_MS) {
        const avgPowerW = (p1.value + p2.value) / 2;
        const hours = dtMs / (3600 * 1000);
        totalWattHours += avgPowerW * hours;
      } else if (dtMs > MAX_GAP_MS) {
        // Gap too long: treat p1 as lasting 1 minute
        totalWattHours += p1.value * (60 / 3600);
      }
    }

    // Add trailing point estimated as 1 minute
    const lastPoint = points[points.length - 1];
    totalWattHours += lastPoint.value * (60 / 3600);

    const totalKWh = totalWattHours / 1000;
    return Number(totalKWh.toFixed(4));
  }

  private getBucketMs(resolution: string): number {
    switch (resolution) {
      case "5m":
        return 5 * 60 * 1000;
      case "15m":
        return 15 * 60 * 1000;
      case "1h":
        return 60 * 60 * 1000;
      case "1m":
      case "max":
      default:
        return 0;
    }
  }

  /**
   * Delete records older than retentionDays (default 30)
   */
  pruneOld(retentionDays = 30): number {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare("DELETE FROM telemetry_samples WHERE timestamp < ?");
    const info = stmt.run(cutoff);
    return Number(info.changes);
  }

  close(): void {
    this.db.close();
  }
}
