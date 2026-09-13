import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../server.mjs";

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "approvals-"));
  let clock = Date.now(),
    app;
  const calls = [],
    removed = [];
  const provider = {
    async connectedToolkits(key, user) {
      return user === "offline" ? [] : user === "bob" ? ["gmail"] : ["github"];
    },
    async page(key, cursor, toolkit) {
      return {
        items: ["READ", "WRITE"].map((name) => ({
          slug: `${toolkit.toUpperCase()}_${name}`,
          toolkit: { slug: toolkit },
        })),
      };
    },
    async create(key, user, config) {
      calls.push({ user, config });
      return {
        id: `up-${calls.length}`,
        url: "https://composio.dev/mcp",
        headers: {},
      };
    },
    async remove(key, id) {
      removed.push(id);
    },
    async forward(up, body) {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
    },
  };
  async function start() {
    app = createGateway({
      dataDir: dir,
      adminToken: "admin-test",
      provider,
      now: () => clock,
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    await app.waitForScan();
  }
  await start();
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
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
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: r.status, data: await r.json() };
  };
  await req("/api/admin/config", "POST", { apiKey: "project-secret" });
  await app.waitForScan();
  const member = async (user) => {
    const m = (
      await req("/api/admin/members", "POST", { name: user, userId: user })
    ).data;
    await app.waitForScan();
    return m;
  };
  const alice = await member("alice"),
    bob = await member("bob"),
    offline = await member("offline");
  return {
    req,
    alice,
    bob,
    offline,
    calls,
    removed,
    provider,
    get app() {
      return app;
    },
    advance(ms) {
      clock += ms;
    },
    async restart() {
      await app.close();
      await start();
    },
    submit: (tools = ["GITHUB_READ"], token = alice.token) =>
      req("/api/sessions", "POST", { tools, reason: "Review my PR" }, token),
    approve: (id) => req(`/api/admin/session-requests/${id}/approve`, "POST"),
    collect: (id, token = alice.token) =>
      req("/api/sessions", "POST", { request_id: id }, token),
    mcp: (name, args, token = alice.token) =>
      req(
        "/mcp",
        "POST",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        },
        token,
      ),
  };
}

test("REST requests remain pending until admin approval, then issue only the exact requested tools once", async (t) => {
  const f = await setup(t);
  const pending = await f.submit();
  assert.equal(pending.status, 202);
  const id = pending.data.request_id;
  assert.equal(pending.data.status, "pending");
  assert.equal(pending.data.token, undefined);
  assert.equal((await f.collect(id)).data.status, "pending");
  assert.equal(f.calls.length, 0);
  const listed = await f.req("/api/admin/session-requests");
  assert.equal(listed.data.items[0].member_name, "alice");
  assert.deepEqual(listed.data.items[0].tools, ["GITHUB_READ"]);
  for (const secret of [f.alice.token, "project-secret", "member_token_hash"])
    assert.equal(JSON.stringify(listed).includes(secret), false);
  assert.equal((await f.approve(id)).data.status, "approved");
  assert.equal(
    (
      await f.req(
        `/api/session-requests/${id}`,
        "GET",
        undefined,
        f.alice.token,
      )
    ).data.status,
    "approved",
  );
  const session = await f.collect(id);
  assert.equal(session.status, 201);
  assert.deepEqual(
    { ...f.calls[0].config.tools },
    {
      github: { enable: ["GITHUB_READ"] },
    },
  );
  assert.equal(f.calls[0].config.sandbox.enable, false);
  assert.equal(f.calls[0].user, "alice");
  assert.equal((await f.collect(id)).data.token, undefined);
  assert.equal(f.calls.length, 1);
  const allowed = await f.mcp("GITHUB_READ", {}, session.data.token);
  assert.equal(allowed.status, 200);
  assert.equal(
    (await f.mcp("GITHUB_WRITE", {}, session.data.token)).status,
    403,
  );
  assert.equal(
    (
      await f.mcp(
        "COMPOSIO_MULTI_EXECUTE_TOOL",
        { tools: [{ tool_slug: "GITHUB_WRITE" }] },
        session.data.token,
      )
    ).status,
    403,
  );
  const live = (await f.req("/api/admin/sessions")).data.items;
  assert.deepEqual(live[0].tools, ["GITHUB_READ"]);
  assert.equal(live[0].requestId, id);
});

test("MCP submit, status and collect support the same approval flow", async (t) => {
  const f = await setup(t);
  const response = await f.mcp("GATEWAY_CREATE_SESSION", {
    tools: ["GITHUB_READ"],
    reason: "Read only",
  });
  const pending = response.data.result.structuredContent;
  assert.equal(pending.status, "pending");
  assert.equal(
    (
      await f.mcp("GATEWAY_GET_SESSION_REQUEST", {
        request_id: pending.request_id,
      })
    ).data.result.structuredContent.status,
    "pending",
  );
  await f.approve(pending.request_id);
  const ready = (
    await f.mcp("GATEWAY_GET_SESSION_REQUEST", {
      request_id: pending.request_id,
    })
  ).data.result.structuredContent;
  assert.equal(ready.status, "approved");
  assert.equal(ready.token, undefined);
  const issued = (
    await f.mcp("GATEWAY_CREATE_SESSION", { request_id: pending.request_id })
  ).data.result.structuredContent;
  assert.ok(issued.token);
  assert.equal(
    (
      await f.mcp("GATEWAY_GET_SESSION_REQUEST", {
        request_id: pending.request_id,
      })
    ).data.result.structuredContent.status,
    "issued",
  );
});

test("members cannot self-approve, access another member's requests, or broaden an approval", async (t) => {
  const f = await setup(t);
  const id = (await f.submit()).data.request_id;
  assert.equal(
    (
      await f.req(
        `/api/admin/session-requests/${id}/approve`,
        "POST",
        {},
        f.alice.token,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.req(
        "/api/admin/session-requests",
        "GET",
        undefined,
        f.alice.token,
      )
    ).status,
    401,
  );
  assert.equal((await f.collect(id, f.bob.token)).status, 404);
  assert.equal(
    (await f.req(`/api/session-requests/${id}`, "GET", undefined, f.bob.token))
      .status,
    404,
  );
  await f.approve(id);
  for (const body of [
    { request_id: id, tools: ["GITHUB_WRITE"] },
    {},
    { tools: ["GITHUB_READ"], userId: "bob" },
    { tools: "GITHUB_READ" },
    { tools: ["UNKNOWN"] },
    { tools: ["GMAIL_READ"] },
    { tools: Array(101).fill("GITHUB_READ") },
  ])
    assert.equal(
      (await f.req("/api/sessions", "POST", body, f.alice.token)).status,
      400,
    );
  assert.equal(
    (await f.req("/api/admin/policy", "PUT", { disabled: [] })).status,
    410,
  );
  assert.equal(f.calls.length, 0);
});

test("rejection and request expiry never issue sessions; approvals persist across restart", async (t) => {
  const f = await setup(t);
  const rejected = (await f.submit()).data.request_id;
  await f.req(`/api/admin/session-requests/${rejected}/reject`, "POST");
  assert.equal((await f.collect(rejected)).data.status, "rejected");
  assert.equal((await f.approve(rejected)).status, 409);
  const id = (await f.submit()).data.request_id;
  await f.approve(id);
  await f.restart();
  assert.equal(
    (
      await f.req(
        `/api/session-requests/${id}`,
        "GET",
        undefined,
        f.alice.token,
      )
    ).data.status,
    "approved",
  );
  f.advance(86400001);
  assert.equal((await f.collect(id)).data.status, "expired");
  assert.equal(f.calls.length, 0);
});

test("catalog changes and member rotation invalidate outstanding approvals", async (t) => {
  const f = await setup(t);
  const id = (await f.submit()).data.request_id;
  await f.approve(id);
  await f.req("/api/admin/refresh", "POST");
  await f.app.waitForScan();
  assert.equal((await f.collect(id)).data.status, "expired");
  const rotated = (await f.submit()).data.request_id;
  await f.approve(rotated);
  const replacement = (
    await f.req(`/api/admin/members/${f.alice.id}/rotate`, "POST")
  ).data.token;
  assert.equal((await f.collect(rotated)).status, 401);
  assert.equal((await f.collect(rotated, replacement)).status, 404);
  assert.equal(f.calls.length, 0);
});

test("simultaneous redemption issues once; failed upstream creation leaves approval retryable", async (t) => {
  const f = await setup(t);
  const id = (await f.submit()).data.request_id;
  await f.approve(id);
  const create = f.provider.create;
  f.provider.create = async () => {
    throw Error("private-upstream-error");
  };
  const failed = await f.collect(id);
  assert.equal(failed.status, 502);
  assert.equal(
    JSON.stringify(failed).includes("private-upstream-error"),
    false,
  );
  f.provider.create = create;
  const both = await Promise.all([f.collect(id), f.collect(id)]);
  assert.equal(both.filter((r) => r.data.token).length, 1);
  assert.equal(f.calls.length, 1);
});

test("connection-only sessions also need approval and pending requests are bounded", async (t) => {
  const f = await setup(t);
  const pending = await f.submit([], f.offline.token);
  assert.equal(f.calls.length, 0);
  await f.approve(pending.data.request_id);
  const session = await f.collect(pending.data.request_id, f.offline.token);
  assert.equal(session.data.mode, "onboarding");
  assert.equal(
    (await f.mcp("GITHUB_READ", {}, session.data.token)).status,
    403,
  );
  for (let i = 0; i < 10; i++) assert.equal((await f.submit()).status, 202);
  assert.equal((await f.submit()).status, 429);
});

test("expiry during upstream creation cleans up without issuing a credential", async (t) => {
  const f = await setup(t);
  const id = (await f.submit()).data.request_id;
  await f.approve(id);
  const create = f.provider.create;
  f.provider.create = async (...args) => {
    const upstream = await create(...args);
    f.advance(86400001);
    return upstream;
  };
  const response = await f.collect(id);
  assert.equal(response.status, 409);
  assert.equal(response.data.token, undefined);
  assert.equal(
    f.app.store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n,
    0,
  );
  assert.deepEqual(f.removed, ["up-1"]);
});

test("competing review decisions are serialized and disconnected tools cannot be collected", async (t) => {
  const f = await setup(t);
  const id = (await f.submit()).data.request_id;
  const decisions = await Promise.all([
    f.approve(id),
    f.req(`/api/admin/session-requests/${id}/reject`, "POST"),
  ]);
  assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409]);
  const approved = (await f.submit()).data.request_id;
  await f.approve(approved);
  f.provider.connectedToolkits = async () => [];
  assert.equal((await f.collect(approved)).status, 400);
  assert.equal(f.calls.length, 0);
});

test("upgrading from the legacy policy revokes pre-approval execution sessions", async (t) => {
  const f = await setup(t);
  const id = (await f.submit()).data.request_id;
  await f.approve(id);
  const session = (await f.collect(id)).data;
  f.app.store.set("sessionApprovalVersion", 0);
  await f.restart();
  assert.equal((await f.mcp("GITHUB_READ", {}, session.token)).status, 401);
});
