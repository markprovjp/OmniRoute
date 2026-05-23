import Database from "better-sqlite3";
import path from "path";
import os from "os";

const dbPath = path.join(os.homedir(), ".omniroute", "storage.sqlite");
console.log("Connecting to SQLite database at:", dbPath);

try {
  const db = new Database(dbPath, { fileMustExist: true });

  console.log("\n=== API KEYS ===");
  const keys = db
    .prepare("SELECT id, name, key, allowed_models, no_log, created_at FROM api_keys")
    .all();
  console.log(keys);

  console.log("\n=== PROVIDER CONNECTIONS ===");
  const connections = db
    .prepare("SELECT id, provider, name, is_active, api_key FROM provider_connections")
    .all();
  console.log(connections);

  db.close();
} catch (error) {
  console.error("Database query failed:", error);
}
