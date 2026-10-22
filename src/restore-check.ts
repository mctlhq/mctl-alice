import pg from "pg";
import { checkRestoredDatabase } from "./storage/restore-check.js";

/**
 * Operator CLI: read-only check of a restored database.
 * Usage: DATABASE_URL=... node dist/restore-check.js [--as-role <role>]
 */
async function main(): Promise<number> {
  // Never fall back to the development key: that would hide a missing key.
  if (!process.env.ENCRYPTION_KEY && !process.env.ENCRYPTION_KEYS) {
    console.error("restore-check: ENCRYPTION_KEY or ENCRYPTION_KEYS must be set; the decryption check cannot run without the real key.");
    return 1;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("restore-check: DATABASE_URL must be set.");
    return 1;
  }
  const roleFlag = process.argv.indexOf("--as-role");
  const asRole = roleFlag >= 0 ? process.argv[roleFlag + 1] : undefined;
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const report = await checkRestoredDatabase(pool, { asRole });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) console.error(`restore-check: FAILED: ${report.failures.join(", ")}`);
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`restore-check: error: ${error instanceof Error ? error.name : "unknown"}`);
    return 1;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
