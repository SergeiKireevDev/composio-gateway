import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
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
export const equal = (a, b) =>
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
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
