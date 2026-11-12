import { expect, test } from "@playwright/test";
import { linkFor } from "./outbox";

const unique = () => Math.random().toString(36).slice(2, 10);

test("a new account confirms its email from the link it was sent", async ({ page }) => {
  const email = `verify-${unique()}@mg.test`;
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Lena Ortiz");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByLabel("Shop name").fill("Ortiz Outdoors");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("verify-banner")).toContainText(email);

  await page.goto(await linkFor(email, "verify-email"));
  await page.getByRole("button", { name: "Confirm my email" }).click();
  await expect(page.getByTestId("verify-done")).toContainText(`${email} is confirmed`);
  await page.getByRole("link", { name: "Go to the dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Hello, Lena" })).toBeVisible();
  await expect(page.getByTestId("verify-banner")).toHaveCount(0);
});

test("a forgotten password is reset by email, and the old sessions are signed out", async ({ page, browser }) => {
  const email = `reset-${unique()}@mg.test`;
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Sam Reyes");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("the old password 1");
  await page.getByLabel("Shop name").fill("Reyes Tools");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Hello, Sam" })).toBeVisible();

  // Someone else, signed out, asks for the reset.
  const other = await browser.newPage();
  await other.goto("/sign-in");
  await other.getByRole("link", { name: "Forgot your password?" }).click();
  await expect(other.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await other.getByLabel("Email").fill(email);
  await other.getByRole("button", { name: "Email me a link" }).click();
  await expect(other.getByTestId("reset-sent")).toBeVisible();

  const link = await linkFor(email, "reset-password");
  await other.goto(link);
  await other.getByLabel("New password").fill("the new password 2");
  await other.getByLabel("The same again").fill("not the same");
  await other.getByRole("button", { name: "Set the new password" }).click();
  await expect(other.getByText("The two passwords are not the same.")).toBeVisible();
  await other.getByLabel("The same again").fill("the new password 2");
  await other.getByRole("button", { name: "Set the new password" }).click();
  await expect(other.getByTestId("reset-done")).toBeVisible();

  // The link works once.
  await other.goto(link);
  await other.getByLabel("New password").fill("a third password 3");
  await other.getByLabel("The same again").fill("a third password 3");
  await other.getByRole("button", { name: "Set the new password" }).click();
  await expect(other.getByText(/not valid any more/)).toBeVisible();

  // The first browser's session was signed out.
  await page.reload();
  await expect(page).toHaveURL(/\/sign-in/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("the new password 2");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Hello, Sam" })).toBeVisible();
  await expect(page.getByTestId("verify-banner")).toHaveCount(0);
});

test("pages carry a content security policy and the API refuses a change without the anti-forgery header", async ({ page, request }) => {
  const res = await page.goto("/sign-in");
  const csp = res!.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  const forged = await request.post("/api/auth/login", { data: { email: "x@mg.test", password: "whatever password" } });
  expect(forged.status()).toBe(403);
});
