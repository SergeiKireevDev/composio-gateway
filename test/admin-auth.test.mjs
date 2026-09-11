import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createGateway } from "../server.mjs";
import { createAdminAuthenticator } from "../admin-auth.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const hashPath = (dir) => join(dir, "admin.token.sha256");
const legacyPath = (dir) => join(dir, "admin.token");

function directory(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "gateway-admin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function start(t, dir, adminToken) {
  const app = createGateway({ dataDir: dir, adminToken });
  // Register immediately so an assertion or listen failure cannot leak handles.
  let closing;
  const close = () => (closing ??= app.close());
  t.after(close);
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${app.server.address().port}/api/admin/status`;
  return {
    close,
    request: async (token) => {
      const response = await fetch(url, {
        headers:
          token === undefined ? {} : { Authorization: `Bearer ${token}` },
      });
      await response.arrayBuffer();
      return response.status;
    },
  };
}

test("persists only a private hash; authenticates original token, not verifier", async (t) => {
  const dir = directory(t);
  const secret = "test-only-random-token-1234567890";
  const { request } = await start(t, dir, secret);
  assert.equal(fs.readFileSync(hashPath(dir), "utf8"), digest(secret) + "\n");
  assert.equal(fs.existsSync(legacyPath(dir)), false);
  assert.equal(fs.statSync(hashPath(dir)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(dir))
    assert.equal(
      fs.readFileSync(join(dir, file)).includes(Buffer.from(secret)),
      false,
    );
  assert.equal(await request(secret), 200);
  for (const invalid of [
    undefined,
    "",
    "wrong",
    digest(secret),
    "x".repeat(10000),
  ])
    assert.equal(await request(invalid), 401);
});

test("hash survives restart without environment input; new token rotates it", async (t) => {
  const dir = directory(t);
  const original = await start(t, dir, "original-admin");
  await original.close();
  const restored = await start(t, dir);
  assert.equal(await restored.request("original-admin"), 200);
  await restored.close();
  const rotated = await start(t, dir, "replacement-admin");
  assert.equal(await rotated.request("original-admin"), 401);
  assert.equal(await rotated.request("replacement-admin"), 200);
});

test("migrates old token without changing login; existing hash takes precedence", async (t) => {
  const dir = directory(t);
  fs.writeFileSync(legacyPath(dir), " legacy-admin\n");
  const { request } = await start(t, dir);
  assert.equal(await request("legacy-admin"), 200);
  assert.equal(fs.existsSync(legacyPath(dir)), false);
  fs.writeFileSync(legacyPath(dir), "stale-legacy");
  const verify = createAdminAuthenticator(dir);
  assert.ok(verify("legacy-admin"));
  assert.equal(verify("stale-legacy"), false);
  assert.equal(fs.existsSync(legacyPath(dir)), false);
});

test("environment overrides legacy value and corrupt hash", (t) => {
  const dir = directory(t);
  fs.writeFileSync(legacyPath(dir), "old");
  fs.writeFileSync(hashPath(dir), "corrupt");
  assert.ok(createAdminAuthenticator(dir, "new")("new"));
  assert.equal(fs.existsSync(legacyPath(dir)), false);
});

test("fresh install fails before creating SQLite or encryption material", (t) => {
  const dir = directory(t);
  assert.throws(() => createGateway({ dataDir: dir }), /Set ADMIN_TOKEN/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("unusable environment tokens fail without echoing them or changing saved credentials", (t) => {
  const dir = directory(t);
  createAdminAuthenticator(dir, "valid");
  for (const value of [
    "",
    "  ",
    null,
    7,
    " leading",
    "trailing ",
    "inside space",
    "tab\t",
    "newline\n",
    "cr\r",
    "nul\0",
    "unicode-é",
    "x".repeat(1025),
  ]) {
    assert.throws(
      () => createGateway({ dataDir: dir, adminToken: value }),
      /^Error: ADMIN_TOKEN must contain 1–1024 printable ASCII characters without whitespace\. Use a long random secret\.$/,
    );
    assert.equal(
      fs.readFileSync(hashPath(dir), "utf8").trim(),
      digest("valid"),
    );
  }
  assert.equal(fs.existsSync(join(dir, "gateway.sqlite")), false);
});

test("strictly validates stored hash; never falls back to legacy on corruption", (t) => {
  const dir = directory(t);
  for (const value of [
    "",
    "xyz",
    "a".repeat(63),
    "A".repeat(64),
    "a".repeat(65),
    "a".repeat(64) + "\n\n",
    " " + "a".repeat(64),
    "a".repeat(64) + " ",
    "a".repeat(64) + "\r",
  ]) {
    fs.writeFileSync(hashPath(dir), value);
    fs.writeFileSync(legacyPath(dir), "legacy");
    assert.throws(
      () => createAdminAuthenticator(dir),
      /Invalid admin.token.sha256/,
    );
    assert.ok(fs.existsSync(legacyPath(dir)));
  }
  for (const ending of ["", "\n", "\r\n"]) {
    fs.writeFileSync(hashPath(dir), digest("valid") + ending);
    assert.ok(createAdminAuthenticator(dir)("valid"));
  }
});

test("invalid legacy tokens are not deleted", (t) => {
  const dir = directory(t);
  for (const legacy of ["", " \n", "bad\0token", "two tokens"]) {
    fs.writeFileSync(legacyPath(dir), legacy);
    assert.throws(
      () => createAdminAuthenticator(dir),
      /Set ADMIN_TOKEN|Invalid legacy/,
    );
    assert.equal(fs.readFileSync(legacyPath(dir), "utf8"), legacy);
    assert.equal(fs.existsSync(hashPath(dir)), false);
  }
});

test("reuses stored hash without replacing inode or modification time; repairs permissions", (t) => {
  const dir = directory(t);
  createAdminAuthenticator(dir, "valid");
  fs.chmodSync(hashPath(dir), 0o644);
  fs.utimesSync(hashPath(dir), 1000000, 1000000);
  const before = fs.statSync(hashPath(dir));
  const rename = t.mock.method(fs, "renameSync", () =>
    assert.fail("Unexpected rewrite"),
  );
  assert.ok(createAdminAuthenticator(dir)("valid"));
  const after = fs.statSync(hashPath(dir));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.mode & 0o777, 0o600);
  assert.equal(rename.mock.callCount(), 0);
});

test("verifier rejects malformed candidates and preserves case sensitivity", (t) => {
  const verify = createAdminAuthenticator(
    directory(t),
    "Case-sensitive_token-123",
  );
  assert.ok(verify("Case-sensitive_token-123"));
  for (const candidate of [
    undefined,
    null,
    5,
    {},
    Buffer.from("Case-sensitive_token-123"),
    "case-sensitive_token-123",
    "Case-sensitive_token-123\n",
    "x".repeat(1025),
  ])
    assert.equal(verify(candidate), false);
});

test("flushes file and renamed directory entry before deleting legacy token", (t) => {
  const dir = directory(t);
  fs.writeFileSync(legacyPath(dir), "legacy");
  const events = [];
  const realSync = fs.fsyncSync;
  const realRename = fs.renameSync;
  const realUnlink = fs.unlinkSync;
  t.mock.method(fs, "fsyncSync", (fd) => {
    events.push(
      fs.fstatSync(fd).isDirectory() ? "sync-directory" : "sync-file",
    );
    return realSync(fd);
  });
  t.mock.method(fs, "renameSync", (...args) => {
    events.push("rename");
    return realRename(...args);
  });
  t.mock.method(fs, "unlinkSync", (path) => {
    if (path === legacyPath(dir)) events.push("delete-legacy");
    return realUnlink(path);
  });
  assert.ok(createAdminAuthenticator(dir)("legacy"));
  assert.deepEqual(events, [
    "sync-file",
    "rename",
    "sync-directory",
    "delete-legacy",
    "sync-directory",
  ]);
});

for (const failure of ["write", "file-sync", "rename", "directory-sync"]) {
  test(`${failure} failure preserves legacy credential and cleans temporary file`, (t) => {
    const dir = directory(t);
    fs.writeFileSync(legacyPath(dir), "legacy");
    const error = new Error(`Injected ${failure} failure`);
    if (failure === "write")
      t.mock.method(fs, "writeFileSync", () => {
        throw error;
      });
    if (failure === "rename")
      t.mock.method(fs, "renameSync", () => {
        throw error;
      });
    if (failure.endsWith("sync")) {
      const realSync = fs.fsyncSync;
      t.mock.method(fs, "fsyncSync", (fd) => {
        const directory = fs.fstatSync(fd).isDirectory();
        if (directory === (failure === "directory-sync")) throw error;
        return realSync(fd);
      });
    }
    assert.throws(
      () => createAdminAuthenticator(dir),
      (caught) => caught === error,
    );
    assert.equal(fs.readFileSync(legacyPath(dir), "utf8"), "legacy");
    assert.equal(
      fs.readdirSync(dir).some((path) => path.endsWith(".tmp")),
      false,
    );
    // A directory-sync failure occurs after rename. A retry must be safe.
    t.mock.restoreAll();
    assert.ok(createAdminAuthenticator(dir)("legacy"));
    assert.equal(fs.existsSync(legacyPath(dir)), false);
  });
}

test("failure after legacy deletion leaves a durable verifier for retry", (t) => {
  const dir = directory(t);
  fs.writeFileSync(legacyPath(dir), "legacy");
  const realSync = fs.fsyncSync;
  let directorySyncs = 0;
  t.mock.method(fs, "fsyncSync", (fd) => {
    if (fs.fstatSync(fd).isDirectory() && ++directorySyncs === 2)
      throw new Error("Post-deletion directory sync failed");
    return realSync(fd);
  });
  assert.throws(() => createAdminAuthenticator(dir), /Post-deletion/);
  assert.equal(fs.existsSync(legacyPath(dir)), false);
  assert.equal(fs.readFileSync(hashPath(dir), "utf8").trim(), digest("legacy"));
  t.mock.restoreAll();
  assert.ok(createAdminAuthenticator(dir)("legacy"));
});

test("failed rotation preserves previous hash", (t) => {
  const dir = directory(t);
  createAdminAuthenticator(dir, "original");
  t.mock.method(fs, "renameSync", () => {
    throw new Error("Injected rename failure");
  });
  assert.throws(
    () => createAdminAuthenticator(dir, "replacement"),
    /Injected rename/,
  );
  assert.equal(
    fs.readFileSync(hashPath(dir), "utf8").trim(),
    digest("original"),
  );
  assert.equal(
    fs.readdirSync(dir).some((path) => path.endsWith(".tmp")),
    false,
  );
});

test("cleanup errors preserve the original persistence failure", (t) => {
  const dir = directory(t);
  fs.writeFileSync(legacyPath(dir), "legacy");
  const original = new Error("Original rename failure");
  const cleanup = new Error("Cleanup unlink failure");
  t.mock.method(fs, "renameSync", () => {
    throw original;
  });
  t.mock.method(fs, "unlinkSync", () => {
    throw cleanup;
  });
  assert.throws(
    () => createAdminAuthenticator(dir),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [original, cleanup]);
      return true;
    },
  );
  assert.equal(fs.readFileSync(legacyPath(dir), "utf8"), "legacy");
});

test("directory descriptor cleanup cannot mask a synchronization error", (t) => {
  const dir = directory(t);
  fs.writeFileSync(legacyPath(dir), "legacy");
  const syncFailure = new Error("Directory synchronization failed");
  const closeFailure = new Error("Directory descriptor close failed");
  const realSync = fs.fsyncSync;
  const realClose = fs.closeSync;
  t.mock.method(fs, "fsyncSync", (fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw syncFailure;
    return realSync(fd);
  });
  t.mock.method(fs, "closeSync", (fd) => {
    const directory = fs.fstatSync(fd).isDirectory();
    realClose(fd);
    if (directory) throw closeFailure;
  });
  assert.throws(
    () => createAdminAuthenticator(dir),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [syncFailure, closeFailure]);
      return true;
    },
  );
  assert.equal(fs.readFileSync(legacyPath(dir), "utf8"), "legacy");
});

test("legacy unlink failure fails startup but leaves a recoverable hash", (t) => {
  const dir = directory(t);
  fs.writeFileSync(legacyPath(dir), "legacy");
  t.mock.method(fs, "unlinkSync", () => {
    throw new Error("Unlink denied");
  });
  assert.throws(() => createAdminAuthenticator(dir), /Unlink denied/);
  assert.equal(fs.readFileSync(hashPath(dir), "utf8").trim(), digest("legacy"));
  assert.ok(fs.existsSync(legacyPath(dir)));
  t.mock.restoreAll();
  assert.ok(createAdminAuthenticator(dir)("legacy"));
  assert.equal(fs.existsSync(legacyPath(dir)), false);
});

test("standalone startup removes ADMIN_TOKEN from process.env before listening", (t) => {
  const dir = directory(t);
  const preload = join(dir, "check-environment.mjs");
  fs.writeFileSync(
    preload,
    `import http from "node:http";
http.Server.prototype.listen = function () {
  if (Object.hasOwn(process.env, "ADMIN_TOKEN")) throw new Error("Environment was not cleared");
  console.log("Environment cleared before listen");
  process.exit(0);
};\n`,
  );
  const secret = "subprocess-test-token";
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      fileURLToPath(new URL("../server.mjs", import.meta.url)),
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        ADMIN_TOKEN: secret,
        DATA_DIR: join(dir, "data"),
        PUBLIC_URL: "",
        PORT: "0",
        HOST: "127.0.0.1",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Environment cleared before listen/);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
  assert.equal(
    fs.readFileSync(hashPath(join(dir, "data")), "utf8").trim(),
    digest(secret),
  );
});
