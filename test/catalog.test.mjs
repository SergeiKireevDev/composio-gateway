import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../server.mjs";
import { createProvider } from "../composio.mjs";
import { issueSession } from "../test-support/issue-session.mjs";

const tool = (kit, name = "READ") => ({
  slug: `${kit.toUpperCase()}_${name}`,
  toolkit: { slug: kit },
});
async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "scoped-catalog-"));
  const connections = new Map(),
    pages = [],
    users = [],
    created = [];
  const provider = {
    async connectedToolkits(key, user) {
      users.push(user);
      return connections.get(user) || [];
    },
    async page(key, cursor, kit) {
      pages.push({ key, cursor, kit });
      return { items: [tool(kit)] };
    },
    async create(key, user, config) {
      created.push({ user, config });
      return { id: "session", url: "https://composio.dev/mcp", headers: {} };
    },
    async remove() {},
  };
  let app = createGateway({ dataDir: dir, adminToken: "admin-test", provider });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
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
  const member = async (user) => {
    const r = await req("/api/admin/members", "POST", {
      name: user,
      userId: user,
    });
    await app.waitForScan();
    return r.data;
  };
  const refresh = async () => {
    assert.equal((await req("/api/admin/refresh", "POST")).status, 202);
    await app.waitForScan();
  };
  const configure = async () => {
    assert.equal(
      (await req("/api/admin/config", "POST", { apiKey: "key" })).status,
      202,
    );
    await app.waitForScan();
  };
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get app() {
      return app;
    },
    provider,
    connections,
    pages,
    users,
    created,
    req,
    member,
    refresh,
    configure,
    async restart() {
      await app.close();
      app = createGateway({ dataDir: dir, adminToken: "admin-test", provider });
      await new Promise((resolve) =>
        app.server.listen(0, "127.0.0.1", resolve),
      );
    },
  };
}

test("no members or connected apps means no catalog request, never a global fetch", async (t) => {
  const f = await setup(t);
  await f.configure();
  assert.deepEqual((await f.req("/api/admin/tools")).data, {
    items: [],
    members: [],
  });
  await f.member("unconnected");
  assert.equal(f.pages.length, 0);
  assert.equal((await f.req("/api/admin/status")).data.configured, true);
  assert.equal((await f.req("/api/admin/status")).data.scan.error, null);
});

test("a single connected app requests only that app and filters stray upstream results", async (t) => {
  const f = await setup(t);
  f.connections.set("alice", ["github"]);
  const m = await f.member("alice");
  f.provider.page = async (key, cursor, kit) => {
    f.pages.push({ kit });
    return { items: [tool("github"), tool("gmail"), tool("slack")] };
  };
  await f.configure();
  assert.deepEqual(f.pages, [{ kit: "github" }]);
  const view = (await f.req("/api/admin/tools")).data;
  assert.deepEqual(
    view.items.map((t) => t.slug),
    ["GITHUB_READ"],
  );
  assert.deepEqual(view.members, [
    { id: m.id, name: "alice", user_id: "alice", toolkits: ["github"] },
  ]);
});

test("union of active members is deduplicated and pagination is independent per app", async (t) => {
  const f = await setup(t);
  f.connections.set("alice", ["github", "github"]);
  f.connections.set("bob", ["github", "gmail"]);
  f.connections.set("revoked", ["slack"]);
  await f.member("alice");
  const bob = await f.member("bob");
  const revoked = await f.member("revoked");
  await f.req(`/api/admin/members/${revoked.id}/revoke`, "POST");
  f.provider.page = async (key, cursor, kit) => {
    f.pages.push({ cursor, kit });
    return {
      items: [tool(kit, cursor ? "WRITE" : "READ")],
      ...(!cursor ? { next_cursor: "page2" } : {}),
    };
  };
  await f.configure();
  assert.deepEqual(f.pages, [
    { cursor: undefined, kit: "github" },
    { cursor: "page2", kit: "github" },
    { cursor: undefined, kit: "gmail" },
    { cursor: "page2", kit: "gmail" },
  ]);
  assert.ok(!f.users.includes("revoked"));
  assert.equal((await f.req("/api/admin/tools")).data.items.length, 4);
  f.pages.length = 0;
  await f.req(`/api/admin/members/${bob.id}/revoke`, "POST");
  await f.app.waitForScan();
  assert.ok(f.pages.every((p) => p.kit === "github"));
  assert.deepEqual(
    (await f.req("/api/admin/tools")).data.items.map((t) => t.toolkit),
    ["github", "github"],
  );
});

test("disconnect/reconnect preserves legacy disabled metadata but cannot grant permissions", async (t) => {
  const f = await setup(t);
  f.connections.set("alice", ["github"]);
  await f.member("alice");
  await f.configure();
  f.app.store.set("disabled", ["GITHUB_READ"]);
  f.connections.set("alice", []);
  await f.refresh();
  assert.equal((await f.req("/api/admin/tools")).data.items.length, 0);
  assert.deepEqual((await f.req("/api/admin/status")).data.disabled, [
    "GITHUB_READ",
  ]);
  assert.equal(
    (await f.req("/api/admin/policy", "PUT", { disabled: ["GITHUB_READ"] }))
      .status,
    410,
  );
  assert.equal(
    (await f.req("/api/admin/policy", "PUT", { disabled: ["UNKNOWN_TOOL"] }))
      .status,
    410,
  );
  f.connections.set("alice", ["github"]);
  await f.refresh();
  assert.deepEqual((await f.req("/api/admin/status")).data.disabled, [
    "GITHUB_READ",
  ]);
});

test("connection discovery and pagination failures preserve the last committed catalog", async (t) => {
  const f = await setup(t);
  f.connections.set("alice", ["github"]);
  await f.member("alice");
  await f.configure();
  const before = (await f.req("/api/admin/tools")).data;
  const discovery = f.provider.connectedToolkits;
  f.provider.connectedToolkits = async () => {
    throw Error("Connection lookup failed");
  };
  await f.refresh();
  assert.deepEqual((await f.req("/api/admin/tools")).data, before);
  assert.match(
    (await f.req("/api/admin/status")).data.scan.error,
    /Connection lookup failed/,
  );
  f.provider.connectedToolkits = discovery;
  f.provider.page = async () => ({
    items: [tool("github")],
    next_cursor: "repeated",
  });
  await f.refresh();
  assert.match(
    (await f.req("/api/admin/status")).data.scan.error,
    /repeated a cursor/,
  );
  assert.deepEqual((await f.req("/api/admin/tools")).data, before);
});

test("new connection triggers a scoped refresh before issuing an executable session", async (t) => {
  const f = await setup(t);
  await f.configure();
  const m = await f.member("alice");
  assert.equal(
    (await issueSession(f.req, m.token, [])).data.mode,
    "onboarding",
  );
  f.connections.set("alice", ["github"]);
  assert.equal(
    (await f.req("/api/sessions", "POST", { tools: ["GITHUB_READ"] }, m.token))
      .status,
    409,
  );
  await f.app.waitForScan();
  const pending = await f.req(
    "/api/sessions",
    "POST",
    { tools: ["GITHUB_READ"] },
    m.token,
  );
  assert.equal(pending.status, 202);
  assert.equal(pending.data.status, "pending");
  assert.equal(
    (await issueSession(f.req, m.token, ["GITHUB_READ"])).status,
    201,
  );
  assert.deepEqual(f.created.at(-1).config.toolkits, ["github"]);
  assert.ok(f.pages.every((p) => p.kit === "github"));
});

test("legacy global catalog is hidden on upgrade until a scoped refresh completes", async (t) => {
  const f = await setup(t);
  f.connections.set("alice", ["github"]);
  await f.member("alice");
  await f.configure();
  f.app.store.set("catalogScopeVersion", 0);
  f.app.store.set("catalog", [{ slug: "SLACK_READ", toolkit: "slack" }]);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.provider.page = async () => {
    await gate;
    return { items: [tool("github")] };
  };
  await f.restart();
  try {
    assert.equal((await f.req("/api/admin/tools")).data.items.length, 0);
  } finally {
    release();
  }
  await f.app.waitForScan();
  assert.deepEqual(
    (await f.req("/api/admin/tools")).data.items.map((t) => t.slug),
    ["GITHUB_READ"],
  );
});

test("member revocation queued during a scan triggers a new scope before settling", async (t) => {
  const f = await setup(t);
  f.connections.set("alice", ["github"]);
  const m = await f.member("alice");
  await f.configure();
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.provider.page = async () => {
    entered();
    await gate;
    return { items: [tool("github")] };
  };
  await f.req("/api/admin/refresh", "POST");
  await started;
  const revoked = f.req(`/api/admin/members/${m.id}/revoke`, "POST");
  release();
  assert.equal((await revoked).status, 200);
  await f.app.waitForScan();
  assert.deepEqual((await f.req("/api/admin/tools")).data, {
    items: [],
    members: [],
  });
  assert.equal(f.app.store.get("catalog").length, 0);
});

test("reactivating a revoked member refreshes their connected apps", async (t) => {
  const f = await setup(t);
  f.connections.set("alice", ["github"]);
  const m = await f.member("alice");
  await f.configure();
  await f.req(`/api/admin/members/${m.id}/revoke`, "POST");
  await f.app.waitForScan();
  assert.equal((await f.req("/api/admin/tools")).data.items.length, 0);
  await f.req(`/api/admin/members/${m.id}/rotate`, "POST");
  await f.app.waitForScan();
  assert.equal((await f.req("/api/admin/tools")).data.items.length, 1);
});

test("new tools default disabled while saved permissions survive refresh, disconnect and restart", async (t) => {
  const f = await setup(t);
  f.connections.set("alice", ["github"]);
  await f.member("alice");
  await f.configure();
  assert.deepEqual((await f.req("/api/admin/status")).data.disabled, [
    "GITHUB_READ",
  ]);
  f.app.store.set("disabled", []);
  f.provider.page = async () => ({
    items: [tool("github"), tool("github", "WRITE")],
  });
  await f.refresh();
  assert.deepEqual((await f.req("/api/admin/status")).data.disabled, [
    "GITHUB_WRITE",
  ]);
  await f.refresh();
  assert.deepEqual((await f.req("/api/admin/status")).data.disabled, [
    "GITHUB_WRITE",
  ]);
  f.connections.set("alice", []);
  await f.refresh();
  await f.restart();
  f.connections.set("alice", ["github"]);
  await f.refresh();
  assert.deepEqual((await f.req("/api/admin/status")).data.disabled, [
    "GITHUB_WRITE",
  ]);
});

test("upgrade preserves existing catalog policy and scan failure does not remember new tools", async (t) => {
  const f = await setup(t);
  f.connections.set("alice", ["github"]);
  await f.member("alice");
  await f.configure();
  // Simulate the pre-upgrade store with an enabled existing tool.
  f.app.store.set("knownToolSlugs", []);
  f.app.store.set("disabled", []);
  const oldKnown = f.app.store.get("knownToolSlugs");
  f.provider.page = async () => ({
    items: [tool("github", "WRITE")],
    next_cursor: "repeat",
  });
  await f.refresh();
  assert.deepEqual(f.app.store.get("knownToolSlugs"), oldKnown);
  assert.deepEqual((await f.req("/api/admin/status")).data.disabled, []);
  f.provider.page = async () => ({
    items: [tool("github"), tool("github", "WRITE")],
  });
  await f.refresh();
  assert.deepEqual((await f.req("/api/admin/status")).data.disabled, [
    "GITHUB_WRITE",
  ]);
});

test("catalog adapter rejects missing or multi-app scopes before making any request", async () => {
  let calls = 0;
  const provider = createProvider({
    fetchImpl: async () => {
      calls++;
      return Response.json({ items: [] });
    },
  });
  for (const kit of [undefined, "", "github,gmail", "github&limit=99999"])
    await assert.rejects(
      provider.page("key", undefined, kit),
      /single toolkit/,
    );
  assert.equal(calls, 0);
  await provider.page("key", undefined, "github");
  assert.equal(calls, 1);
});
