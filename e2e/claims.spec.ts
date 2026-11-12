import { expect, test } from "@playwright/test";

const unique = () => Math.random().toString(36).slice(2, 10);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("a customer sends a claim with a photo; staff review it and ask for more; the customer sees the request", async ({ page, browser }) => {
  // The shop: an account, and an incident with its claim form open.
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Rosa Diaz");
  await page.getByLabel("Work email").fill(`rosa-${unique()}@example.com`);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByLabel("Shop name").fill("Diaz Ceramics");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto("/incidents/new");
  await page.getByLabel("Title", { exact: true }).fill("KX-9 teapot: lid may come loose");
  await page.getByRole("button", { name: "Open the incident" }).click();
  await expect(page).toHaveURL(/\/notice$/);
  await page.getByRole("link", { name: "Claims" }).click();
  await page.getByRole("button", { name: "Open the claim form" }).click();
  await expect(page.getByText("Claim form opened.")).toBeVisible();
  const url = (await page.getByTestId("claim-url").textContent())!.trim();
  const path = new URL(url).pathname;

  // A customer, in another browser, with no account.
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(path);
  await expect(customer.getByText("Diaz Ceramics")).toBeVisible();
  await customer.getByLabel("Your name").fill("Maya Chen");
  await customer.getByLabel("Your email").fill("maya@example.com");
  await customer.getByLabel("Batch code").fill("K-77");
  await customer.getByLabel("What happened").fill("I bought the KX-9 teapot in October; the lid came loose twice.");
  await customer.locator("#files").setInputFiles({ name: "label.png", mimeType: "image/png", buffer: PNG });
  await customer.getByRole("button", { name: "Send the claim" }).click();
  await expect(customer).toHaveURL(/\/claim\/status\//);
  await expect(customer.getByTestId("claim-status")).toContainText("submitted");
  await expect(customer.getByText("label.png")).toBeVisible();

  // Staff review it.
  await page.reload();
  await expect(page.getByTestId("claims")).toContainText("Maya Chen");
  await page.getByRole("button", { name: "Maya Chen" }).click();
  const sheet = page.getByTestId("claim-sheet");
  await expect(sheet).toContainText("the lid came loose twice");
  await expect(sheet.getByRole("img", { name: /product label sent by the customer/ })).toBeVisible();
  await expect(sheet).toContainText("No order matches");
  await sheet.getByLabel("Message to the customer").fill("Please add a photo of your receipt.");
  await sheet.getByRole("button", { name: "Ask for more" }).click();
  await expect(page.getByText("Asked the customer for more evidence.")).toBeVisible();

  // The customer sees the request.
  await customer.reload();
  await expect(customer.getByTestId("claim-status")).toContainText("needs evidence");
  await expect(customer.getByText("Please add a photo of your receipt.")).toBeVisible();
  await customer.context().close();
});
