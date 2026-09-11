import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../server.mjs";
test("browser: configure, filter and disable tools, add member, issue session, mobile layout", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-browser-"));
  const calls = [];
  const app = createGateway({
    dataDir: dir,
    adminToken: "browser-admin",
    provider: {
      async connectedToolkits() { return ["gmail", "github"]; },
      async page() {
        return {
          items: [
            {
              slug: "GMAIL_SEND_EMAIL",
              toolkit: { slug: "gmail" },
              name: "Send email",
              description: "Send an email.",
            },
            {
              slug: "GMAIL_FETCH_EMAILS",
              toolkit: { slug: "gmail" },
              name: "Fetch emails",
              description: "Read your inbox.",
            },
            {
              slug: "GITHUB_DELETE_REPO",
              toolkit: { slug: "github" },
              name: "Delete repository",
              description: "Permanently delete a repository.",
            },
          ],
        };
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
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page.getByLabel("Admin token", { exact: true }).fill("browser-admin");
  await page.getByRole("button", { name: "Unlock gateway" }).click();
  await expect(
    page.getByRole("heading", { name: "Keep your key private." }),
  ).toBeVisible();
  await page
    .getByLabel("Composio API key", { exact: true })
    .fill("browser-secret-key");
  await page.getByRole("button", { name: "Connect & fetch tools" }).click();
  await expect(page.locator(".tool-row")).toHaveCount(3);
  await page.getByLabel("Search tools", { exact: true }).fill("DELETE");
  await expect(page.locator(".tool-row")).toHaveCount(1);
  await page.getByLabel("Enable GITHUB_DELETE_REPO", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Save permissions" }).click();
  await expect(page.locator("#save-bar")).toBeHidden();
  await page.getByLabel("Search tools", { exact: true }).fill("");
  await expect(page.locator("#disabled-count")).toHaveText("1");
  await page.getByRole("button", { name: "Members & sessions" }).click();
  await page.getByLabel("Member name", { exact: true }).fill("Oyster");
  await page.getByLabel("Composio user ID", { exact: true }).fill("user_test");
  await page.getByRole("button", { name: "Create member credential" }).click();
  await expect(page.locator("#credential-output")).not.toBeEmpty();
  const memberToken = await page.locator("#credential-output").textContent();
  await page.getByLabel("Member credential", { exact: true }).fill(memberToken);
  await page.getByRole("button", { name: "Issue test session" }).click();
  await expect(page.locator("#credential-title")).toHaveText(
    "Session connection for Oyster",
  );
  const session = JSON.parse(
    await page.locator("#credential-output").textContent(),
  );
  assert.match(session.mcp.headers.Authorization, /^Bearer /);
  assert.equal(JSON.stringify(session).includes("browser-secret-key"), false);
  assert.equal(calls[0].userId, "user_test");
  assert.deepEqual(calls[0].config.toolkits, ["gmail"]);
  await page.reload();
  await expect(page.locator("#login")).toBeVisible();
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  await page.getByLabel("Admin token", { exact: true }).fill("browser-admin");
  await page.getByRole("button", { name: "Unlock gateway" }).click();
  await expect(
    page.getByLabel("Enable GITHUB_DELETE_REPO", { exact: true }),
  ).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    JSON.stringify(
      await page.evaluate(() =>
        [...document.querySelectorAll("body *")]
          .filter((e) => e.getBoundingClientRect().right > innerWidth)
          .map((e) => ({
            tag: e.tagName,
            id: e.id,
            cls: e.className,
            width: e.getBoundingClientRect().width,
            right: e.getBoundingClientRect().right,
          })),
      ),
    ),
  );
  await expect(
    page.getByLabel("Enable GMAIL_FETCH_EMAILS", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
});
