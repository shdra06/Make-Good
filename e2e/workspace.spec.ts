import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";

// The screens a merchant uses to set up: opening an incident, connections,
// the team and its roles, and settings.

const unique = () => Math.random().toString(36).slice(2, 10);
const PASSWORD = "correct horse battery";

async function signUp(page: Page, name: string, shop: string) {
  const email = `${name.toLowerCase()}-${unique()}@example.com`;
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Shop name").fill(shop);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return email;
}

/** A second person with their own account, in a separate browser. */
async function otherPerson(browser: Browser, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = await signUp(page, name, `${name}'s own shop`);
  return { context, page, email };
}

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name });

test("an owner opens an incident, sets its rules by hand and attaches the notice", async ({ page }) => {
  await signUp(page, "Priya", "Shah Kitchenware");
  await nav(page, "Incidents").click();
  await page.getByRole("link", { name: "Open an incident" }).click();
  await page.getByLabel("Title", { exact: true }).fill("KT-120 kettle: batch K-77 recalled");
  await page.getByLabel("What you know so far").fill("The supplier phoned on Monday.");
  await page.getByRole("button", { name: "Open the incident" }).click();

  await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}\/notice$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("KT-120 kettle: batch K-77 recalled");

  await page.getByLabel("Affected product codes").fill("KT-120");
  await page.getByLabel("Affected batch codes").fill("K-77");
  await page.getByRole("button", { name: "Save these rules" }).click();
  await expect(page.getByRole("heading", { name: "Rules in force, version 1" })).toBeVisible();

  await page.getByLabel("Notice title").fill("Supplier recall notice K-77");
  await page
    .getByLabel("Notice text")
    .fill("Kettle KT-120, batch K-77 only, may leak at the base. Customers should stop using it and will receive a full refund.");
  await page.getByRole("button", { name: "Attach the notice" }).click();
  await expect(page.getByLabel("Supplier notice")).toContainText("batch K-77 only");

  await nav(page, "Dashboard").click();
  await expect(page.getByRole("cell", { name: /KT-120 kettle/ })).toBeVisible();
});

test("an owner connects the simulator, adds a store and imports its orders", async ({ page }) => {
  await signUp(page, "Omar", "Omar Home Goods");
  await nav(page, "Connections").click();
  await expect(page.getByText("No PayPal account is connected.")).toBeVisible();
  await page.getByRole("button", { name: "Use the built-in simulator instead" }).click();
  await expect(page.getByTestId("paypal-connection")).toContainText("Built-in simulator");
  await expect(page.getByTestId("paypal-connection")).toContainText("connected");

  await page.getByLabel("Add a store").fill("Main web shop");
  await page.getByRole("button", { name: "Add store" }).click();
  await expect(page.getByTestId("stores")).toContainText("Main web shop");

  await page.getByTestId("csv-upload").locator("summary").click();
  await page.getByLabel("Order file").setInputFiles(path.resolve("demo", "sample-orders.csv"));
  await expect(page.getByTestId("csv-result")).toContainText("3 rows, 2 orders");
  await page.getByRole("button", { name: "Import 2 orders" }).click();
  await expect(page.getByTestId("csv-result")).toContainText("imported (2 new");
  await expect(page.getByTestId("stores").getByRole("cell", { name: "2", exact: true })).toBeVisible();
});

test("an owner adds a teammate, changes their role, and the teammate sees only what the role allows", async ({ page, browser }) => {
  await signUp(page, "Lena", "Lena Kitchen");
  const mate = await otherPerson(browser, "Tomas");

  await nav(page, "Team").click();
  await page.getByLabel("Their email").fill(mate.email);
  await page.getByLabel("Role", { exact: true }).selectOption("reviewer");
  await page.getByRole("button", { name: "Add to the team" }).click();
  await expect(page.getByTestId("members")).toContainText(mate.email);
  await page.getByLabel("Role of Tomas").selectOption("viewer");
  await expect(page.getByText("Tomas is now viewer.")).toBeVisible();

  // An unknown email is refused with the API's own words
  await page.getByLabel("Their email").fill(`nobody-${unique()}@example.com`);
  await page.getByRole("button", { name: "Add to the team" }).click();
  await expect(page.getByText("No account uses that email yet.")).toBeVisible();

  // Settings: two approvals and the four-eyes rule
  await nav(page, "Settings").click();
  await page.getByLabel("Four-eyes rule").check();
  await page.getByLabel("Approvals needed for a payment list").selectOption("2");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Approvals needed for a payment list")).toHaveValue("2");
  await expect(page.getByLabel("Four-eyes rule")).toBeChecked();

  // The teammate's own workspace is theirs; Lena's is listed second. Check what a viewer sees there.
  const m = mate.page;
  await m.reload();
  await m.getByLabel("Workspace").selectOption({ label: "Lena Kitchen" });
  await expect(m.getByText("Viewer", { exact: true })).toBeVisible();
  await nav(m, "Settings").click();
  await expect(m.getByText("Only an owner or admin can change settings.")).toBeVisible();
  await expect(m.getByRole("button", { name: "Save settings" })).toHaveCount(0);
  await expect(m.getByLabel("Approvals needed for a payment list")).toHaveValue("2");
  await nav(m, "Team").click();
  await expect(m.getByText("Only an owner or admin can change the team.")).toBeVisible();
  const lenaOrg = await m.evaluate(async () => {
    const me = await (await fetch("/api/me")).json();
    return me.organisations.find((o: { name: string }) => o.name === "Lena Kitchen")?.orgId as string | undefined;
  });
  expect(lenaOrg).toBeTruthy();
  const settings = await m.evaluate(
    async (id) => (await fetch(`/api/orgs/${id}/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" })).status,
    lenaOrg,
  );
  expect(settings, "a viewer cannot change settings").toBe(403);
  await mate.context.close();
});
