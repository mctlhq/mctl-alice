import { IStorage } from "./storage-interface.js";
import { OAuthStorage } from "./oauth-storage.js";
import { MinioStorage } from "./minio-storage.js";
import { PostgresStorage, PostgresTelemetryStorage } from "./postgres-storage.js";
import { ITelemetryStorage, TelemetryStorage } from "./telemetry-storage.js";

/**
 * Storage factory: selects PostgresStorage if DATABASE_URL or PGHOST is present,
 * MinioStorage if MINIO_ENDPOINT or MINIO_ACCESS_KEY is present,
 * otherwise falls back to local SQLite OAuthStorage.
 */
export function createStorage(dbPath?: string): IStorage {
  if (process.env.DATABASE_URL || process.env.PGHOST) {
    console.log("🐘 [Storage] Initialized PostgreSQL storage backend");
    return new PostgresStorage({ connectionString: process.env.DATABASE_URL });
  }
  if (process.env.MINIO_ENDPOINT || process.env.MINIO_ACCESS_KEY) {
    console.log("📦 [Storage] Initialized MinIO S3 object storage backend");
    return new MinioStorage();
  }
  console.log("💾 [Storage] Initialized SQLite local storage backend");
  return new OAuthStorage(dbPath);
}

/**
 * Telemetry storage factory: selects PostgresTelemetryStorage if DATABASE_URL is present,
 * otherwise falls back to local SQLite TelemetryStorage.
 */
export function createTelemetryStorage(dbPath?: string): ITelemetryStorage {
  if (process.env.DATABASE_URL || process.env.PGHOST) {
    console.log("🐘 [Telemetry] Initialized PostgreSQL telemetry backend");
    return new PostgresTelemetryStorage({ connectionString: process.env.DATABASE_URL });
  }
  console.log("💾 [Telemetry] Initialized SQLite local telemetry backend");
  return new TelemetryStorage(dbPath);
}

export * from "./storage-interface.js";
export { OAuthStorage } from "./oauth-storage.js";
export * from "./minio-storage.js";
export * from "./postgres-storage.js";
export * from "./telemetry-storage.js";
export * from "./crypto.js";

