import { randomUUID } from "node:crypto";

const fail = (status, message) => Object.assign(new Error(message), { status });
const day = 86400000;
export function createSessionRequests(store, now) {
  const { db } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS session_requests (
    id TEXT PRIMARY KEY, member_id TEXT NOT NULL, member_token_hash TEXT NOT NULL,
    epoch INTEGER NOT NULL, tools TEXT NOT NULL, reason TEXT NOT NULL,
    status TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
    reviewed INTEGER
  ); CREATE INDEX IF NOT EXISTS requests_member ON session_requests(member_id);`);
  const prune = () =>
    db
      .prepare("DELETE FROM session_requests WHERE created<?")
      .run(now() - 7 * day);
  function view(row) {
    const member = db
      .prepare("SELECT active,token_hash FROM members WHERE id=?")
      .get(row.member_id);
    const valid =
      row.expires > now() &&
      row.epoch === store.get("epoch", 0) &&
      member?.active &&
      member.token_hash === row.member_token_hash;
    return {
      request_id: row.id,
      member_id: row.member_id,
      tools: JSON.parse(row.tools),
      reason: row.reason,
      status:
        ["pending", "approved"].includes(row.status) && !valid
          ? "expired"
          : row.status,
      created_at: new Date(row.created).toISOString(),
      expires_at: new Date(row.expires).toISOString(),
      reviewed_at:
        row.reviewed === null ? null : new Date(row.reviewed).toISOString(),
    };
  }
  function get(id, member) {
    if (typeof id !== "string") throw fail(400, "Expected a request_id.");
    const row = db.prepare("SELECT * FROM session_requests WHERE id=?").get(id);
    if (
      !row ||
      (member &&
        (row.member_id !== member.id ||
          row.member_token_hash !== member.token_hash))
    )
      throw fail(404, "Session request not found.");
    return view(row);
  }
  return {
    get,
    create(member, tools, reason) {
      prune();
      const open = db
        .prepare(
          "SELECT * FROM session_requests WHERE member_id=? AND status IN ('pending','approved')",
        )
        .all(member.id);
      if (
        open.filter((r) => ["pending", "approved"].includes(view(r).status))
          .length >= 10
      )
        throw fail(429, "Maximum 10 pending or approved requests per member.");
      const id = randomUUID(),
        created = now();
      db.prepare(
        "INSERT INTO session_requests VALUES(?,?,?,?,?,?,?,?,?,NULL)",
      ).run(
        id,
        member.id,
        member.token_hash,
        store.get("epoch", 0),
        JSON.stringify(tools),
        reason,
        "pending",
        created,
        created + day,
      );
      return get(id, member);
    },
    list() {
      prune();
      return db
        .prepare(
          `SELECT r.*, m.name, m.user_id FROM session_requests r
        JOIN members m ON m.id=r.member_id ORDER BY r.created DESC, r.id`,
        )
        .all()
        .map((r) => ({ ...view(r), member_name: r.name, user_id: r.user_id }));
    },
    review(id, decision) {
      if (!["approved", "rejected"].includes(decision))
        throw fail(400, "Invalid decision.");
      if (get(id).status !== "pending")
        throw fail(409, "Only pending, unexpired requests can be reviewed.");
      db.prepare(
        "UPDATE session_requests SET status=?,reviewed=? WHERE id=?",
      ).run(decision, now(), id);
      return get(id);
    },
    consume(id, member) {
      if (get(id, member).status !== "approved")
        throw fail(409, "Session request is not approved.");
      db.prepare("UPDATE session_requests SET status='issued' WHERE id=?").run(
        id,
      );
    },
  };
}

export const requestTools = [
  {
    name: "GATEWAY_CREATE_SESSION",
    description:
      "Submit tools and optional reason for admin approval. No execution is allowed while pending. After approval, call again with only request_id to collect one expiring session. Credentials are returned once. Use tools=[] to request a connection-management-only session.",
    inputSchema: {
      type: "object",
      properties: {
        tools: { type: "array", items: { type: "string" }, maxItems: 100 },
        reason: { type: "string", maxLength: 1000 },
        request_id: { type: "string" },
      },
      oneOf: [
        { required: ["tools"], not: { required: ["request_id"] } },
        {
          required: ["request_id"],
          not: { anyOf: [{ required: ["tools"] }, { required: ["reason"] }] },
        },
      ],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "GATEWAY_GET_SESSION_REQUEST",
    description:
      "Check your session request status: pending, approved, rejected, expired or issued. This never issues or returns credentials. After approval, collect with GATEWAY_CREATE_SESSION using request_id.",
    inputSchema: {
      type: "object",
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];
