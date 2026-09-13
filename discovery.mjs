const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
export const discoveryTools = [
  {
    name: "COMPOSIO_SEARCH_TOOLS",
    description:
      "Search the gateway's synced catalog for tools in your connected apps, including disabled tools. Read-only keyword search, not Composio semantic search. No session token or execution permission required. Use query='' to browse; paginate with offset.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 1000 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
    annotations,
  },
  {
    name: "COMPOSIO_GET_TOOL_SCHEMAS",
    description:
      "Read input and output schemas for tools in your connected-app catalog, including disabled tools. Does not execute tools or grant permissions.",
    inputSchema: {
      type: "object",
      properties: {
        tool_slugs: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
        },
      },
      required: ["tool_slugs"],
      additionalProperties: false,
    },
    annotations,
  },
];
const fail = (message) => Object.assign(new Error(message), { status: 400 });
export async function discover(name, args, catalog, provider, apiKey) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw fail("Expected an arguments object.");
  if (name === "COMPOSIO_SEARCH_TOOLS") {
    const { query = "", limit = 20, offset = 0 } = args;
    if (
      Object.keys(args).some(
        (k) => !["query", "limit", "offset"].includes(k),
      ) ||
      typeof query !== "string" ||
      query.length > 1000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw fail(
        "Expected query (up to 1000 characters), limit (1–100), and nonnegative offset.",
      );
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = catalog
      .map((tool) => ({
        tool,
        score: words.filter((w) =>
          `${tool.slug} ${tool.name} ${tool.description}`
            .toLowerCase()
            .includes(w),
        ).length,
      }))
      .filter((r) => !words.length || r.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.tool.slug.localeCompare(b.tool.slug),
      );
    return {
      tools: matches.slice(offset, offset + limit).map((r) => r.tool),
      total: matches.length,
      next_offset: offset + limit < matches.length ? offset + limit : null,
      note: "Discovery does not authorize execution. Results reflect the last catalog sync.",
    };
  }
  const slugs = args.tool_slugs;
  if (
    Object.keys(args).some((k) => k !== "tool_slugs") ||
    !Array.isArray(slugs) ||
    slugs.length < 1 ||
    slugs.length > 20 ||
    slugs.some((s) => typeof s !== "string")
  )
    throw fail("Expected 1–20 tool_slugs.");
  const known = new Map(catalog.map((t) => [t.slug, t]));
  if (slugs.some((s) => !known.has(s)))
    throw fail(
      "A requested tool is unavailable in your connected-app catalog.",
    );
  const tools = [],
    signal = AbortSignal.timeout(30000);
  for (const slug of new Set(slugs)) {
    signal.throwIfAborted();
    const raw = await provider.schema(apiKey, slug, signal);
    if (
      raw.slug !== slug ||
      raw.toolkit?.slug !== known.get(slug).toolkit ||
      !raw.input_parameters ||
      typeof raw.input_parameters !== "object" ||
      Array.isArray(raw.input_parameters)
    )
      throw Error("Unexpected tool schema response.");
    tools.push({
      slug,
      toolkit: known.get(slug).toolkit,
      name: raw.name,
      description: raw.description,
      input_schema: raw.input_parameters,
      output_schema: raw.output_parameters,
    });
  }
  return { tools };
}
