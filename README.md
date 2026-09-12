# Composio Gateway

A small self-hosted admin interface and MCP gateway. Enter a Composio project API key, fetch the tool catalog, disable tools, and issue restricted sessions to authenticated members.

## Run

Requires Node.js 22.19 or newer. On the first startup, set `ADMIN_TOKEN` to a long random secret (at least 32 random bytes) using your environment or deployment secret manager. Keep the original in your password manager; only its SHA-256 hash is stored in `data/admin.token.sha256`.

```sh
npm ci
npm start
```

Open `http://127.0.0.1:8788` and enter the original `ADMIN_TOKEN` in the login form, **not its hash**. The browser holds the admin credential only in memory; reloading locks the interface.

On upgrades, an existing `data/admin.token` is automatically hashed and removed; the same token still logs in. Save your existing token before upgrading, as it cannot be recovered from the hash afterward. A stored hash allows restarts without `ADMIN_TOKEN`; supplying it again replaces the stored hash. See [admin authentication](docs/admin-authentication.md) for Railway setup, rotation, and security limits.

1. Set **`COMPOSIO_API_TOKEN`** to your Composio project API key in your deployment variables and restart/redeploy. The gateway configures it automatically; no key entry in the interface is needed. Alternatively, omit the variable and enter the key in **Connection**. Tools are fetched only for apps connected by active gateway members. With no members or connected apps, the catalog stays empty and no tool-catalog requests are made.
2. In **Members & sessions**, create a member using the Composio user ID associated with their app connections. Copy the member credential; it is only displayed once. Adding or reactivating a member automatically refreshes the connected-app catalog.
3. In **Tool permissions**, filter by member to see their connected apps at the last sync, then search or filter by app and disable tools. Member selection only filters the view: the saved policy remains shared by all members. Initially newly discovered tools are enabled.
4. Use the member credential to request a session through the [session API](#request-a-session). The admin interface manages members and permissions; it does not issue test sessions. With no apps connected, the session allows connection management only. After connecting an app, click **Sync catalog**. If a session request discovers an app absent from the cache, it starts a scoped refresh and returns HTTP 409; retry after the refresh finishes. Copy the successful session's MCP URL and Authorization header into Oyster.

App OAuth remains available through the session's Composio connection-management tools. This version does not include a separate Gmail/GitHub OAuth connection page. A member cannot change their Composio user ID or session policy through the session endpoint.

## Railway configuration

In the gateway service's **Variables** tab, set:

- `COMPOSIO_API_TOKEN`: your **Composio project API key**, not a member/session token and not a randomly generated value.
- `ADMIN_TOKEN`: your separate random admin login token.
- `DATA_DIR=/app/data`: attach a persistent volume at that path.
- `PUBLIC_URL`: the service's public HTTPS origin.

Redeploy to apply the variables. **Connection** will show that Composio is managed by `COMPOSIO_API_TOKEN` and hide the key-entry form. The admin status API reports `keySource: "environment"`, never the key itself. Replacing it through `/api/admin/config` is rejected while the variable is configured; manual catalog refresh remains available.

A new or changed environment key immediately replaces the encrypted saved key, revokes old sessions, clears the previous catalog, and starts a connected-app scan. A failed scan is shown as an error and never falls back to the old project's key. An unchanged key reuses the existing scoped catalog and sessions on restart. Blank, whitespace-containing, non-ASCII, or over-1000-character values fail startup; omit the variable rather than leaving it empty when using the UI.

The key is stored encrypted in the database, as with UI configuration. Removing the variable makes the saved key editable through the UI again; it does not erase the encrypted copy. Deleting the Node process's environment entry after initialization does not erase Railway's variable store, operating-system snapshots, or historical backups.

**The variable does not replace persistent storage.** Without a volume, members, permissions, encryption keys, and sessions can still disappear on redeploy even though the Composio project key is restored automatically. It also does not connect GitHub or other apps for each member; those OAuth connections still belong to the member's Composio user ID.

## Request a session

### Through MCP

Configure an HTTP MCP connection to `https://gateway.example.com/mcp` with
`Authorization: Bearer <member-token>`. This authenticated connection exposes
only **`GATEWAY_CREATE_SESSION`**. Call it with `{}` to obtain the same session
connection details as the REST endpoint below.

Use the returned `mcp.url` and session Authorization header for a separate MCP
connection that accesses Composio tools. The member-authenticated connection
cannot execute those tools directly. Keep both credentials private. Session
creation obeys the same saved permissions, member identity, expiry, onboarding,
and active-session limit as REST. Policy changes do not disable this local
bootstrap tool; revoked or rotated member credentials stop authenticating.

### Through REST (unchanged)

```sh
curl https://gateway.example.com/api/sessions \
  -H "Authorization: Bearer $GATEWAY_MEMBER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Example response:

```json
{
  "token": "<gateway-session-token>",
  "token_type": "Bearer",
  "expires_at": "2026-09-08T22:00:00.000Z",
  "mcp": {
    "type": "http",
    "url": "https://gateway.example.com/mcp",
    "headers": { "Authorization": "Bearer <gateway-session-token>" }
  }
}
```

Set `PUBLIC_URL` to obtain an absolute MCP URL in session responses. Without it, resolve the returned `/mcp` against the gateway origin. A member credential authenticates the session-creation tool, not Composio tool execution. Request a new session on expiry or revocation using MCP or REST. Automatic connection replacement remains the client's responsibility.

A session lasts one hour by default. There are at most ten unexpired sessions per member. To release one early:

```sh
curl -X DELETE https://gateway.example.com/mcp \
  -H "Authorization: Bearer $GATEWAY_SESSION_TOKEN"
```

## Why MCP requests pass through the gateway

The installed Composio SDK places the project API key in `session.mcp.headers`. Forwarding that connection object would expose the project credential. This gateway instead issues a random, opaque bearer token and stores the upstream connection encrypted on the server.

```mermaid
sequenceDiagram
    participant Admin as Admin interface
    participant Gateway as Gateway VPS
    participant Composio
    participant Oyster
    Admin->>Gateway: API key, tool policy, member identities
    Oyster->>Gateway: POST /api/sessions + member credential
    Gateway->>Composio: Create session with member user ID and tool allowlists
    Composio-->>Gateway: Upstream MCP connection
    Gateway-->>Oyster: Expiring gateway token + gateway MCP URL
    Oyster->>Gateway: MCP request + session token
    Gateway->>Gateway: Check member, expiry, policy and tool access
    Gateway->>Composio: Forward to fixed session endpoint with private API key
    Composio-->>Gateway: Result
    Gateway-->>Oyster: Result
```

The gateway only proxies a fixed set of MCP methods to the server-created Composio endpoint. It does not accept caller-supplied upstream URLs, API keys, user IDs, or policy overrides. Composio receives explicit toolkit and tool allowlists. The gateway additionally blocks disabled direct tool calls and batch tool slugs. Sandbox and proxy execution are disabled. Discovery, schemas, batch execution, and app connection management remain available.

Saving permissions, replacing the key after a successful scan, or syncing the catalog invalidates all gateway sessions and aborts active proxy requests. Revoking or rotating a member invalidates that member's sessions. Remote session deletion is attempted on revocation and expiry; local revocation remains effective if Composio is unavailable. An action already accepted by Composio cannot be undone by revoking its session.

Catalog refresh discovers ACTIVE connections separately for each active gateway member, deduplicates their app slugs, and paginates each app using Composio's `toolkit_slug` filter. It also filters responses locally. Apps connected only by unregistered or revoked users are not fetched. Revoking a member refreshes the remaining members' scope. A legacy full-catalog cache is hidden on upgrade until a scoped refresh succeeds.

A failed connection lookup or catalog request leaves the last committed key and catalog intact, with an error shown in the interface. With no active members, a new key is stored but cannot be checked through connection discovery until a member is added. Scans are serialized with member, policy, and session mutations to prevent stale scope commits; those operations may wait for an in-progress scan. Successful automatic refreshes revoke existing sessions just like manual syncs.

Catalog refresh enables newly discovered tools by default. Disabled-tool settings are retained when an app disconnects or leaves the active-member scope, so reconnecting does not reset its restrictions. Until refresh, new tools are absent from the explicit allowlist. Review the refreshed catalog before issuing new sessions if you need to vet new additions.

## Configuration and VPS deployment

Environment variables are read directly; `.env` is not automatically loaded. Use `node --env-file=.env server.mjs` if you copy `.env.example` to `.env`.

| Variable              | Default         | Purpose                                             |
| --------------------- | --------------- | --------------------------------------------------- |
| `HOST`                | `127.0.0.1`     | Bind address                                        |
| `PORT`                | `8788`          | HTTP port                                           |
| `DATA_DIR`            | Project `data/` | Persistent SQLite database and encryption key       |
| `PUBLIC_URL`          | Unset           | Externally reachable HTTP(S) origin, without a path |
| `SESSION_TTL_SECONDS` | `3600`          | Session lifetime, 60–86400 seconds                  |
| `ADMIN_TOKEN`         | Unset           | Required on fresh install; overrides persisted admin hash |
| `COMPOSIO_API_TOKEN`  | Unset           | Composio project API key; configures at startup and locks UI key edits |

Use an HTTPS reverse proxy on a VPS so admin, member and session bearer credentials are protected in transit. The gateway does not trust forwarded Host headers to construct session URLs. Configure `PUBLIC_URL` explicitly.

A Dockerfile is included:

```sh
docker build -t composio-gateway .
docker run -d --name composio-gateway --restart unless-stopped \
  -p 127.0.0.1:8788:8788 \
  -e PUBLIC_URL=https://gateway.example.com \
  -e ADMIN_TOKEN \
  -e COMPOSIO_API_TOKEN \
  -v composio-gateway-data:/app/data \
  composio-gateway
```

Back up the entire data directory, including `encryption.key`; the database cannot be decrypted without it. The database contains hashed member/session tokens and AES-256-GCM-encrypted Composio credentials. Keep the data directory private: encryption does not protect secrets from an administrator who can read both the database and its local encryption key. Secrets are excluded from source control and the Docker build context.

## Validation

```sh
npm ci
npx playwright install chromium
npm run check
npm test
```

For an existing Chromium installation, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable when running tests. Tests include an actual browser flow at desktop and mobile widths, authorization boundaries, pagination, policy enforcement, session expiry/revocation, concurrent policy changes, batch filtering, and the real SDK's request serialization against a local fake Composio server. They do not require or exercise a live Composio account. The UI is static HTML/CSS/JavaScript, so no build step is needed.

## API summary

| Endpoint                             | Credential | Behavior                                                    |
| ------------------------------------ | ---------- | ----------------------------------------------------------- |
| `GET /health`                        | None       | Process health                                              |
| `GET /api/admin/status`              | Admin      | Connection and scan status; no secrets                      |
| `POST /api/admin/config`             | Admin      | `{ "apiKey": "…" }`; starts catalog scan                    |
| `POST /api/admin/refresh`            | Admin      | Rescan with stored key                                      |
| `GET /api/admin/tools`               | Admin      | Scoped catalog and active members' last-synced app lists      |
| `PUT /api/admin/policy`              | Admin      | `{ "disabled": ["TOOL_SLUG"] }`; revokes sessions           |
| `GET /api/admin/members`             | Admin      | Member list; no credentials                                 |
| `POST /api/admin/members`            | Admin      | `{ "name": "…", "userId": "…" }`; returns member token once |
| `POST /api/admin/members/:id/rotate` | Admin      | Replace credential and reactivate member                    |
| `POST /api/admin/members/:id/revoke` | Admin      | Disable member and invalidate their sessions                |
| `POST /api/sessions`                 | Member     | Empty object; issue restricted gateway session              |
| `POST /mcp`                          | Session    | Streamable HTTP MCP requests                                |
| `DELETE /mcp`                        | Session    | Revoke this session                                         |

Reference: [Composio session configuration](https://docs.composio.dev/docs/configuring-sessions), [sessions via MCP](https://docs.composio.dev/docs/sessions-via-mcp). The installed SDK source in `node_modules/@composio/core/src/models/ToolRouter.ts` supplies the upstream MCP authentication headers.
