import Database from "better-sqlite3";
import path from "path";
import os from "os";

const dbPath = path.join(os.homedir(), ".omniroute", "storage.sqlite");
console.log("Connecting to SQLite database at:", dbPath);

try {
  const db = new Database(dbPath, { fileMustExist: true });

  console.log("\n=== Checking System Key ===");
  const systemKey = db
    .prepare("SELECT * FROM api_keys WHERE key = ?")
    .get("qrouter_sk_Uerrq-5MN9GEQr0qWvuU4ziwfSvJzjbV");
  console.log("System key in DB:", systemKey);

  console.log("\n=== QRouter Connections ===");
  const qrouterConns = db
    .prepare("SELECT * FROM provider_connections WHERE provider LIKE '%openai-compatible%'")
    .all();
  console.log(qrouterConns);

  db.close();
} catch (error) {
  console.error("Failed to inspect:", error);
}
