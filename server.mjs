import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore, token, hash } from "./store.mjs";
import { createAdminAuthenticator } from "./admin-auth.mjs";
import { createProvider } from "./composio.mjs";
const root = fileURLToPath(new URL(".", import.meta.url));
const fail = (status, message) => Object.assign(new Error(message), { status });
function textField(v, label, max = 200) {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw fail(400, `Invalid ${label}.`);
  return v.trim();
}
async function body(req) {
  let b = "",
    size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw fail(413, "Request too large.");
    b += chunk;
  }
  try {
    const v = JSON.parse(b || "{}");
    if (!v || Array.isArray(v) || typeof v !== "object") throw 0;
    return v;
  } catch {
    throw fail(400, "Expected a JSON object.");
  }
}
export function policyConfig(catalog, disabled) {
  const deny = new Set(disabled),
    tools = Object.create(null);
  for (const t of catalog)
    if (!deny.has(t.slug)) {
      tools[t.toolkit] ??= { enable: [] };
      tools[t.toolkit].enable.push(t.slug);
    }
  if (!Object.keys(tools).length)
    throw fail(409, "No enabled tools. Enable at least one tool first.");
  return {
    toolkits: Object.keys(tools),
    tools,
    sandbox: { enable: false, enableProxyExecution: false },
    manageConnections: { enable: true },
  };
}
export function createGateway({
  dataDir = join(root, "data"),
  adminToken,
  composioApiToken,
  provider = createProvider(),
  publicUrl,
  ttl = 3600,
  now = Date.now,
} = {}) {
  const environmentKey = composioApiToken !== undefined;
  if (
    environmentKey &&
    (typeof composioApiToken !== "string" ||
      !composioApiToken ||
      composioApiToken.length > 1000 ||
      /[^\x21-\x7e]/.test(composioApiToken))
  )
    throw new Error(
      "COMPOSIO_API_TOKEN must be a nonempty Composio project API key without whitespace (maximum 1000 characters).",
    );
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400)
    throw new Error("SESSION_TTL_SECONDS must be between 60 and 86400.");
  if (publicUrl) {
    const u = new URL(publicUrl);
    if (
      !["https:", "http:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/"
    )
      throw new Error(
        "PUBLIC_URL must be an HTTP(S) origin without a path, query or credentials.",
      );
  }
  let authenticateAdmin;
  try {
    authenticateAdmin = createAdminAuthenticator(dataDir, adminToken);
  } finally {
    adminToken = undefined;
  }
  // Validate credentials before opening SQLite or creating an encryption key.
  const store = openStore(dataDir),
    { db } = store;
  let scan = { running: false, count: 0, error: null },
    mutations = Promise.resolve(),
    scanTask = Promise.resolve(),
    refreshRequested = false;
  const active = new Map();
  let closed = false;
  const serialize = (fn) => {
    const p = mutations.then(fn);
    mutations = p.catch(() => {});
    return p;
  };
  const key = () => {
    const k = store.get("apiKey");
    if (!k) throw fail(409, "Configure a Composio API key first.");
    return store.unseal(k);
  };
  function cleanup(rows, apiKey) {
    for (const row of rows) {
      try {
        const up = store.unseal(row.upstream);
        Promise.resolve(provider.remove(apiKey, up.id)).catch(() => {});
      } catch {}
    }
  }
  function revoke(memberId) {
    const rows = memberId
      ? db.prepare("SELECT * FROM sessions WHERE member_id=?").all(memberId)
      : db.prepare("SELECT * FROM sessions").all();
    for (const r of rows) {
      for (const c of active.get(r.token_hash) || []) c.abort();
    }
    if (memberId)
      db.prepare("DELETE FROM sessions WHERE member_id=?").run(memberId);
    else {
      db.exec("DELETE FROM sessions");
      store.set("epoch", store.get("epoch", 0) + 1);
    }
    if (store.get("apiKey")) cleanup(rows, key());
  }
  function catalogMembers() {
    const connected = store.get("catalogConnections", {});
    return db
      .prepare(
        "SELECT id,name,user_id FROM members WHERE active=1 ORDER BY name",
      )
      .all()
      .map((m) => ({ ...m, toolkits: connected[m.id] || [] }));
  }
  function catalog() {
    // Never serve a legacy, unscoped cache while the first scoped scan runs.
    if (store.get("catalogScopeVersion") !== 1) return [];
    const kits = new Set(catalogMembers().flatMap((m) => m.toolkits));
    return store.get("catalog", []).filter((t) => kits.has(t.toolkit));
  }
  function refreshCatalog() {
    if (closed || !store.get("apiKey")) return;
    if (scan.running) refreshRequested = true;
    else startScan(key());
  }
  function startScan(apiKey) {
    if (scan.running) throw fail(409, "A catalog scan is already running.");
    scan = { running: true, count: 0, error: null };
    // Serialize scans with policy/member/session mutations so their scope
    // cannot change between connection discovery and committing the catalog.
    scanTask = serialize(async () => {
      const connections = {},
        kits = new Set(),
        all = new Map();
      for (const m of db
        .prepare("SELECT id,user_id FROM members WHERE active=1")
        .all()) {
        if (closed) return;
        connections[m.id] = [
          ...new Set(await provider.connectedToolkits(apiKey, m.user_id)),
        ].sort();
        for (const kit of connections[m.id]) kits.add(kit);
      }
      for (const kit of [...kits].sort()) {
        const seen = new Set();
        let cursor,
          count = 0;
        do {
          if (closed) return;
          const p = await provider.page(apiKey, cursor, kit);
          for (const t of p.items) {
            if (
              typeof t.slug !== "string" ||
              !t.slug ||
              typeof t.toolkit?.slug !== "string" ||
              !t.toolkit.slug
            )
              throw new Error(
                "Catalog contains a tool without a slug or toolkit.",
              );
            // Enforce the scope locally too, even if an upstream ignores its filter.
            if (t.toolkit.slug !== kit) continue;
            count++;
            all.set(t.slug, {
              slug: t.slug,
              toolkit: kit,
              name: t.name || t.slug,
              description: String(t.description || "").slice(0, 2000),
              tags: t.tags || [],
            });
          }
          scan.count = all.size;
          cursor = p.next_cursor;
          if (cursor && seen.has(cursor))
            throw new Error("Catalog pagination repeated a cursor.");
          seen.add(cursor);
        } while (cursor);
        if (!count)
          throw new Error(`Composio returned an empty catalog for ${kit}.`);
      }
      store.transaction(() => {
        if (closed) return;
        revoke();
        // Remember previously seen tools even while their apps are disconnected.
        // Seed from the saved catalog on upgrade to preserve existing permissions.
        const disabled = new Set(store.get("disabled", []));
        const known = new Set([
          ...store.get("knownToolSlugs", []),
          ...store.get("catalog", []).map((t) => t.slug),
          ...disabled,
        ]);
        for (const slug of all.keys()) {
          if (!known.has(slug)) disabled.add(slug);
          known.add(slug);
        }
        store.set("knownToolSlugs", [...known]);
        store.set("disabled", [...disabled]);
        store.set("apiKey", store.seal(apiKey));
        store.set("catalog", [...all.values()]);
        store.set("catalogConnections", connections);
        store.set("catalogScopeVersion", 1);
        // Keep disabled tools when an app disconnects, so reconnecting cannot
        // silently reset an administrator's saved restrictions.
        store.set("syncedAt", new Date(now()).toISOString());
      });
    })
      .catch((e) => {
        scan.error = e.message;
      })
      .finally(() => {
        scan.running = false;
        if (refreshRequested) {
          refreshRequested = false;
          refreshCatalog();
        }
      });
  }
  if (environmentKey) {
    try {
      // An environment key is authoritative. Never use a previous project's
      // catalog or sessions while the new key is being checked by a scan.
      if (!store.get("apiKey") || key() !== composioApiToken) {
        store.transaction(() => {
          revoke();
          store.set("apiKey", store.seal(composioApiToken));
          store.set("catalog", []);
          store.set("catalogConnections", {});
          store.set("catalogScopeVersion", 0);
          store.set("syncedAt", null);
        });
      }
    } catch (error) {
      db.close();
      throw error;
    } finally {
      composioApiToken = undefined;
    }
  }
  const send = (res, status, value) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const bearer = (req) => {
    const a = req.headers.authorization || "";
    return a.startsWith("Bearer ") ? a.slice(7) : "";
  };
  function member(req) {
    const m = db
      .prepare("SELECT * FROM members WHERE token_hash=? AND active=1")
      .get(hash(bearer(req)));
    if (!m) throw fail(401, "Invalid member credential.");
    return m;
  }
  function session(req) {
    const s = db
      .prepare(
        "SELECT s.* FROM sessions s JOIN members m ON m.id=s.member_id WHERE s.token_hash=? AND m.active=1",
      )
      .get(hash(bearer(req)));
    if (!s || s.expires <= now() || s.epoch !== store.get("epoch", 0))
      throw fail(401, "Session expired or revoked. Request a new session.");
    return s;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const path = new URL(req.url, "http://localhost").pathname,
        method = req.method;
      if (method === "GET" && ["/", "/app.js", "/style.css"].includes(path)) {
        const file = path === "/" ? "index.html" : path.slice(1);
        res.setHeader(
          "Content-Type",
          file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "text/html",
        );
        res.end(readFileSync(join(root, "public", file)));
        return;
      }
      if (method === "GET" && path === "/health") {
        send(res, 200, { ok: true });
        return;
      }
      if (path.startsWith("/api/admin/")) {
        if (!authenticateAdmin(bearer(req)))
          throw fail(401, "Invalid admin token.");
        if (method === "GET" && path === "/api/admin/status") {
          send(res, 200, {
            configured: !!store.get("apiKey"),
            keySource: environmentKey
              ? "environment"
              : store.get("apiKey")
                ? "stored"
                : null,
            scan,
            syncedAt: store.get("syncedAt"),
            total: catalog().length,
            disabled: store.get("disabled", []),
            epoch: store.get("epoch", 0),
            sessionTtl: ttl,
          });
          return;
        }
        if (method === "GET" && path === "/api/admin/tools") {
          send(res, 200, { items: catalog(), members: catalogMembers() });
          return;
        }
        if (method === "POST" && path === "/api/admin/config") {
          if (environmentKey)
            throw fail(
              409,
              "Composio is managed by COMPOSIO_API_TOKEN. Change the deployment variable and redeploy to replace it.",
            );
          const b = await body(req);
          startScan(textField(b.apiKey, "API key", 1000));
          send(res, 202, { scanning: true });
          return;
        }
        if (method === "POST" && path === "/api/admin/refresh") {
          startScan(key());
          send(res, 202, { scanning: true });
          return;
        }
        if (method === "PUT" && path === "/api/admin/policy") {
          const b = await body(req);
          await serialize(() =>
            store.transaction(() => {
              const known = new Set([
                ...catalog().map((t) => t.slug),
                ...store.get("disabled", []),
              ]);
              if (
                !Array.isArray(b.disabled) ||
                b.disabled.some((s) => typeof s !== "string" || !known.has(s))
              )
                throw fail(400, "Policy contains unknown tool slugs.");
              store.set("disabled", [...new Set(b.disabled)]);
              revoke();
            }),
          );
          send(res, 200, { saved: true });
          return;
        }
        if (method === "GET" && path === "/api/admin/members") {
          send(res, 200, {
            items: db
              .prepare(
                "SELECT id,name,user_id,active FROM members ORDER BY name",
              )
              .all(),
          });
          return;
        }
        if (method === "POST" && path === "/api/admin/members") {
          const b = await body(req),
            name = textField(b.name, "member name"),
            userId = textField(b.userId, "Composio user ID"),
            id = randomUUID(),
            credential = token();
          await serialize(() => {
            if (
              db.prepare("SELECT id FROM members WHERE user_id=?").get(userId)
            )
              throw fail(409, "That Composio user ID already has a member.");
            db.prepare(
              "INSERT INTO members(id,name,user_id,token_hash) VALUES(?,?,?,?)",
            ).run(id, name, userId, hash(credential));
            refreshCatalog();
          });
          send(res, 201, { id, name, userId, token: credential });
          return;
        }
        const match = path.match(
          /^\/api\/admin\/members\/([a-f0-9-]+)\/(revoke|rotate)$/,
        );
        if (method === "POST" && match) {
          const credential = token();
          await serialize(() => {
            const previous = db
              .prepare("SELECT active FROM members WHERE id=?")
              .get(match[1]);
            if (!previous) throw fail(404, "Member not found.");
            revoke(match[1]);
            db.prepare(
              "UPDATE members SET active=?,token_hash=? WHERE id=?",
            ).run(match[2] === "rotate" ? 1 : 0, hash(credential), match[1]);
            if (previous.active !== (match[2] === "rotate" ? 1 : 0))
              refreshCatalog();
          });
          send(
            res,
            200,
            match[2] === "rotate" ? { token: credential } : { revoked: true },
          );
          return;
        }
        throw fail(404, "Not found.");
      }
      async function createSession(b) {
        const m = member(req);
        if (Object.keys(b).length)
          throw fail(
            400,
            "Session options are controlled by the administrator. Send an empty object.",
          );
        const result = await serialize(async () => {
          if (
            !db
              .prepare(
                "SELECT id FROM members WHERE id=? AND active=1 AND token_hash=?",
              )
              .get(m.id, m.token_hash)
          )
            throw fail(401, "Member revoked.");
          const apiKey = key();
          let connected;
          try {
            connected = new Set(
              await provider.connectedToolkits(apiKey, m.user_id),
            );
          } catch {
            throw fail(
              502,
              "Could not load this member's connected services from Composio.",
            );
          }
          const knownKits = new Set(catalog().map((t) => t.toolkit));
          if ([...connected].some((kit) => !knownKits.has(kit))) {
            refreshCatalog();
            throw fail(
              409,
              "Connected apps changed. Catalog refresh started; retry after it completes.",
            );
          }
          const onboarding = !connected.size;
          // Do not restrict connection discovery to already-connected toolkits.
          // Execution is denied locally for onboarding sessions.
          const config = onboarding
            ? {
                tools: {},
                preload: { tools: [] },
                sandbox: { enable: false, enableProxyExecution: false },
                manageConnections: { enable: true },
              }
            : policyConfig(
                catalog().filter((t) => connected.has(t.toolkit)),
                store.get("disabled", []),
              );
          const current = db
            .prepare(
              "SELECT COUNT(*) AS n FROM sessions WHERE member_id=? AND expires>?",
            )
            .get(m.id, now());
          if (current.n >= 10)
            throw fail(
              429,
              "Maximum 10 active sessions per member. Delete an existing session first.",
            );
          let up;
          try {
            up = await provider.create(apiKey, m.user_id, config);
            up.allowedTools = Object.values(config.tools).flatMap(
              (t) => t.enable,
            );
            up.onboarding = onboarding;
          } catch {
            throw fail(
              502,
              "Composio session creation failed. Check the configured key and tool policy.",
            );
          }
          const credential = token(),
            expires = now() + ttl * 1000;
          db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
            hash(credential),
            m.id,
            store.get("epoch", 0),
            expires,
            store.seal(up),
          );
          return {
            token: credential,
            token_type: "Bearer",
            mode: onboarding ? "onboarding" : "connected",
            ...(onboarding
              ? {
                  next_step:
                    "Connect services using COMPOSIO_MANAGE_CONNECTIONS, then request a new session.",
                }
              : {}),
            expires_at: new Date(expires).toISOString(),
            mcp: {
              type: "http",
              url: publicUrl ? `${publicUrl.replace(/\/$/, "")}/mcp` : "/mcp",
              headers: { Authorization: `Bearer ${credential}` },
            },
          };
        });
        return result;
      }
      if (method === "POST" && path === "/api/sessions") {
        send(res, 201, await createSession(await body(req)));
        return;
      }
      if (path === "/mcp") {
        // Member credentials expose only the local session-creation tool.
        // They never authorize forwarding or execution of upstream tools.
        if (
          db
            .prepare("SELECT id FROM members WHERE active=1 AND token_hash=?")
            .get(hash(bearer(req)))
        ) {
          member(req);
          if (method !== "POST") {
            res.setHeader("Allow", "POST");
            throw fail(405, "Use POST for MCP requests.");
          }
          const b = await body(req);
          const reply = (result) =>
            send(res, 200, { jsonrpc: "2.0", id: b.id, result });
          const error = (code, message) =>
            send(res, 200, {
              jsonrpc: "2.0",
              id: b.id ?? null,
              error: { code, message },
            });
          if (
            b.jsonrpc !== "2.0" ||
            typeof b.method !== "string" ||
            (b.id !== undefined &&
              typeof b.id !== "string" &&
              typeof b.id !== "number")
          ) {
            error(-32600, "Invalid Request");
          } else if (b.id === undefined) {
            // Notifications never execute tools and require no JSON-RPC response.
            res.writeHead(202);
            res.end();
          } else if (b.method === "initialize") {
            const versions = ["2024-11-05", "2025-03-26", "2025-06-18"];
            reply({
              protocolVersion: versions.includes(b.params?.protocolVersion)
                ? b.params.protocolVersion
                : "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "composio-gateway", version: "0.1.0" },
              instructions:
                "Call GATEWAY_CREATE_SESSION, then connect using the returned MCP URL and session bearer token to access Composio tools.",
            });
          } else if (b.method === "ping") {
            reply({});
          } else if (b.method === "tools/list") {
            reply({
              tools: [
                {
                  name: "GATEWAY_CREATE_SESSION",
                  description:
                    "Create an expiring Composio MCP session for the authenticated member. Returns the MCP URL and secret session bearer token; keep it private. Permissions and identity are controlled by the administrator.",
                  inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                  },
                  annotations: {
                    readOnlyHint: false,
                    destructiveHint: false,
                    idempotentHint: false,
                    openWorldHint: true,
                  },
                },
              ],
            });
          } else if (b.method === "tools/call") {
            const args = b.params?.arguments ?? {};
            if (b.params?.name !== "GATEWAY_CREATE_SESSION") {
              error(-32602, "Unknown tool.");
            } else if (
              typeof args !== "object" ||
              Array.isArray(args) ||
              Object.keys(args).length
            ) {
              error(
                -32602,
                "Send empty tool arguments; identity and permissions are administrator-controlled.",
              );
            } else {
              try {
                const result = await createSession(args);
                reply({
                  content: [{ type: "text", text: JSON.stringify(result) }],
                  structuredContent: result,
                });
              } catch (e) {
                reply({
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: e.status ? e.message : "Session creation failed.",
                    },
                  ],
                });
              }
            }
          } else {
            error(-32601, "Method not found.");
          }
          return;
        }
        const s = session(req);
        if (method === "DELETE") {
          await serialize(() => {
            db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
              s.token_hash,
            );
            for (const c of active.get(s.token_hash) || []) c.abort();
            cleanup([s], key());
          });
          send(res, 200, { revoked: true });
          return;
        }
        if (method !== "POST") {
          res.setHeader("Allow", "POST, DELETE");
          throw fail(405, "Use POST for MCP requests.");
        }
        const b = await body(req);
        if (
          b.jsonrpc !== "2.0" ||
          ![
            "initialize",
            "ping",
            "tools/list",
            "tools/call",
            "notifications/initialized",
            "notifications/cancelled",
          ].includes(b.method)
        )
          throw fail(400, "Unsupported MCP method.");
        const upstream = store.unseal(s.upstream);
        const connectionTools = [
          "COMPOSIO_MANAGE_CONNECTIONS",
          "COMPOSIO_WAIT_FOR_CONNECTIONS",
        ];
        if (b.method === "tools/call") {
          const name = b.params?.name;
          if (upstream.onboarding && !connectionTools.includes(name))
            throw fail(
              403,
              "Onboarding sessions only allow connection management. Connect a service, then request a new session.",
            );
          const meta = [
            "COMPOSIO_SEARCH_TOOLS",
            "COMPOSIO_GET_TOOL_SCHEMAS",
            "COMPOSIO_MULTI_EXECUTE_TOOL",
            "COMPOSIO_MANAGE_CONNECTIONS",
            "COMPOSIO_WAIT_FOR_CONNECTIONS",
          ];
          const sessionTools = new Set(
            store.unseal(s.upstream).allowedTools || [],
          );
          const denied = new Set(store.get("disabled", []));
          const allowed = new Set(
            catalog()
              .filter((t) => !denied.has(t.slug) && sessionTools.has(t.slug))
              .map((t) => t.slug),
          );
          if (!meta.includes(name) && !allowed.has(name))
            throw fail(403, "Tool is disabled or unavailable.");
          if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
            const batch = b.params?.arguments?.tools;
            if (!Array.isArray(batch) || batch.length < 1 || batch.length > 50)
              throw fail(400, "Expected 1–50 tools.");
            if (batch.some((t) => !allowed.has(t?.tool_slug)))
              throw fail(403, "Batch contains a disabled or unavailable tool.");
          }
        }
        session(req);
        const c = new AbortController();
        active.set(
          s.token_hash,
          (active.get(s.token_hash) || new Set()).add(c),
        );
        const timer = setTimeout(
          () => c.abort(),
          Math.min(120000, Math.max(1, s.expires - now())),
        );
        res.on("close", () => c.abort());
        try {
          const up = upstream,
            version = req.headers["mcp-protocol-version"];
          const remote = await provider.forward(
            up,
            b,
            /^\d{4}-\d{2}-\d{2}$/.test(version || "") ? version : undefined,
            c.signal,
          );
          // A policy change or expiration while awaiting Composio must not leak a result.
          session(req);
          const transportId = remote.headers.get("mcp-session-id");
          if (transportId) {
            up.transportId = transportId;
            db.prepare("UPDATE sessions SET upstream=? WHERE token_hash=?").run(
              store.seal(up),
              s.token_hash,
            );
          }
          if (up.onboarding && b.method === "tools/list" && remote.ok) {
            const text = await remote.text();
            let message;
            if (
              (remote.headers.get("content-type") || "").includes(
                "text/event-stream",
              )
            ) {
              for (const event of text.split(/\r?\n\r?\n/)) {
                const data = event
                  .split(/\r?\n/)
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trimStart())
                  .join("\n");
                if (!data) continue;
                const value = JSON.parse(data);
                if (value.id === b.id) message = value;
              }
            } else message = JSON.parse(text);
            if (!Array.isArray(message?.result?.tools))
              throw fail(502, "Could not load connection-management tools.");
            session(req);
            send(res, 200, {
              jsonrpc: "2.0",
              id: b.id,
              result: {
                tools: message.result.tools.filter((tool) =>
                  connectionTools.includes(tool.name),
                ),
                ...(message.result.nextCursor
                  ? { nextCursor: message.result.nextCursor }
                  : {}),
              },
            });
            return;
          }
          res.writeHead(remote.status, {
            "Content-Type":
              remote.headers.get("content-type") || "application/json",
          });
          if (remote.body)
            for await (const chunk of remote.body) {
              session(req);
              if (!res.write(chunk))
                await new Promise((r) => {
                  const done = () => {
                    res.off("drain", done);
                    res.off("close", done);
                    r();
                  };
                  res.once("drain", done);
                  res.once("close", done);
                });
            }
          res.end();
        } catch (e) {
          if (res.headersSent) res.destroy();
          else throw e.status ? e : fail(502, "Composio MCP request failed.");
        } finally {
          clearTimeout(timer);
          active.get(s.token_hash)?.delete(c);
          if (!active.get(s.token_hash)?.size) active.delete(s.token_hash);
        }
        return;
      }
      throw fail(404, "Not found.");
    } catch (e) {
      if (!res.headersSent)
        send(res, e.status || 500, {
          error: e.status ? e.message : "Request failed.",
        });
      else res.destroy();
    }
  });
  const sweep = setInterval(() => {
    const rows = db
      .prepare("SELECT * FROM sessions WHERE expires<=?")
      .all(now());
    for (const r of rows)
      for (const c of active.get(r.token_hash) || []) c.abort();
    db.prepare("DELETE FROM sessions WHERE expires<=?").run(now());
    if (rows.length && store.get("apiKey")) cleanup(rows, key());
  }, 30000);
  sweep.unref();
  if (store.get("apiKey") && store.get("catalogScopeVersion") !== 1)
    refreshCatalog();
  return {
    server,
    store,
    waitForScan: async () => {
      while (scan.running) await scanTask;
    },
    async close() {
      closed = true;
      clearInterval(sweep);
      for (const set of active.values()) for (const c of set) c.abort();
      await scanTask;
      await mutations;
      await new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      });
      db.close();
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dataDir = resolve(process.env.DATA_DIR || join(root, "data"));
  const app = createGateway({
    dataDir,
    adminToken: process.env.ADMIN_TOKEN,
    composioApiToken: process.env.COMPOSIO_API_TOKEN,
    publicUrl: process.env.PUBLIC_URL,
    ttl: Number(process.env.SESSION_TTL_SECONDS || 3600),
  });
  // Best-effort removal from this process and subsequently spawned children.
  // This cannot erase Railway's variable store, OS snapshots, or old JS strings.
  delete process.env.ADMIN_TOKEN;
  delete process.env.COMPOSIO_API_TOKEN;
  const port = Number(process.env.PORT || 8788),
    host = process.env.HOST || "127.0.0.1";
  app.server.listen(port, host, () => {
    console.log(`Composio Gateway listening on http://${host}:${port}`);
    console.log(
      `Admin credential verifier: ${join(dataDir, "admin.token.sha256")} (log in with the original token)`,
    );
  });
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () => app.close().then(() => process.exit(0)));
}
