import { expect, test } from "@playwright/test";

const unique = () => Math.random().toString(36).slice(2, 10);

test("the home page explains the product and offers the demo", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Who is owed money");
  await expect(page.getByRole("button", { name: "Open the recall demo" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
});

test("app pages send signed-out visitors to sign-in and back afterwards", async ({ page }) => {
  await page.goto("/incidents");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fincidents/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("a merchant signs up, lands on the dashboard, signs out and signs in again", async ({ page }) => {
  const email = `owner-${unique()}@example.com`;
  const password = "correct horse battery";

  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Priya Shah");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByLabel("Shop name").fill("Shah Kitchenware");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Hello, Priya" })).toBeVisible();
  await expect(page.getByText("Shah Kitchenware")).toBeVisible();
  await expect(page.getByText("No incidents yet")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("wrong password!!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();

  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("sign-up refuses a short password before sending anything", async ({ page }) => {
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Short");
  await page.getByLabel("Work email").fill(`short-${unique()}@example.com`);
  await page.getByLabel("Password").fill("abc");
  await page.getByLabel("Shop name").fill("Tiny Shop");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
  expect(await page.getByLabel("Password").evaluate((el: HTMLInputElement) => el.validity.tooShort)).toBe(true);
});

test("the demo opens the recall case inside the app", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open the recall demo" }).click();
  await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}\/notice$/, { timeout: 60_000 });
  await expect(page.getByRole("heading", { level: 1 })).toContainText("HM-300");
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByRole("cell", { name: /HM-300/ })).toBeVisible();
});

test("an unknown page shows a clear not-found page", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { name: "This page does not exist" })).toBeVisible();
});
