import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
export const token = () => randomBytes(32).toString("base64url");
export const hash = (s) => createHash("sha256").update(s).digest("hex");
export const matchesTokenHash = (candidate, expectedHash) =>
  timingSafeEqual(Buffer.from(hash(candidate), "hex"), expectedHash);

// ADMIN_TOKEN is a high-entropy bearer token, not a human-chosen password.
// Only its SHA-256 verifier is persisted. The plaintext hash is not accepted
// as a bearer credential (incoming credentials are always hashed again).
export function loadAdminTokenHash(dir, suppliedToken) {
  const path = join(dir, "admin.token.sha256");
  const legacyPath = join(dir, "admin.token");
  const readOptional = (p) => {
    try { return readFileSync(p, "utf8").trim(); }
    catch (e) { if (e.code === "ENOENT") return undefined; throw e; }
  };
  let digest;
  if (suppliedToken !== undefined) {
    if (typeof suppliedToken !== "string" || !suppliedToken.trim())
      throw new Error("ADMIN_TOKEN must not be empty.");
    digest = hash(suppliedToken);
    suppliedToken = undefined;
  } else {
    const saved = readOptional(path);
    if (saved !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(saved))
        throw new Error("Invalid admin.token.sha256. Set ADMIN_TOKEN to reset it.");
      digest = saved;
    } else {
      let legacy = readOptional(legacyPath);
      if (!legacy)
        throw new Error("Set ADMIN_TOKEN to a long random secret for the first startup.");
      digest = hash(legacy);
      legacy = undefined;
    }
  }
  // Atomic replacement: a failed write must not destroy the previous verifier
  // or delete the legacy credential before its replacement is persisted.
  const temporary = `${path}.${token()}.tmp`;
  try {
    writeFileSync(temporary, digest + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  try { unlinkSync(legacyPath); } catch (e) { if (e.code !== "ENOENT") throw e; }
  return Buffer.from(digest, "hex");
}
export function secretFile(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    const value = token();
    writeFileSync(path, value + "\n", { mode: 0o600, flag: "wx" });
    return value;
  }
}
export function openStore(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const key = Buffer.from(secretFile(join(dir, "encryption.key")), "base64url");
  const db = new DatabaseSync(join(dir, "gateway.sqlite"));
  chmodSync(join(dir, "gateway.sqlite"), 0o600);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, epoch INTEGER NOT NULL, expires INTEGER NOT NULL, upstream TEXT NOT NULL);`);
  return {
    db,
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    get(k, f = null) {
      const r = db.prepare("SELECT value FROM kv WHERE key=?").get(k);
      return r ? JSON.parse(r.value) : f;
    },
    set(k, v) {
      db.prepare("INSERT OR REPLACE INTO kv VALUES (?,?)").run(
        k,
        JSON.stringify(v),
      );
    },
    seal(value) {
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
    },
    unseal(value) {
      const b = Buffer.from(value, "base64"),
        d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(),
      );
    },
  };
}
