import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../server.mjs";
import { createProvider } from "../composio.mjs";
const items = [
  {
    slug: "GMAIL_FETCH_EMAILS",
    name: "Fetch emails",
    toolkit: { slug: "gmail" },
  },
  { slug: "GMAIL_SEND_EMAIL", name: "Send email", toolkit: { slug: "gmail" } },
  {
    slug: "GITHUB_DELETE_REPO",
    name: "Delete repository",
    toolkit: { slug: "github" },
  },
];
test("member MCP authenticates, lists only session creation, and returns a usable session", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const m = await f.member();
  const rpc = (method, params) =>
    f.req("/mcp", "POST", { jsonrpc: "2.0", id: 1, method, params }, m.token);
  const init = await rpc("initialize", { protocolVersion: "2025-03-26" });
  assert.equal(init.data.result.protocolVersion, "2025-03-26");
  assert.deepEqual(init.data.result.capabilities, { tools: {} });
  const list = await rpc("tools/list");
  assert.deepEqual(
    list.data.result.tools.map((t) => t.name),
    ["GATEWAY_CREATE_SESSION"],
  );
  const created = await rpc("tools/call", {
    name: "GATEWAY_CREATE_SESSION",
    arguments: {},
  });
  const session = created.data.result.structuredContent;
  assert.deepEqual(JSON.parse(created.data.result.content[0].text), session);
  assert.equal(session.mcp.url, "https://gateway.test/mcp");
  assert.equal(session.mode, "connected");
  assert.equal(JSON.stringify(created).includes("secret-project-key"), false);
  assert.equal(f.calls.create.at(-1).userId, "alice");
  assert.equal(f.calls.forward.length, 0);
  assert.equal(
    (
      await f.req(
        "/mcp",
        "POST",
        { jsonrpc: "2.0", id: 2, method: "ping" },
        session.token,
      )
    ).status,
    200,
  );
  assert.equal(f.calls.forward.length, 1);
});

test("member MCP rejects execution, identity overrides, invalid credentials and revoked members", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const m = await f.member();
  for (const params of [
    { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: {} },
    { name: "GATEWAY_CREATE_SESSION", arguments: { userId: "another-user" } },
    { name: "GATEWAY_CREATE_SESSION", arguments: [] },
  ]) {
    const r = await f.req(
      "/mcp",
      "POST",
      { jsonrpc: "2.0", id: 1, method: "tools/call", params },
      m.token,
    );
    assert.equal(r.data.error.code, -32602);
  }
  for (const credential of ["invalid-token", "admin-test"]) {
    assert.equal(
      (
        await f.req(
          "/mcp",
          "POST",
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          credential,
        )
      ).status,
      401,
    );
  }
  await f.req(`/api/admin/members/${m.id}/revoke`, "POST");
  assert.equal(
    (
      await f.req(
        "/mcp",
        "POST",
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        m.token,
      )
    ).status,
    401,
  );
  assert.equal(f.calls.create.length, 0);
  assert.equal(f.calls.forward.length, 0);
});

test("member MCP honors tool policy, onboarding, notifications and session limits", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const m = await f.member();
  const b = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "GATEWAY_CREATE_SESSION", arguments: {} },
  };
  const notification = await fetch(f.url + "/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${m.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...b, id: undefined }),
  });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
  assert.equal(f.calls.create.length, 0);
  await f.req("/api/admin/policy", "PUT", {
    disabled: items.map((t) => t.slug),
  });
  const denied = await f.req("/mcp", "POST", b, m.token);
  assert.equal(denied.data.result.isError, true);
  assert.match(denied.data.result.content[0].text, /No enabled tools/);
  f.provider.connectedToolkits = async () => [];
  for (let i = 0; i < 10; i++) {
    const r = await f.req("/mcp", "POST", b, m.token);
    assert.equal(r.data.result.structuredContent.mode, "onboarding");
  }
  const limited = await f.req("/mcp", "POST", b, m.token);
  assert.equal(limited.data.result.isError, true);
  assert.match(limited.data.result.content[0].text, /Maximum 10/);
});

export async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "gateway-test-"));
  let clock = Date.now();
  const calls = { create: [], forward: [], remove: [] };
  const provider = {
    async connectedToolkits() {
      return ["gmail", "github"];
    },
    async page(k, c, toolkit) {
      if (k === "invalid") throw Error("Invalid API key");
      const scoped = items.filter((t) => t.toolkit.slug === toolkit);
      return c
        ? { items: scoped.slice(1) }
        : {
            items: scoped.slice(0, 1),
            ...(scoped.length > 1 ? { next_cursor: "page2" } : {}),
          };
    },
    async create(k, userId, config) {
      calls.create.push({ k, userId, config });
      return {
        id: "trs_test",
        url: "https://composio.dev/private-mcp",
        headers: { "x-api-key": k },
      };
    },
    async remove(k, id) {
      calls.remove.push({ k, id });
    },
    async forward(up, b) {
      calls.forward.push({ up, b });
      return Response.json(
        { jsonrpc: "2.0", id: b.id, result: { ok: true } },
        { headers: { "mcp-session-id": "upstream-session" } },
      );
    },
  };
  const app = createGateway({
    dataDir: dir,
    adminToken: "admin-test",
    provider,
    publicUrl: "https://gateway.test",
    now: () => clock,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  async function req(path, method = "GET", body, credential = "admin-test") {
    const res = await fetch(url + path, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  }
  async function setup() {
    await req("/api/admin/members", "POST", {
      name: "Catalog member",
      userId: "catalog-member",
    });
    assert.equal(
      (await req("/api/admin/config", "POST", { apiKey: "secret-project-key" }))
        .status,
      202,
    );
    await app.waitForScan();
    // Tests of executable sessions explicitly opt in to the fixture's tools.
    assert.equal(
      (await req("/api/admin/policy", "PUT", { disabled: [] })).status,
      200,
    );
  }
  async function member(user = "alice") {
    const response = await req("/api/admin/members", "POST", {
      name: user,
      userId: user,
    });
    await app.waitForScan();
    return response.data;
  }
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    app,
    req,
    setup,
    member,
    calls,
    provider,
    dir,
    url,
    advance: (n) => (clock += n),
  };
}
test("sessions restrict tools to each member's active services and fail closed", async (t) => {
  const f = await fixture(t);
  await f.setup();
  f.provider.connectedToolkits = async (key, user) =>
    user === "alice" ? ["gmail"] : ["github"];
  for (const [user, toolkit] of [
    ["alice", "gmail"],
    ["bob", "github"],
  ]) {
    const m = await f.member(user);
    const session = await f.req("/api/sessions", "POST", {}, m.token);
    assert.equal(session.status, 201);
    assert.deepEqual(f.calls.create.at(-1).config.toolkits, [toolkit]);
    const denied =
      user === "alice" ? "GITHUB_DELETE_REPO" : "GMAIL_FETCH_EMAILS";
    assert.equal(
      (
        await f.req(
          "/mcp",
          "POST",
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: denied },
          },
          session.data.token,
        )
      ).status,
      403,
    );
  }
  const m = await f.member("empty");
  f.provider.connectedToolkits = async () => [];
  const onboarding = await f.req("/api/sessions", "POST", {}, m.token);
  assert.equal(onboarding.status, 201);
  assert.equal(onboarding.data.mode, "onboarding");
  assert.deepEqual(f.calls.create.at(-1).config.preload, { tools: [] });
  for (const name of [
    "GMAIL_FETCH_EMAILS",
    "COMPOSIO_MULTI_EXECUTE_TOOL",
    "COMPOSIO_SEARCH_TOOLS",
    "COMPOSIO_GET_TOOL_SCHEMAS",
  ]) {
    assert.equal(
      (
        await f.req(
          "/mcp",
          "POST",
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name },
          },
          onboarding.data.token,
        )
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await f.req(
        "/mcp",
        "POST",
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "COMPOSIO_MANAGE_CONNECTIONS" },
        },
        onboarding.data.token,
      )
    ).status,
    200,
  );
  for (const sse of [false, true]) {
    f.provider.forward = async (up, body) => {
      const message = {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: "COMPOSIO_MANAGE_CONNECTIONS",
              inputSchema: { type: "object" },
            },
            { name: "COMPOSIO_MULTI_EXECUTE_TOOL" },
            { name: "GMAIL_FETCH_EMAILS" },
          ],
        },
      };
      return sse
        ? new Response(`data: ${JSON.stringify(message)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json(message);
    };
    const listed = await f.req(
      "/mcp",
      "POST",
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
      },
      onboarding.data.token,
    );
    assert.deepEqual(
      listed.data.result.tools.map((t) => t.name),
      ["COMPOSIO_MANAGE_CONNECTIONS"],
    );
  }
  f.provider.connectedToolkits = async () => ["gmail"];
  const connected = await f.req("/api/sessions", "POST", {}, m.token);
  assert.equal(connected.data.mode, "connected");
  assert.deepEqual(f.calls.create.at(-1).config.toolkits, ["gmail"]);
  f.provider.connectedToolkits = async () => {
    throw Error("unavailable");
  };
  assert.equal((await f.req("/api/sessions", "POST", {}, m.token)).status, 502);
});
test("catalog paginates, encrypts secrets and preserves working config on failed scan", async (t) => {
  const f = await fixture(t);
  await f.setup();
  assert.equal((await f.req("/api/admin/tools")).data.items.length, 3);
  assert.equal(
    JSON.stringify(f.app.store.get("apiKey")).includes("secret-project-key"),
    false,
  );
  assert.equal(
    JSON.stringify((await f.req("/api/admin/status")).data).includes(
      "secret-project-key",
    ),
    false,
  );
  await f.req("/api/admin/config", "POST", { apiKey: "invalid" });
  await f.app.waitForScan();
  assert.equal(
    (await f.req("/api/admin/status")).data.scan.error,
    "Invalid API key",
  );
  assert.equal((await f.req("/api/admin/tools")).data.items.length, 3);
});
test("admin and member credentials are isolated and never listed", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const m = await f.member();
  assert.equal(
    (await f.req("/api/admin/tools", "GET", null, m.token)).status,
    401,
  );
  assert.equal(
    (await f.req("/api/sessions", "POST", {}, "admin-test")).status,
    401,
  );
  assert.equal(
    (await f.req("/api/sessions", "POST", { user_id: "victim" }, m.token))
      .status,
    400,
  );
  assert.equal((await f.req("/api/sessions", "POST", {}, "bad")).status, 401);
  assert.equal(
    JSON.stringify((await f.req("/api/admin/members")).data).includes(m.token),
    false,
  );
  assert.equal(
    (await f.member()).error,
    "That Composio user ID already has a member.",
  );
});
test("issued credentials hide project key and bind allowlist to authenticated user", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const m = await f.member();
  await f.req("/api/admin/policy", "PUT", {
    disabled: ["GITHUB_DELETE_REPO", "GMAIL_SEND_EMAIL"],
  });
  const s = await f.req("/api/sessions", "POST", {}, m.token);
  assert.equal(s.status, 201);
  assert.equal(s.data.mcp.url, "https://gateway.test/mcp");
  assert.equal(JSON.stringify(s.data).includes("secret-project-key"), false);
  assert.equal(JSON.stringify(s.data).includes("private-mcp"), false);
  assert.equal(f.calls.create[0].userId, "alice");
  assert.deepEqual(f.calls.create[0].config.toolkits, ["gmail"]);
  assert.deepEqual(f.calls.create[0].config.tools.gmail.enable, [
    "GMAIL_FETCH_EMAILS",
  ]);
  assert.equal(f.calls.create[0].config.sandbox.enable, false);
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
  assert.equal((await f.req("/mcp", "POST", init, s.data.token)).status, 200);
  assert.equal(
    f.calls.forward[0].up.headers["x-api-key"],
    "secret-project-key",
  );
  const call = (name) => ({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: {} },
  });
  assert.equal(
    (await f.req("/mcp", "POST", call("GITHUB_DELETE_REPO"), s.data.token))
      .status,
    403,
  );
  assert.equal(
    (
      await f.req(
        "/mcp",
        "POST",
        call("COMPOSIO_REMOTE_WORKBENCH"),
        s.data.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.req("/mcp", "POST", call("GMAIL_FETCH_EMAILS"), s.data.token))
      .status,
    200,
  );
  assert.equal(f.calls.forward[1].up.transportId, "upstream-session");
  const batch = call("COMPOSIO_MULTI_EXECUTE_TOOL");
  batch.params.arguments = {
    tools: [{ tool_slug: "GITHUB_DELETE_REPO", arguments: {} }],
  };
  assert.equal((await f.req("/mcp", "POST", batch, s.data.token)).status, 403);
  batch.params.arguments.tools[0].tool_slug = "GMAIL_FETCH_EMAILS";
  assert.equal((await f.req("/mcp", "POST", batch, s.data.token)).status, 200);
});
test("policy saves, member revocation, credential rotation and expiry invalidate sessions", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const m = await f.member();
  const issue = async (token) =>
    (await f.req("/api/sessions", "POST", {}, token)).data.token;
  const ping = (token) =>
    f.req("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "ping" }, token);
  let s = await issue(m.token);
  await f.req("/api/admin/policy", "PUT", { disabled: ["GMAIL_SEND_EMAIL"] });
  assert.equal((await ping(s)).status, 401);
  s = await issue(m.token);
  f.advance(3600001);
  assert.equal((await ping(s)).status, 401);
  s = await issue(m.token);
  const rotated = await f.req(`/api/admin/members/${m.id}/rotate`, "POST");
  assert.equal((await ping(s)).status, 401);
  assert.equal((await f.req("/api/sessions", "POST", {}, m.token)).status, 401);
  s = await issue(rotated.data.token);
  assert.equal((await ping(s)).status, 200);
  await f.req(`/api/admin/members/${m.id}/revoke`, "POST");
  assert.equal((await ping(s)).status, 401);
});
test("empty policy fails closed and unknown slugs are rejected", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const m = await f.member();
  assert.equal(
    (await f.req("/api/admin/policy", "PUT", { disabled: ["TYPO"] })).status,
    400,
  );
  await f.req("/api/admin/policy", "PUT", {
    disabled: items.map((i) => i.slug),
  });
  assert.equal((await f.req("/api/sessions", "POST", {}, m.token)).status, 409);
  assert.equal(f.calls.create.length, 0);
});
test("policy mutation waits for issuance and then invalidates that session", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const m = await f.member();
  let release, started;
  const entered = new Promise((r) => (started = r));
  const original = f.provider.create;
  f.provider.create = async (...args) => {
    started();
    await new Promise((r) => (release = r));
    return original(...args);
  };
  const issuing = f.req("/api/sessions", "POST", {}, m.token);
  await entered;
  const saving = f.req("/api/admin/policy", "PUT", {
    disabled: ["GMAIL_SEND_EMAIL"],
  });
  release();
  const s = await issuing;
  await saving;
  assert.equal(
    (
      await f.req(
        "/mcp",
        "POST",
        { jsonrpc: "2.0", id: 1, method: "ping" },
        s.data.token,
      )
    ).status,
    401,
  );
});
test("invalidating during an upstream request aborts it and never returns its result", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const m = await f.member();
  const s = (await f.req("/api/sessions", "POST", {}, m.token)).data;
  let started;
  const entered = new Promise((r) => (started = r));
  f.provider.forward = async (up, b, p, signal) => {
    started();
    await new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(Error("Aborted")), {
        once: true,
      }),
    );
  };
  const pending = f.req(
    "/mcp",
    "POST",
    { jsonrpc: "2.0", id: 1, method: "ping" },
    s.token,
  );
  await entered;
  await f.req("/api/admin/policy", "PUT", { disabled: [] });
  assert.equal((await pending).status, 502);
});
test("session caps, deletion and upstream failures are handled without leaking credentials", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const m = await f.member();
  let s;
  for (let i = 0; i < 10; i++) {
    s = await f.req("/api/sessions", "POST", {}, m.token);
    assert.equal(s.status, 201);
  }
  assert.equal((await f.req("/api/sessions", "POST", {}, m.token)).status, 429);
  assert.equal(
    (await f.req("/mcp", "DELETE", undefined, s.data.token)).status,
    200,
  );
  f.provider.create = async () => {
    throw Error("secret-project-key");
  };
  const failed = await f.req("/api/sessions", "POST", {}, m.token);
  assert.equal(failed.status, 502);
  assert.equal(JSON.stringify(failed).includes("secret-project-key"), false);
});
test("catalog adapter uses v3.1 with pagination and a private key header", async () => {
  let seen;
  const p = createProvider({
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return Response.json({ items: [], next_cursor: "next" });
    },
  });
  await p.page("private-key", "cursor2", "github");
  assert.equal(seen.url.pathname, "/api/v3.1/tools");
  assert.equal(seen.url.searchParams.get("cursor"), "cursor2");
  assert.equal(seen.url.searchParams.get("toolkit_slug"), "github");
  assert.equal(seen.options.headers["x-api-key"], "private-key");
  assert.equal(seen.options.redirect, "error");
});
test("real SDK sends restricted session config and retains upstream key only inside provider", async (t) => {
  const http = await import("node:http");
  const { Composio } = await import("@composio/core");
  let wire, auth;
  const upstream = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    wire = JSON.parse(data);
    auth = req.headers["x-api-key"];
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        session_id: "trs_contract",
        mcp: { type: "http", url: "https://composio.dev/mcp/session" },
        config: {},
        tool_router_tools: [],
      }),
    );
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => upstream.close(r)));
  const p = createProvider({
    makeClient: (apiKey) =>
      new Composio({
        apiKey,
        allowTracking: false,
        baseURL: `http://127.0.0.1:${upstream.address().port}`,
      }),
  });
  const s = await p.create("project-key", "alice", {
    toolkits: ["gmail"],
    tools: { gmail: { enable: ["GMAIL_FETCH_EMAILS"] } },
    sandbox: { enable: false, enableProxyExecution: false },
    manageConnections: { enable: true },
  });
  assert.equal(wire.user_id, "alice");
  assert.deepEqual(wire.tools.gmail.enable, ["GMAIL_FETCH_EMAILS"]);
  assert.equal(wire.workbench.enable, false);
  assert.equal(wire.workbench.enable_proxy_execution, false);
  assert.equal(auth, "project-key");
  assert.equal(s.headers["x-api-key"], "project-key");
  assert.equal(s.id, "trs_contract");
});
test("encrypted connection, policy and credentials survive a server restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-restart-"));
  const provider = {
    async connectedToolkits() {
      return ["gmail", "github"];
    },
    async page() {
      return { items };
    },
    async remove() {},
    async create() {
      return {
        id: "restart",
        url: "https://composio.dev/mcp",
        headers: { "x-api-key": "persisted-secret" },
      };
    },
    async forward(up, b) {
      return Response.json({ jsonrpc: "2.0", id: b.id, result: { ok: true } });
    },
  };
  let app = createGateway({
    dataDir: dir,
    adminToken: "restart-admin",
    provider,
  });
  async function start() {
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${app.server.address().port}`;
  }
  let url = await start();
  const req = async (path, method, body, credential = "restart-admin") =>
    fetch(url + path, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const m = await (
    await req("/api/admin/members", "POST", { name: "Alice", userId: "alice" })
  ).json();
  await req("/api/admin/config", "POST", { apiKey: "persisted-secret" });
  await app.waitForScan();
  await req("/api/admin/policy", "PUT", { disabled: ["GITHUB_DELETE_REPO"] });
  const session = await (
    await req("/api/sessions", "POST", {}, m.token)
  ).json();
  await app.close();
  app = createGateway({ dataDir: dir, adminToken: "restart-admin", provider });
  url = await start();
  const status = await (await req("/api/admin/status", "GET")).json();
  assert.equal(status.configured, true);
  assert.deepEqual(status.disabled, ["GITHUB_DELETE_REPO"]);
  assert.equal(
    (
      await req(
        "/mcp",
        "POST",
        { jsonrpc: "2.0", id: 1, method: "ping" },
        session.token,
      )
    ).status,
    200,
  );
  assert.equal((await req("/api/sessions", "POST", {}, m.token)).status, 201);
  assert.equal(
    readFileSync(join(dir, "gateway.sqlite")).includes(
      Buffer.from("persisted-secret"),
    ),
    false,
  );
});
