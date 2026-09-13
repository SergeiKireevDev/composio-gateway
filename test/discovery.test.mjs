import test from "node:test";
import assert from "node:assert/strict";
import { discover } from "../discovery.mjs";
import { createProvider } from "../composio.mjs";

const catalog = [
  {
    slug: "GITHUB_READ",
    toolkit: "github",
    name: "Read",
    description: "Read a repository",
  },
  {
    slug: "GITHUB_WRITE",
    toolkit: "github",
    name: "Write",
    description: "Write a repository",
  },
];

test("keyword discovery validates inputs and supports stable pagination", async () => {
  const search = (args) =>
    discover("COMPOSIO_SEARCH_TOOLS", args, catalog, {}, "key");
  const first = await search({ query: "repository", limit: 1 });
  assert.equal(first.tools[0].slug, "GITHUB_READ");
  assert.equal(first.total, 2);
  assert.equal(first.next_offset, 1);
  assert.equal(
    (await search({ limit: 1, offset: 1 })).tools[0].slug,
    "GITHUB_WRITE",
  );
  assert.equal((await search({ query: "nothing" })).total, 0);
  for (const args of [
    null,
    [],
    { userId: "other" },
    { offset: -1 },
    { limit: 1.5 },
    { query: "a".repeat(1001) },
  ])
    await assert.rejects(search(args));
});

test("schema adapter uses only the read-only metadata endpoint and validates tool identity", async () => {
  let calls = 0;
  const provider = createProvider({
    makeClient() {
      throw Error("Discovery must not create a session or execute a tool");
    },
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(
        url,
        "https://backend.composio.dev/api/v3.1/tools/GITHUB_READ",
      );
      assert.equal(options.method, undefined);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["x-api-key"], "key");
      assert.ok(options.signal);
      return Response.json({
        slug: "GITHUB_READ",
        toolkit: { slug: "github" },
        input_parameters: { type: "object" },
      });
    },
  });
  const read = (p, slugs = ["GITHUB_READ"]) =>
    discover(
      "COMPOSIO_GET_TOOL_SCHEMAS",
      { tool_slugs: slugs },
      catalog,
      p,
      "key",
    );
  const result = await read(provider, ["GITHUB_READ", "GITHUB_READ"]);
  assert.equal(result.tools.length, 1);
  assert.equal(calls, 1);
  await assert.rejects(read(provider, ["UNKNOWN"]));
  assert.equal(calls, 1);
  for (const raw of [
    { slug: "OTHER" },
    { slug: "GITHUB_READ", toolkit: { slug: "gmail" } },
    { slug: "GITHUB_READ", toolkit: { slug: "github" }, input_parameters: [] },
  ])
    await assert.rejects(
      read({ schema: async () => raw }),
      /Unexpected tool schema/,
    );
});
