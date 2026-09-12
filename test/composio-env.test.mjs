import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createGateway } from "../server.mjs";

async function fixture(t, composioApiToken) {
  const dir = fs.mkdtempSync(join(tmpdir(), "composio-env-"));
  const calls = { pages: [], created: [], removed: [] };
  const provider = {
    async connectedToolkits() {
      return ["github"];
    },
    async page(key, cursor, toolkit) {
      calls.pages.push({ key, toolkit });
      return { items: [{ slug: "GITHUB_READ", toolkit: { slug: "github" } }] };
    },
    async create(key, user, config) {
      calls.created.push({ key, user, config });
      return {
        id: "session",
        url: "https://composio.dev/mcp",
        headers: { "x-api-key": key },
      };
    },
    async remove(key, id) {
      calls.removed.push({ key, id });
    },
    async forward(up, body) {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
    },
  };
  let app;
  const start = async (token) => {
    app = createGateway({
      dataDir: dir,
      adminToken: "admin-test",
      composioApiToken: token,
      provider,
    });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    await app.waitForScan();
  };
  await start(composioApiToken);
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const req = async (path, method = "GET", body, credential = "admin-test") => {
    const r = await fetch(
      `http://127.0.0.1:${app.server.address().port}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: r.status, data: await r.json() };
  };
  const member = async () => {
    const response = await req("/api/admin/members", "POST", {
      name: "Alice",
      userId: "alice",
    });
    await app.waitForScan();
    // Session lifecycle tests explicitly enable the discovered fixture tool.
    assert.equal(
      (await req("/api/admin/policy", "PUT", { disabled: [] })).status,
      200,
    );
    return response.data;
  };
  return {
    dir,
    provider,
    calls,
    req,
    member,
    get app() {
      return app;
    },
    async restart(token) {
      await app.close();
      await start(token);
    },
  };
}

test("environment key configures without UI input and never appears in responses or plaintext storage", async (t) => {
  const secret = "environment-project-key-test-only";
  const f = await fixture(t, secret);
  const status = await f.req("/api/admin/status");
  assert.equal(status.data.configured, true);
  assert.equal(status.data.keySource, "environment");
  assert.equal(status.data.scan.error, null);
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(
    f.calls.pages.length,
    0,
    "No members means no global catalog download",
  );
  const m = await f.member();
  assert.deepEqual(f.calls.pages, [{ key: secret, toolkit: "github" }]);
  const session = await f.req("/api/sessions", "POST", {}, m.token);
  assert.equal(session.status, 201);
  assert.equal(f.calls.created[0].key, secret);
  assert.equal(JSON.stringify(session).includes(secret), false);
  assert.equal(
    (await f.req("/api/admin/status", "GET", undefined, secret)).status,
    401,
  );
  assert.equal(f.app.store.unseal(f.app.store.get("apiKey")), secret);
  for (const file of fs.readdirSync(f.dir))
    assert.equal(
      fs.readFileSync(join(f.dir, file)).includes(Buffer.from(secret)),
      false,
    );
});

test("environment ownership blocks UI/API key replacement but allows catalog refresh", async (t) => {
  const f = await fixture(t, "environment-key");
  const response = await f.req("/api/admin/config", "POST", {
    apiKey: "replacement-key",
  });
  assert.equal(response.status, 409);
  assert.match(response.data.error, /managed by COMPOSIO_API_TOKEN/);
  assert.equal(
    f.app.store.unseal(f.app.store.get("apiKey")),
    "environment-key",
  );
  assert.equal((await f.req("/api/admin/refresh", "POST")).status, 202);
  await f.app.waitForScan();
});

test("unchanged environment key preserves scoped catalog and sessions across restart", async (t) => {
  const f = await fixture(t, "same-key");
  const m = await f.member();
  const session = await f.req("/api/sessions", "POST", {}, m.token);
  const before = (await f.req("/api/admin/status")).data;
  const count = f.calls.pages.length;
  await f.restart("same-key");
  assert.equal((await f.req("/api/admin/status")).data.epoch, before.epoch);
  assert.equal(f.calls.pages.length, count);
  assert.equal(
    (
      await f.req(
        "/mcp",
        "POST",
        { jsonrpc: "2.0", id: 1, method: "ping" },
        session.data.token,
      )
    ).status,
    200,
  );
});

test("environment key replaces the saved project and revokes sessions even if its scan fails", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.req("/api/admin/status")).data.keySource, null);
  await f.req("/api/admin/config", "POST", { apiKey: "old-project" });
  await f.app.waitForScan();
  const m = await f.member();
  const oldSession = await f.req("/api/sessions", "POST", {}, m.token);
  f.provider.connectedToolkits = async () => {
    throw Error("Composio unavailable");
  };
  await f.restart("new-project");
  const status = (await f.req("/api/admin/status")).data;
  assert.equal(status.keySource, "environment");
  assert.equal(status.total, 0);
  assert.match(status.scan.error, /Composio unavailable/);
  assert.equal(f.app.store.unseal(f.app.store.get("apiKey")), "new-project");
  assert.ok(f.calls.removed.some((r) => r.key === "old-project"));
  assert.equal(
    (
      await f.req(
        "/mcp",
        "POST",
        { jsonrpc: "2.0", id: 1, method: "ping" },
        oldSession.data.token,
      )
    ).status,
    401,
  );
  f.provider.connectedToolkits = async () => ["github"];
  await f.req("/api/admin/refresh", "POST");
  await f.app.waitForScan();
  const fresh = await f.req("/api/sessions", "POST", {}, m.token);
  assert.equal(fresh.status, 201);
  assert.equal(f.calls.created.at(-1).key, "new-project");
});

test("omitting the variable retains the encrypted key and restores UI configuration", async (t) => {
  const f = await fixture(t, "saved-key");
  await f.restart(undefined);
  assert.equal((await f.req("/api/admin/status")).data.keySource, "stored");
  assert.equal(f.app.store.unseal(f.app.store.get("apiKey")), "saved-key");
  assert.equal(
    (await f.req("/api/admin/config", "POST", { apiKey: "manual-key" })).status,
    202,
  );
  await f.app.waitForScan();
  assert.equal(f.app.store.unseal(f.app.store.get("apiKey")), "manual-key");
});

test("invalid environment key fails startup without creating files or exposing input", (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "invalid-composio-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const value of [
    "",
    " ",
    null,
    123,
    "secret\n",
    " secret",
    "secret\0",
    "non-ascii-é",
    "x".repeat(1001),
  ]) {
    assert.throws(
      () =>
        createGateway({
          dataDir: dir,
          adminToken: "admin",
          composioApiToken: value,
        }),
      {
        message:
          "COMPOSIO_API_TOKEN must be a nonempty Composio project API key without whitespace (maximum 1000 characters).",
      },
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  }
});

test("standalone server reads COMPOSIO_API_TOKEN and removes it from process.env before listening", (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "composio-env-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, "check.mjs");
  fs.writeFileSync(
    preload,
    `import http from "node:http";
import { openStore } from ${JSON.stringify(new URL("../store.mjs", import.meta.url).href)};
http.Server.prototype.listen = function () {
  if (Object.hasOwn(process.env, "COMPOSIO_API_TOKEN")) throw Error("Token still in environment");
  const store = openStore(process.env.DATA_DIR);
  if (store.unseal(store.get("apiKey")) !== "cli-project-key-test-only") throw Error("Key was not configured");
  store.db.close();
  console.log("Environment key configured and removed before listen");
  process.exit(0);
};`,
  );
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
        COMPOSIO_API_TOKEN: "cli-project-key-test-only",
        ADMIN_TOKEN: "cli-admin-test",
        DATA_DIR: join(dir, "data"),
        PUBLIC_URL: "",
        PORT: "0",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Environment key configured/);
  assert.equal(
    (result.stdout + result.stderr).includes("cli-project-key-test-only"),
    false,
  );
});
