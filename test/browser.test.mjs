import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../server.mjs";

test("browser: connected catalogs, member filters, shared policy, session API, mobile layout", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-browser-"));
  const calls = [],
    requests = [];
  const tools = [
    {
      slug: "GMAIL_SEND_EMAIL",
      toolkit: { slug: "gmail" },
      name: "Send email",
    },
    {
      slug: "GMAIL_FETCH_EMAILS",
      toolkit: { slug: "gmail" },
      name: "Fetch emails",
    },
    {
      slug: "GITHUB_DELETE_REPO",
      toolkit: { slug: "github" },
      name: "Delete repository",
    },
  ];
  const app = createGateway({
    dataDir: dir,
    adminToken: "browser-admin",
    provider: {
      async connectedToolkits(key, user) {
        return user === "user_test" ? ["github"] : ["gmail"];
      },
      async page(key, cursor, toolkit) {
        requests.push(toolkit);
        return { items: tools.filter((t) => t.toolkit.slug === toolkit) };
      },
      async create(key, userId, config) {
        calls.push({ key, userId, config });
        return {
          id: "trs_browser",
          url: "https://composio.dev/mcp/private",
          headers: { "x-api-key": key },
        };
      },
      async remove() {},
    },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  let browser;
  t.after(async () => {
    await browser?.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page.getByLabel("Admin token", { exact: true }).fill("browser-admin");
  await page.getByRole("button", { name: "Unlock gateway" }).click();
  await page
    .getByLabel("Composio API key", { exact: true })
    .fill("browser-secret-key");
  await page.getByRole("button", { name: "Connect & fetch tools" }).click();
  await expect(page.locator("#tools-list")).toContainText("Add a member");
  assert.deepEqual(requests, []);

  async function member(name, user) {
    await page.getByRole("button", { name: "Members & sessions" }).click();
    if (await page.locator("#credential-box").isVisible())
      await page.locator("#dismiss-credential").click();
    await page.getByLabel("Member name", { exact: true }).fill(name);
    await page.getByLabel("Composio user ID", { exact: true }).fill(user);
    await page
      .getByRole("button", { name: "Create member credential" })
      .click();
    await expect(page.locator("#credential-output")).not.toBeEmpty();
    await expect(page.locator("#members-list")).toContainText(user);
    return page.locator("#credential-output").textContent();
  }
  const credential = await member("GitHub member", "user_test");
  await page.getByRole("button", { name: "Tool permissions" }).click();
  await expect(page.locator(".tool-row")).toHaveCount(1);
  assert.deepEqual(requests, ["github"]);
  await member("Mail member", "mail_user");
  await page.getByRole("button", { name: "Tool permissions" }).click();
  await expect(page.locator(".tool-row")).toHaveCount(3);
  await expect(page.locator("#disabled-count")).toHaveText("3");
  for (const slug of [
    "GITHUB_DELETE_REPO",
    "GMAIL_FETCH_EMAILS",
    "GMAIL_SEND_EMAIL",
  ])
    await expect(
      page.getByLabel(`Enable ${slug}`, { exact: true }),
    ).not.toBeChecked();
  await page.getByLabel("Enable GITHUB_DELETE_REPO", { exact: true }).check();
  await page.getByLabel("Enable GMAIL_FETCH_EMAILS", { exact: true }).check();
  await page.getByLabel("Search tools", { exact: true }).fill("SEND");
  await expect(page.locator(".tool-row")).toHaveCount(1);
  await expect(
    page.getByLabel("Enable GMAIL_SEND_EMAIL", { exact: true }),
  ).not.toBeChecked();
  await page.getByLabel("Search tools", { exact: true }).fill("");

  // Switching member scopes is a local filter, not a policy reset.
  await page
    .getByLabel("Filter by member")
    .selectOption({ label: "GitHub member" });
  await expect(page.locator(".tool-row")).toHaveCount(1);
  await expect(page.locator("#total")).toHaveText("1");
  await page
    .getByLabel("Filter by member")
    .selectOption({ label: "Mail member" });
  await expect(page.locator(".tool-row")).toHaveCount(2);
  await expect(
    page.getByLabel("Enable GMAIL_SEND_EMAIL", { exact: true }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Save permissions" }).click();
  await expect(page.locator("#save-bar")).toBeHidden();
  await page.getByLabel("Filter by member").selectOption("");
  await expect(page.locator("#disabled-count")).toHaveText("1");

  await page.getByRole("button", { name: "Members & sessions" }).click();
  await expect(
    page.getByRole("heading", { name: "Request a session" }),
  ).toHaveCount(0);
  await expect(page.locator("#session-form, #member-token")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Add a member" }),
  ).toBeVisible();
  const response = await page.request.post(
    new URL("/api/sessions", page.url()).href,
    {
      headers: { Authorization: `Bearer ${credential}` },
      data: {},
    },
  );
  assert.equal(response.status(), 201);
  const session = await response.json();
  assert.match(session.mcp.headers.Authorization, /^Bearer /);
  assert.equal(JSON.stringify(session).includes("browser-secret-key"), false);
  assert.equal(calls[0].userId, "user_test");
  assert.deepEqual(calls[0].config.toolkits, ["github"]);

  await page.reload();
  await expect(page.locator("#login")).toBeVisible();
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  await page.getByLabel("Admin token", { exact: true }).fill("browser-admin");
  await page.getByRole("button", { name: "Unlock gateway" }).click();
  await expect(
    page.getByLabel("Enable GMAIL_SEND_EMAIL", { exact: true }),
  ).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await expect(page.getByLabel("Filter by member")).toBeVisible();
  await page.getByRole("button", { name: "Members & sessions" }).click();
  await expect(
    page.getByRole("heading", { name: "Add a member" }),
  ).toBeVisible();
  await expect(page.locator("#session-form, #member-token")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#logout").click();
  await expect(page.locator("#login")).toBeVisible();
  assert.deepEqual(errors, []);
});
