import { Composio } from "@composio/core";
// Raw catalog API retains pagination; the high-level tools helper returns one page.
export function createProvider({
  fetchImpl = fetch,
  makeClient = (apiKey) => new Composio({ apiKey, allowTracking: false }),
} = {}) {
  return {
    async page(apiKey, cursor, toolkit) {
      if (typeof toolkit !== "string" || !/^[a-z0-9_-]+$/.test(toolkit))
        throw new Error("A single toolkit is required for catalog requests.");
      const url = new URL("https://backend.composio.dev/api/v3.1/tools");
      url.searchParams.set("toolkit_slug", toolkit);
      url.searchParams.set("limit", "1000");
      url.searchParams.set("important", "false");
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetchImpl(url, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(60000),
        redirect: "error",
      });
      if (!res.ok)
        throw new Error(
          `Composio catalog request failed (${res.status}). Check the API key and project permissions.`,
        );
      const data = await res.json();
      if (!Array.isArray(data.items))
        throw new Error("Unexpected Composio catalog response.");
      return data;
    },
    async schema(apiKey, slug, signal = AbortSignal.timeout(15000)) {
      const res = await fetchImpl(
        `https://backend.composio.dev/api/v3.1/tools/${encodeURIComponent(slug)}`,
        {
          headers: { "x-api-key": apiKey },
          signal,
          redirect: "error",
        },
      );
      if (!res.ok) throw new Error("Composio schema request failed.");
      return res.json();
    },
    async connectedToolkits(apiKey, userId) {
      const c = makeClient(apiKey),
        slugs = new Set(),
        seen = new Set();
      let cursor;
      do {
        const page = await c.connectedAccounts.list(
          {
            userIds: [userId],
            statuses: ["ACTIVE"],
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
          { signal: AbortSignal.timeout(60000) },
        );
        for (const account of page.items) {
          if (account.status === "ACTIVE" && account.toolkit?.slug)
            slugs.add(account.toolkit.slug);
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor))
          throw new Error("Connected account pagination repeated a cursor.");
        seen.add(cursor);
      } while (cursor);
      return [...slugs];
    },
    async create(apiKey, userId, config) {
      const c = makeClient(apiKey);
      const s = await c.create(
        userId,
        { ...config, mcp: true },
        { signal: AbortSignal.timeout(60000) },
      );
      const url = new URL(s.mcp.url);
      if (
        url.protocol !== "https:" ||
        !(
          url.hostname === "composio.dev" ||
          url.hostname.endsWith(".composio.dev")
        )
      )
        throw new Error("Unexpected Composio MCP endpoint.");
      return { id: s.sessionId, url: url.href, headers: s.mcp.headers };
    },
    async remove(apiKey, id) {
      await makeClient(apiKey).sessions.delete(id, {
        signal: AbortSignal.timeout(15000),
      });
    },
    async forward(upstream, body, protocol, signal) {
      return fetchImpl(upstream.url, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          ...upstream.headers,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(upstream.transportId
            ? { "Mcp-Session-Id": upstream.transportId }
            : {}),
          ...(protocol ? { "MCP-Protocol-Version": protocol } : {}),
        },
        body: JSON.stringify(body),
      });
    },
  };
}
