import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../server.mjs";

test("browser: catalog discovery, request approval/rejection, session revocation and mobile layout", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-browser-"));
  const calls = [],
    scans = [];
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
        scans.push(toolkit);
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
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  await page.goto(origin);
  const unlock = async () => {
    await page.getByLabel("Admin token", { exact: true }).fill("browser-admin");
    await page.getByRole("button", { name: "Unlock gateway" }).click();
  };
  await unlock();
  await page
    .getByLabel("Composio API key", { exact: true })
    .fill("browser-secret-key");
  await page.getByRole("button", { name: "Connect & fetch tools" }).click();
  await expect(page.locator("#tools-list")).toContainText("Add a member");
  assert.deepEqual(scans, []);
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
  await page.getByRole("button", { name: "Tools & requests" }).click();
  await expect(page.locator(".tool-row")).toHaveCount(1);
  assert.deepEqual(scans, ["github"]);
  await member("Mail member", "mail_user");
  await page.getByRole("button", { name: "Tools & requests" }).click();
  await expect(page.locator(".tool-row")).toHaveCount(3);
  await expect(
    page.locator(
      "#tools-list input[type=checkbox], #save-bar, #enable-visible",
    ),
  ).toHaveCount(0);
  await page.getByLabel("Search tools", { exact: true }).fill("SEND");
  await expect(page.locator(".tool-row")).toHaveCount(1);
  await page.getByLabel("Search tools", { exact: true }).fill("");
  await page
    .getByLabel("Filter by member")
    .selectOption({ label: "GitHub member" });
  await expect(page.locator(".tool-row")).toHaveCount(1);
  await page
    .getByLabel("Filter by member")
    .selectOption({ label: "Mail member" });
  await expect(page.locator(".tool-row")).toHaveCount(2);
  await page.getByLabel("Filter by member").selectOption("");
  const submit = async (reason) => {
    const r = await page.request.post(origin + "/api/sessions", {
      headers: { Authorization: `Bearer ${credential}` },
      data: { tools: ["GITHUB_DELETE_REPO"], reason },
    });
    assert.equal(r.status(), 202);
    return r.json();
  };
  const request = await submit('<img src=x onerror="window.xss=true">');
  assert.equal(calls.length, 0);
  await page.locator("#refresh-requests").click();
  const row = page.locator(`[data-request-id="${request.request_id}"]`);
  await expect(row).toContainText("GitHub member · pending");
  await expect(row).toContainText("GITHUB_DELETE_REPO");
  await expect(row).toContainText("Delete repository");
  await expect(row).toContainText("<img src=x");
  assert.equal(await page.evaluate(() => window.xss), undefined);
  await row.getByRole("button", { name: "Approve request" }).click();
  await expect(row).toContainText("approved");
  assert.equal(calls.length, 0);
  const response = await page.request.post(origin + "/api/sessions", {
    headers: { Authorization: `Bearer ${credential}` },
    data: { request_id: request.request_id },
  });
  assert.equal(response.status(), 201);
  const session = await response.json();
  assert.equal(JSON.stringify(session).includes("browser-secret-key"), false);
  assert.deepEqual(calls[0].config.tools.github.enable, ["GITHUB_DELETE_REPO"]);
  await page.getByRole("button", { name: "Members & sessions" }).click();
  await expect(page.locator("#session-form, #member-token")).toHaveCount(0);
  await expect(page.locator("#sessions-list")).toContainText(
    "Approved tools: GITHUB_DELETE_REPO",
  );
  assert.equal(
    (await page.locator("#sessions-list").textContent()).includes(
      session.token,
    ),
    false,
  );
  await page
    .getByRole("button", { name: "Revoke session", exact: true })
    .click();
  await expect(page.locator("#sessions-list")).toHaveText(
    "No active sessions.",
  );
  const revoked = await page.request.post(origin + "/mcp", {
    headers: { Authorization: session.mcp.headers.Authorization },
    data: { jsonrpc: "2.0", id: 1, method: "ping" },
  });
  assert.equal(revoked.status(), 401);
  await page.reload();
  await expect(page.locator("#login")).toBeVisible();
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  await unlock();
  await page.setViewportSize({ width: 390, height: 844 });
  const rejected = await submit("Long reason " + "x".repeat(900));
  const mobileRow = page.locator(`[data-request-id="${rejected.request_id}"]`);
  await expect(mobileRow).toBeVisible({ timeout: 10000 }); // Automatic polling.
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await mobileRow.getByRole("button", { name: "Reject request" }).click();
  await expect(mobileRow).toContainText("rejected");
  const status = await page.request.get(
    origin + `/api/session-requests/${rejected.request_id}`,
    { headers: { Authorization: `Bearer ${credential}` } },
  );
  assert.equal((await status.json()).status, "rejected");
  assert.equal(calls.length, 1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#logout").click();
  await expect(page.locator("#login")).toBeVisible();
  await expect(page.locator("#requests-list")).toBeEmpty();
  assert.deepEqual(errors, []);
});
