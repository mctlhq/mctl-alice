import { IStorage } from "./storage-interface.js";
import { OAuthStorage } from "./oauth-storage.js";
import { MinioStorage } from "./minio-storage.js";

/**
 * Storage factory: selects MinioStorage if MINIO_ENDPOINT or MINIO_ACCESS_KEY is present,
 * otherwise falls back to local SQLite OAuthStorage.
 */
export function createStorage(dbPath?: string): IStorage {
  if (process.env.MINIO_ENDPOINT || process.env.MINIO_ACCESS_KEY) {
    console.log("📦 [Storage] Initialized MinIO S3 object storage backend");
    return new MinioStorage();
  }
  console.log("💾 [Storage] Initialized SQLite local storage backend");
  return new OAuthStorage(dbPath);
}

export * from "./storage-interface.js";
export { OAuthStorage } from "./oauth-storage.js";
export * from "./minio-storage.js";
export * from "./crypto.js";
