import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";
import { createHash, createCipheriv, randomBytes, scryptSync } from "crypto";

// 1. Load STORAGE_ENCRYPTION_KEY from C:\Users\ADMIN\AppData\Roaming\omniroute\server.env
const serverEnvPath = "C:\\Users\\ADMIN\\AppData\\Roaming\\omniroute\\server.env";
console.log("Loading server env from:", serverEnvPath);
if (fs.existsSync(serverEnvPath)) {
  const content = fs.readFileSync(serverEnvPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
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

const encryptionKey = process.env.STORAGE_ENCRYPTION_KEY;
console.log("Loaded STORAGE_ENCRYPTION_KEY:", encryptionKey ? "EXISTS" : "NOT SET");

// 2. Encryption logic mirror
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;
const PREFIX = "enc:v1:";
const STATIC_SALT = "omniroute-field-encryption-v1";

function getStaticKey(): Buffer | null {
  if (!encryptionKey) return null;
  return scryptSync(encryptionKey, STATIC_SALT, KEY_LENGTH);
}

function encrypt(plaintext: string): string {
  const key = getStaticKey();
  if (!key) {
    console.warn("STORAGE_ENCRYPTION_KEY not set. Returning plaintext.");
    return plaintext;
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${PREFIX}${iv.toString("hex")}:${encrypted}:${authTag}`;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// 3. Connect to database
const dbPath = path.join(os.homedir(), ".omniroute", "storage.sqlite");
console.log("Connecting to database at:", dbPath);
const db = new Database(dbPath);

try {
  db.transaction(() => {
    // A. Delete all keys except system key
    console.log("Deleting keys...");
    const systemKey = "qrouter_sk_Uerrq-5MN9GEQr0qWvuU4ziwfSvJzjbV";
    db.prepare("DELETE FROM api_keys WHERE key != ?").run(systemKey);

    // B. Insert/Update the system key
    console.log("Setting up system key...");
    const keyHash = hashKey(systemKey);
    const keyPrefix = systemKey.slice(0, 24);
    const now = new Date().toISOString();

    const existing = db.prepare("SELECT id FROM api_keys WHERE key = ?").get(systemKey) as
      | { id: string }
      | undefined;
    if (existing) {
      db.prepare(
        `
        UPDATE api_keys
        SET name = ?, key_prefix = ?, key_hash = ?, scopes = ?, customer_name = ?, internal_note = ?, token_limit = ?, commercial_key = ?, is_active = ?, is_banned = ?
        WHERE key = ?
      `
      ).run(
        "System Routing Key",
        keyPrefix,
        keyHash,
        '["manage"]',
        "System",
        "System QRouter Gateway Key",
        null,
        1,
        1,
        0,
        systemKey
      );
      console.log("System key updated.");
    } else {
      const newId = "qrouter-system-key-uuid";
      db.prepare(
        `
        INSERT INTO api_keys (
          id, name, key, machine_id, allowed_models, no_log, created_at, key_prefix, key_hash, scopes, customer_name, internal_note, token_limit, token_used, commercial_key, expires_at, is_active, is_banned
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        newId,
        "System Routing Key",
        systemKey,
        "system-default",
        "[]",
        0,
        now,
        keyPrefix,
        keyHash,
        '["manage"]',
        "System",
        "System QRouter Gateway Key",
        null,
        0, // token_used
        1, // commercial_key
        null, // expires_at
        1, // is_active
        0 // is_banned
      );
      console.log("System key inserted.");
    }

    // C. Update QRouter commercial keys
    console.log("Updating QRouter keys...");
    const keysToUpdate = [
      { name: "Qrouter commercial key 01", key: "sk-ce9bb41f943590e4-koe4a1-1837ae56" },
      { name: "Qrouter commercial key 02", key: "sk-b85588aec3469950-s9zihi-9d1bc523" },
      { name: "Qrouter commercial key 03", key: "sk-ce9bb41f943590e4-am95w7-c094d094" },
      { name: "Qrouter commercial key 04", key: "sk-3f55230adf3f127c-nzoy45-fa5c1a17" },
      { name: "Qrouter commercial key 05", key: "sk-4a235cbc1cd5fe1f-6i8w92-4864f291" },
    ];

    for (const item of keysToUpdate) {
      const encryptedKey = encrypt(item.key);
      const res = db
        .prepare("UPDATE provider_connections SET api_key = ?, is_active = 1 WHERE name = ?")
        .run(encryptedKey, item.name);
      console.log(`Updated connection '${item.name}': changes = ${res.changes}`);
    }
  })();
  console.log("Database transaction completed successfully.");
} catch (error) {
  console.error("Database updates failed:", error);
} finally {
  db.close();
}
