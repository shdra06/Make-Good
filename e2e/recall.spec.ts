import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// The whole recall case in the new app, on the PayPal simulator with the AI
// switched off: the same ground the old page's browser test covered.

test.setTimeout(300_000);

const tab = (page: Page, name: string) => page.getByRole("navigation", { name: "Steps" }).getByRole("link", { name: new RegExp(name) });
const record = (page: Page, orderDigits: string) => page.locator(`button[data-order*="${orderDigits}"]`).first();

test("a recall from notice to PayPal-confirmed refunds", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // Failed requests are checked by address below; the console line does not say which one.
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("response", (r) => {
    const url = new URL(r.url());
    // The one expected failure: opening a customer link a second time.
    const expected = r.status() === 404 && url.pathname.startsWith("/api/public/confirm/");
    if (r.status() >= 400 && !expected) errors.push(`${r.status()} ${r.request().method()} ${url.pathname}`);
  });

  // Demo shop and the recall case
  await page.goto("/");
  await page.getByRole("button", { name: "Open the recall demo" }).first().click();
  await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}\/notice$/, { timeout: 60_000 });
  await expect(page.getByText("PayPal: simulator, no real money")).toBeVisible();
  await expect(page.getByText("Records: synthetic (invented)")).toBeVisible();

  // Step 1: read the notice, save the rules
  await page.getByRole("button", { name: /^Read it/ }).click();
  const said = page.getByTestId("notice-reading");
  await expect(said).toContainText("B-2217");
  await expect(said).toContainText("HM-300-EU");
  await page.getByRole("button", { name: "Save these rules" }).click();
  await expect(page.getByRole("heading", { name: /Rules in force, version 1/ })).toBeVisible();

  // Step 2: orders from a spreadsheet, then the match
  await tab(page, "Customers").click();
  await page.getByTestId("csv-upload").locator("summary").click();
  await page.getByLabel("Order file").setInputFiles(path.resolve("demo", "sample-orders.csv"));
  await expect(page.getByTestId("csv-result")).toContainText("3 rows, 2 orders");
  await page.getByRole("button", { name: "Import 2 orders" }).click();
  await expect(page.getByTestId("csv-result")).toContainText("imported (2 new");

  await page.getByRole("button", { name: "Find affected customers" }).click();
  await expect(page.getByTestId("matrix")).toContainText("Ready for approval");

  // People decide the look-alike product codes
  const aliases = page.getByTestId("aliases");
  await expect(aliases.getByRole("button", { name: "Same product" }).first()).toBeVisible();
  for (let i = 0; i < 6; i++) {
    const row = aliases
      .locator("tr[data-alias]")
      .filter({ has: page.getByRole("button", { name: "Same product" }) })
      .first();
    if ((await row.count()) === 0) break;
    const alias = await row.getAttribute("data-alias");
    await row.getByRole("button", { name: alias === "HM-3000" ? "Different" : "Same product" }).click();
    await expect(aliases.locator(`tr[data-alias="${alias}"]`).getByRole("button")).toHaveCount(0);
  }
  await expect(page.getByText("Every look-alike product code has been decided.")).toBeVisible();

  // Step 3: the Recovery Map. A held record, confirmed by a person with a reason
  await tab(page, "Evidence").click();
  await record(page, "5019").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByTestId("record")).toContainText("points the other way");
  await sheet.getByLabel("Note").fill("Customer sent a photo of the label, B-2217");
  await sheet.getByRole("button", { name: "Confirm this customer" }).click();
  await expect(page.getByText("Confirmed in your name.")).toBeVisible();
  await expect(sheet).toBeHidden();

  // Ask a customer by email; they answer through the one-time link
  await record(page, "5020").click();
  await page.getByRole("dialog").getByRole("button", { name: "Email the customer a link" }).click();
  await expect(page.getByRole("dialog")).toContainText("Saved in the outbox as a file");
  const link = await page
    .getByRole("dialog")
    .getByLabel(/Send this link to the customer/)
    .inputValue();
  expect(link).toMatch(/\/confirm\/[A-Za-z0-9_-]{20,}$/);
  const incidentUrl = page.url().split("?")[0]!;
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "One question about your order" })).toBeVisible();
  await page.getByLabel("Batch code").fill("B-2224");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "This link cannot be used" })).toBeVisible();
  await page.goto(incidentUrl);

  // Two payments carry one order number: a person says which
  await record(page, "4871").click();
  await page.getByRole("dialog").getByRole("radio").first().check();
  await page.getByRole("dialog").getByLabel("How do you know?").fill("Matches the PayPal receipt the customer forwarded");
  await page.getByRole("dialog").getByRole("button", { name: "This payment paid for the order" }).click();
  await expect(page.getByText("The payment is settled in your name")).toBeVisible();

  // Step 4: three options, priced
  await tab(page, "Options").click();
  await expect(page.getByTestId("policies").locator("[data-policy]")).toHaveCount(3);

  // Step 5: one exact list, approved
  await tab(page, "Approval").click();
  await page.getByRole("button", { name: "Build the payment list" }).click();
  await expect(page.getByTestId("manifest-hash")).toContainText("sha-256");
  await page.getByRole("button", { name: "Send for approval" }).click();
  await page.getByRole("button", { name: /Approve exactly this list/ }).click();
  await expect(page.getByText("Approved. The approval covers this version")).toBeVisible();

  // Step 6: pay, with one lost reply from PayPal
  await tab(page, "Payments").click();
  await page.getByRole("button", { name: "Lose one reply from PayPal" }).click();
  await page.getByRole("button", { name: "Start paying" }).click();
  const ops = page.getByTestId("operations");
  await expect(ops).toBeVisible();
  await expect(page.getByText("Differences found and how they were settled")).toBeVisible({ timeout: 180_000 });
  await expect(ops).not.toContainText("Outcome unknown", { timeout: 180_000 });
  await expect(ops).toContainText("The first reply was lost");
  await expect(page.getByText("No second payment was made")).toBeVisible();

  // Customers are told once, only after PayPal confirmed
  const paid = await ops.locator("tbody tr").filter({ hasText: "Paid: confirmed by PayPal" }).count();
  expect(paid).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Email the customers PayPal has paid" }).click();
  await expect(page.getByTestId("notices").locator("details")).toHaveCount(paid + 1);
  await expect(page.getByTestId("notices")).toContainText("[TEST: PayPal simulator, no real money]");
  await page.getByRole("button", { name: "Email the customers PayPal has paid" }).click();
  await expect(page.getByText(/^0 emailed, \d+ already told/)).toBeVisible();
  await expect(page.getByTestId("notices").locator("details")).toHaveCount(paid + 1);

  // Results against the known answers, and the audit trail
  await expect(page.getByTestId("results")).toContainText("units called proven that were not affected");
  await tab(page, "Activity").click();
  await expect(page.getByText(/entries, chain intact/)).toBeVisible();

  expect(errors, errors.join("\n")).toEqual([]);
});
