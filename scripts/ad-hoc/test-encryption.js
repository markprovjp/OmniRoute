import path from "path";
import fs from "fs";

// Manually parse .env
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("=");
    const key = parts[0].trim();
    const val = parts
      .slice(1)
      .join("=")
      .trim()
      .replace(/^['"]|['"]$/g, "");
    process.env[key] = val;
  }
}

// Check other candidates like ~/.omniroute/.env
import os from "os";
const homeEnvPath = path.join(os.homedir(), ".omniroute", ".env");
if (fs.existsSync(homeEnvPath)) {
  const envContent = fs.readFileSync(homeEnvPath, "utf8");
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("=");
    const key = parts[0].trim();
    const val = parts
      .slice(1)
      .join("=")
      .trim()
      .replace(/^['"]|['"]$/g, "");
    process.env[key] = val;
  }
}

import { encrypt, decrypt, isEncryptionEnabled } from "../../src/lib/db/encryption.js";

console.log(
  "STORAGE_ENCRYPTION_KEY:",
  process.env.STORAGE_ENCRYPTION_KEY
    ? "EXISTS (length " + process.env.STORAGE_ENCRYPTION_KEY.length + ")"
    : "NOT SET"
);
console.log("isEncryptionEnabled():", isEncryptionEnabled());

const plain = "sk-ce9bb41f943590e4-koe4a1-1837ae56";
const enc = encrypt(plain);
console.log("Encrypted:", enc);
console.log("Decrypted:", decrypt(enc));

// Decrypt the database values
import Database from "better-sqlite3";

const dbPath = path.join(os.homedir(), ".omniroute", "storage.sqlite");
const db = new Database(dbPath);
const row = db
  .prepare("SELECT api_key FROM provider_connections WHERE api_key IS NOT NULL LIMIT 1")
  .get();
if (row) {
  console.log("Database encrypted key:", row.api_key);
  console.log("Decrypted db key:", decrypt(row.api_key));
}
db.close();
