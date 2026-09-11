import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../server.mjs";

test("browser: environment configuration needs no key entry and shows a managed connection", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "composio-env-browser-"));
  const secret = "browser-environment-key-test-only";
  const app = createGateway({
    dataDir: dir,
    adminToken: "browser-admin",
    composioApiToken: secret,
    provider: {
      async connectedToolkits() {
        return [];
      },
      async page() {
        throw Error("No unscoped catalog requests expected");
      },
      async remove() {},
    },
  });
  await app.waitForScan();
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
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
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page.getByLabel("Admin token", { exact: true }).fill("browser-admin");
  await page.getByRole("button", { name: "Unlock gateway" }).click();
  await expect(page.locator("#tools-tab")).toBeVisible();
  await expect(page.locator("#connection")).toHaveText("Environment");
  await page.getByRole("button", { name: "Connection", exact: false }).click();
  await expect(page.locator("#key-managed")).toContainText(
    "Configured by COMPOSIO_API_TOKEN",
  );
  await expect(page.locator("#key-form")).toBeHidden();
  assert.equal(
    (await page.locator("body").textContent()).includes(secret),
    false,
  );
  assert.equal(await page.locator("#api-key").inputValue(), "");
  assert.deepEqual(errors, []);
});
