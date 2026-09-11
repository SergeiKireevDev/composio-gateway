import fs from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const HASH_FILE = "admin.token.sha256";
const LEGACY_FILE = "admin.token";
const MAX_TOKEN_LENGTH = 1024;
const digest = (value) => createHash("sha256").update(value).digest();

// Random bearer tokens, not human passwords. Reject whitespace/control bytes
// rather than accepting a credential that HTTP header handling could alter.
function validToken(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH &&
    !/[^\x21-\x7e]/.test(value)
  );
}

function readOptional(path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function withReadDescriptor(path, operation) {
  const fd = fs.openSync(path, "r");
  let failure;
  try {
    return operation(fd);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (cleanupError) {
      if (failure)
        throw new AggregateError(
          [failure, cleanupError],
          "Admin credential operation and descriptor cleanup failed.",
        );
      throw cleanupError;
    }
  }
}

function syncDirectory(dir) {
  withReadDescriptor(dir, (fd) => fs.fsyncSync(fd));
}

function removeLegacy(path, dir) {
  try {
    fs.unlinkSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  syncDirectory(dir);
}

// A rename alone is atomic, but not durable across a crash. Flush both the
// contents and the renamed directory entry before removing the legacy token.
function persistHash(path, dir, value) {
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    created = true;
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${value.toString("hex")}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, path);
    syncDirectory(dir);
  } catch (error) {
    // Preserve the original failure even if cleanup also fails. A leftover
    // temporary file contains only a private hash, never the original token.
    const errors = [error];
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }
    if (created) {
      try {
        fs.unlinkSync(temporary);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") errors.push(cleanupError);
      }
    }
    if (errors.length > 1)
      throw new AggregateError(
        errors,
        "Admin hash persistence failed; cleanup also failed.",
      );
    throw error;
  }
}

function loadHash(dir, suppliedToken) {
  if (suppliedToken !== undefined && !validToken(suppliedToken))
    throw new Error(
      "ADMIN_TOKEN must contain 1–1024 printable ASCII characters without whitespace. Use a long random secret.",
    );

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const path = join(dir, HASH_FILE);
  const legacyPath = join(dir, LEGACY_FILE);
  let expected;

  if (suppliedToken !== undefined) {
    expected = digest(suppliedToken);
    persistHash(path, dir, expected);
  } else {
    const saved = readOptional(path);
    if (saved !== undefined) {
      // Deliberately allow only a single optional line ending, not arbitrary
      // leading/trailing whitespace or additional lines in the verifier file.
      const serialized = saved.replace(/\r?\n$/, "");
      if (serialized.length !== 64 || /[^a-f0-9]/.test(serialized))
        throw new Error(
          "Invalid admin.token.sha256. Set ADMIN_TOKEN to reset it.",
        );
      expected = Buffer.from(serialized, "hex");
      // Reuse the verifier without rewriting/replacing its inode. Sync it
      // before cleaning any legacy file left by an interrupted migration.
      withReadDescriptor(path, (fd) => {
        fs.fchmodSync(fd, 0o600);
        fs.fsyncSync(fd);
      });
      syncDirectory(dir);
    } else {
      // Preserve the trimming behavior of the old generated-token file.
      const legacy = readOptional(legacyPath)?.trim();
      if (!legacy)
        throw new Error(
          "Set ADMIN_TOKEN to a long random secret for the first startup.",
        );
      if (!validToken(legacy))
        throw new Error(
          "Invalid legacy admin.token. Set ADMIN_TOKEN to reset it.",
        );
      expected = digest(legacy);
      persistHash(path, dir, expected);
    }
  }
  removeLegacy(legacyPath, dir);
  return expected;
}

export function createAdminAuthenticator(dir, suppliedToken) {
  // Keep plaintext only in the short-lived initialization stack. The returned
  // closure captures a private digest, not the supplied token or a mutable
  // digest exposed to callers. JavaScript cannot guarantee memory zeroization.
  return verifierFor(loadHash(dir, suppliedToken));
}

function verifierFor(expected) {
  return (candidate) =>
    validToken(candidate) && timingSafeEqual(digest(candidate), expected);
}
