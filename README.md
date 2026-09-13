# Composio Gateway

A self-hosted admin interface and MCP gateway. Members discover tools, request an exact tool set, and receive a restricted session only after an administrator approves it.

## Run

Requires Node.js 22.19 or newer. On first startup, set `ADMIN_TOKEN` to a long random secret (at least 32 random bytes) in your environment or deployment secret manager. Keep the original in your password manager; only its SHA-256 hash is stored in `data/admin.token.sha256`.

```sh
npm ci
npm start
```

Open `http://127.0.0.1:8788` and enter the original admin token, not its hash. The browser holds it only in memory; reloading locks the interface. A legacy `data/admin.token` is automatically hashed and removed. Save the original before upgrading; it cannot be recovered from the hash. See [admin authentication](docs/admin-authentication.md).

1. Set **`COMPOSIO_API_TOKEN`** to your Composio project API key and redeploy, or enter it in **Connection**. The catalog contains only apps connected by active gateway members.
2. Under **Members & sessions**, create a member bound to their Composio user ID. Copy the member token; it is displayed once. Adding or reactivating members refreshes the catalog.
3. The member connects to `/mcp` using that token, searches the catalog, and submits the tools needed for one session.
4. Under **Tools & requests → Session requests**, review the member, reason, and exact tool list. Choose **Approve request** or **Reject request**. The list refreshes automatically, with a manual refresh button too.
5. The member checks request status and collects the approved session. Configure a separate MCP connection with its returned URL and bearer token.

The catalog is read-only: there are no global enable/disable toggles. Approval of one request does not authorize another request, another member, or additional tools.

## Upgrade from global tool permissions

**This is a breaking authentication-flow change.** On the first startup of this version, existing execution sessions are revoked. Members and Composio credentials are preserved, but old global enabled/disabled settings no longer authorize execution. `PUT /api/admin/policy` returns HTTP 410.

An empty `{}` session-creation payload no longer issues a session. Clients must submit `tools`, wait for approval, then collect using `request_id`. Existing session-token MCP transport and individual revocation remain supported for newly approved sessions.

## Discover tools and request a session through MCP

Configure an HTTP MCP connection:

- URL: `https://gateway.example.com/mcp`
- Header: `Authorization: Bearer <member-token>`

It exposes four tools:

| Tool | Arguments | Result |
| --- | --- | --- |
| `COMPOSIO_SEARCH_TOOLS` | `{"query":"repository","limit":20,"offset":0}` | Read-only catalog search; follow `next_offset` for more results |
| `COMPOSIO_GET_TOOL_SCHEMAS` | `{"tool_slugs":["GITHUB_GET_REPOSITORY_CONTENT"]}` | Input/output metadata for up to 20 tools |
| `GATEWAY_CREATE_SESSION` | `{"tools":["GITHUB_GET_REPOSITORY_CONTENT"],"reason":"Read files for a code review"}` | A pending request with `request_id`; no session token |
| `GATEWAY_GET_SESSION_REQUEST` | `{"request_id":"<request-id>"}` | Current status, requested tools, and expiry; never credentials |

After status becomes **`approved`**, call **`GATEWAY_CREATE_SESSION`** with only:

```json
{ "request_id": "<request-id>" }
```

This issues **one** session with the exact approved tools and returns its credentials **once**. Repeated calls report `issued` without returning credentials or creating another session. Store the successful result immediately. If the credentials are lost, submit a new request for approval.

Discovery requires no gateway or upstream execution session and does not grant permission to execute anything. Search is local keyword matching, not Composio semantic search; the member-endpoint schemas differ from upstream meta-tool schemas. Schema lookup uses Composio's read-only metadata API. Both are restricted to the member's currently connected apps and the last synced catalog. If a tool is missing, connect the app and have the admin **Sync catalog**.

Use `tools: []` to request a **connection-management-only** session for OAuth onboarding. This also requires approval. It cannot execute app tools. After connecting an app and syncing, search and request the actual tools you need.

## The same flow through REST

### 1. Submit a request

```sh
curl https://gateway.example.com/api/sessions \
  -H "Authorization: Bearer $GATEWAY_MEMBER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tools":["GITHUB_GET_REPOSITORY_CONTENT"],"reason":"Review repository files"}'
```

Returns HTTP **202** and a `pending` request, including `request_id`, `tools`, `reason`, `created_at`, and `expires_at`. No upstream execution session is created at this point.

### 2. Wait for admin review and check status

```sh
curl "https://gateway.example.com/api/session-requests/$REQUEST_ID" \
  -H "Authorization: Bearer $GATEWAY_MEMBER_TOKEN"
```

Statuses: `pending`, `approved`, `rejected`, `expired`, or `issued`. Members can inspect and collect only requests created with their own current credential. Checking status does not create a session. Poll at a reasonable interval, for example every five seconds.

### 3. Collect after approval

```sh
curl https://gateway.example.com/api/sessions \
  -H "Authorization: Bearer $GATEWAY_MEMBER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"request_id\":\"$REQUEST_ID\"}"
```

Returns HTTP **201** with the connection details:

```json
{
  "request_id": "<request-id>",
  "status": "issued",
  "tools": ["GITHUB_GET_REPOSITORY_CONTENT"],
  "token": "<gateway-session-token>",
  "token_type": "Bearer",
  "mode": "connected",
  "expires_at": "2026-09-12T22:00:00.000Z",
  "mcp": {
    "type": "http",
    "url": "https://gateway.example.com/mcp",
    "headers": { "Authorization": "Bearer <gateway-session-token>" }
  }
}
```

Collecting while pending returns HTTP 202 without credentials. Other non-approved states return their status without credentials. Tool lists, identity, and expiry cannot be overridden when collecting. Failed upstream creation leaves approval available to retry; simultaneous collections cannot issue multiple sessions.

Set `PUBLIC_URL` to return an absolute MCP URL; otherwise resolve `/mcp` against the gateway origin. Installing or renewing the client's execution connection is the client's responsibility.

### Limits and invalidation

- Request at most **100 tool slugs**, with an optional reason of up to **1000 characters**.
- Each member can have at most **10 pending/approved requests** and **10 unexpired sessions**.
- Requests must be approved and collected within **24 hours of submission**. Approval does not extend this deadline. Recent request records are retained for **7 days**, not as a permanent audit log.
- Session lifetime starts at issuance: one hour by default, configurable from 60 seconds to 24 hours using `SESSION_TTL_SECONDS`.
- A successful catalog refresh or project-key replacement revokes execution sessions and invalidates outstanding requests. Member revocation/rotation invalidates that member's sessions and outstanding requests. Stable-key restarts preserve valid requests and sessions.
- Requests are checked against the member's connected apps both at submission and collection. If a requested tool becomes unavailable, collection fails without executing anything; reconnect or submit a revised request as appropriate.
- Approving/rejecting one request does not revoke other sessions or change global permissions.

## Manage active sessions

**Members & sessions → Active sessions** lists currently valid sessions, their members, expiry times, approved tools, and non-secret identifiers. **Revoke session** ends one session without disabling the member or their other sessions. Tokens are never displayed. Expired and revoked sessions are excluded; this is not an audit history.

Member-level **Revoke** disables the member and all their sessions. **New credential** revokes existing sessions and replaces the member token. A session can also delete itself:

```sh
curl -X DELETE https://gateway.example.com/mcp \
  -H "Authorization: Bearer $GATEWAY_SESSION_TOKEN"
```

Revocation aborts in-flight gateway requests and attempts upstream cleanup. Local revocation remains effective if Composio is unavailable. An action already accepted by Composio cannot be undone by revoking its session.

## Railway and VPS configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8788` | HTTP port |
| `DATA_DIR` | Project `data/` | Persistent SQLite database and encryption key |
| `PUBLIC_URL` | Unset | Public HTTP(S) origin, without a path |
| `SESSION_TTL_SECONDS` | `3600` | Session lifetime, 60–86400 seconds |
| `ADMIN_TOKEN` | Unset | Required on fresh install; overrides persisted admin hash |
| `COMPOSIO_API_TOKEN` | Unset | Composio project API key; configures at startup and locks UI key edits |

For Railway, attach a persistent volume at `/app/data`, set `DATA_DIR=/app/data`, set the project key and admin token as separate secrets, and set `PUBLIC_URL` to the public HTTPS origin. Redeploy to apply variables.

An environment-managed key hides the UI key-entry form and prevents `/api/admin/config` replacements. Manual refresh remains available. A changed key replaces the encrypted saved key, clears the previous catalog, and scans connected apps; a failed scan never falls back to the old project. An unchanged key preserves the catalog and sessions on restart, except for the one-time approval-flow upgrade described above. Blank, whitespace-containing, non-ASCII, or over-1000-character keys fail startup.

Removing the variable restores UI editability but retains the encrypted saved key. Removing the environment entry from the Node process does not erase Railway's variable store or historical snapshots. Environment variables do not replace persistent storage or connect apps for a member; OAuth belongs to their Composio user ID.

`.env` is not loaded automatically. Use `node --env-file=.env server.mjs` if you copy `.env.example` to `.env`. On a VPS, use an HTTPS reverse proxy. The gateway does not trust forwarded Host headers to construct session URLs.

```sh
docker build -t composio-gateway .
docker run -d --name composio-gateway --restart unless-stopped \
  -p 127.0.0.1:8788:8788 \
  -e PUBLIC_URL=https://gateway.example.com \
  -e ADMIN_TOKEN -e COMPOSIO_API_TOKEN \
  -v composio-gateway-data:/app/data \
  composio-gateway
```

## Security and storage

The installed Composio SDK places the project key in upstream session headers. The gateway never returns that connection directly: it stores it encrypted and issues an opaque gateway token instead. Admin approval sees metadata, not bearer tokens or token hashes.

Composio receives explicit toolkit/tool allowlists. The gateway separately checks each direct tool call and every batch slug against the issued session's immutable approved list and current catalog. Sandbox, proxy execution, and arbitrary forwarding are disabled. Composio's fixed discovery/connection-management meta-tools remain available in execution sessions; batch execution can invoke only approved app tools. Connection-only sessions are restricted to connection-management tools.

Catalog refresh discovers ACTIVE connections for active gateway members and paginates each app using Composio's `toolkit_slug` filter. Results are filtered locally too. Apps connected only by unregistered/revoked users are excluded. Failed scans preserve the last committed catalog (except authoritative environment-key rotation, which clears old scope first). Scans, approval decisions, session issuance, and member mutations are serialized to prevent scope/authorization races.

Back up the complete data directory, including `encryption.key`. It contains request metadata, hashed credentials, and AES-256-GCM-encrypted upstream secrets. Keep it private: local encryption does not protect against an administrator who can read both the database and encryption key. Never put real tokens into tool arguments, request reasons, source control, or screenshots.

## API summary

| Endpoint | Credential | Behavior |
| --- | --- | --- |
| `GET /health` | None | Process health |
| `GET /api/admin/status` | Admin | Connection and scan status |
| `POST /api/admin/config` | Admin | Set key when not environment-managed; scan |
| `POST /api/admin/refresh` | Admin | Rescan; invalidate sessions and outstanding requests on success |
| `GET /api/admin/tools` | Admin | Read-only scoped catalog |
| `PUT /api/admin/policy` | Admin | Retired; returns HTTP 410 |
| `GET /api/admin/session-requests` | Admin | Recent requests, identities, tool lists, status |
| `POST /api/admin/session-requests/:id/approve` | Admin | Approve the exact pending tool set |
| `POST /api/admin/session-requests/:id/reject` | Admin | Reject a pending request |
| `GET /api/admin/sessions` | Admin | Active sessions, approved tools, and non-secret IDs |
| `POST /api/admin/sessions/:id/revoke` | Admin | Revoke one session |
| `GET /api/admin/members` | Admin | Member list without credentials |
| `POST /api/admin/members` | Admin | Create member; return credential once |
| `POST /api/admin/members/:id/rotate` | Admin | Replace credential and reactivate member |
| `POST /api/admin/members/:id/revoke` | Admin | Disable member and invalidate their access |
| `POST /api/sessions` | Member | Submit `{tools, reason?}` or collect `{request_id}` |
| `GET /api/session-requests/:id` | Member | Check own request; never issue credentials |
| `POST /mcp` | Member | Read-only discovery, submit/collect requests, check status |
| `POST /mcp` | Session | Restricted Streamable HTTP MCP execution |
| `DELETE /mcp` | Session | Revoke this session |

## Validation

```sh
npm ci
npx playwright install chromium
npm run check
npm test
```

For an existing Chromium installation, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Tests cover desktop/mobile approval and rejection, catalog discovery, exact allowlists, cross-member isolation, REST/MCP approval gates, retries/concurrency, migration, expiry, revocation, and the real SDK's serialization against a local fake server. They do not exercise a live Composio account. The interface is static HTML/CSS/JavaScript; no frontend build step is needed.

Reference: [Composio session configuration](https://docs.composio.dev/docs/configuring-sessions), [sessions via MCP](https://docs.composio.dev/docs/sessions-via-mcp).
