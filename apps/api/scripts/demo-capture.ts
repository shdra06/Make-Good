/// <reference lib="dom" />
// Drives the real page in Microsoft Edge through the whole recall story.
//
//   npm run test:e2e        fast: a browser test, no recording, no AI
//   npm run demo:capture    slow: with captions, a video and screenshots
//
// It starts its own server on port 4100 with a fresh in-memory database and
// the PayPal simulator, so nothing outside this machine is paid. In capture
// mode the AI steps use the model in apps/api/.env (Gemini or Claude), if set.
//
// Output (capture mode): make-good/demo/screens/*.png, make-good/demo/video/make-good-demo.mp4

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { buildApp } from "../src/api/routes.ts";
import { createContainer } from "../src/container.ts";
import { loadConfig } from "../src/platform/config.ts";
import { openDb } from "../src/platform/db/db.ts";
import { migrate } from "../src/platform/db/migrate.ts";

const fast = process.argv.includes("--fast");
const useAi = !fast && !process.argv.includes("--no-ai");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const SHOTS = path.join(REPO, "demo", "screens");
const VIDEO = path.join(REPO, "demo", "video");
const PORT = 4100;
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));

const checks: Array<{ step: string; ok: boolean; detail: string }> = [];
function check(step: string, ok: boolean, detail = ""): void {
  checks.push({ step, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${step}${detail ? `  (${detail})` : ""}`);
}
const pause = (page: Page, ms: number) => (fast ? Promise.resolve() : page.waitForTimeout(ms));

async function caption(page: Page, text: string | null, holdMs = 2500): Promise<void> {
  if (fast) return;
  await page.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      el.style.cssText = "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:9999;max-width:880px;padding:12px 20px;border-radius:12px;background:rgba(10,12,14,.88);color:#fff;font:500 18px/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.35)";
      document.body.append(el);
    }
    el.textContent = t ?? "";
    el.style.display = t ? "block" : "none";
  }, text);
  if (text) await page.waitForTimeout(holdMs);
}

let shotNo = 0;
async function shot(page: Page, name: string, selector?: string): Promise<void> {
  if (fast) return;
  await caption(page, null, 0);
  shotNo++;
  const file = path.join(SHOTS, `${String(shotNo).padStart(2, "0")}-${name}.png`);
  if (selector) await page.locator(selector).first().screenshot({ path: file });
  else await page.screenshot({ path: file });
}

async function scrollTo(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().evaluate((el) => {
    const top = el.getBoundingClientRect().top + window.scrollY - 96;
    window.scrollTo({ top, behavior: "smooth" });
  });
  await pause(page, 900);
}

const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name }).first();

async function main(): Promise<number> {
  if (!EDGE) {
    console.log("Microsoft Edge was not found.");
    return 1;
  }
  const fromFile = loadConfig();
  const config = loadConfig({ ...process.env, NODE_ENV: "development", LOG_LEVEL: "silent", PORT: String(PORT), PUBLIC_URL: `http://localhost:${PORT}` }, { readEnvFiles: false });
  const db = await openDb({ pglite: "memory" });
  await migrate(db);
  const c = await createContainer(
    { ...config, anthropicApiKey: useAi ? fromFile.anthropicApiKey : null, gemini: useAi ? fromFile.gemini : null, model: fromFile.model },
    { db, passwordCost: { N: 1024, r: 8, p: 1 } },
  );
  const { app } = buildApp(c);
  const { default: fastifyStatic } = await import("@fastify/static");
  await app.register(fastifyStatic, { root: path.join(REPO, "apps", "web", "public"), wildcard: false });
  await app.listen({ port: PORT, host: "127.0.0.1" });
  c.runner.start();
  console.log(`${fast ? "Browser test" : "Demo capture"} on http://localhost:${PORT} (PayPal simulator; AI: ${c.ai ? c.ai.model : "off"})\n`);

  if (!fast) {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.mkdirSync(VIDEO, { recursive: true });
  }
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 820 }, deviceScaleFactor: fast ? 1 : 1.5, colorScheme: "light",
    ...(fast ? {} : { recordVideo: { dir: VIDEO, size: { width: 1366, height: 820 } } }),
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const text = (selector: string) => page.locator(selector).first().innerText();

  try {
    // ---- landing ----
    await page.goto(`http://localhost:${PORT}/`);
    await page.getByText("Who is owed money").waitFor();
    await caption(page, "Make Good: who is owed money, why, how much, and what was actually paid.", 3500);
    await shot(page, "landing");
    await button(page, "Open the recall case").click();
    await page.locator("#s1").waitFor({ timeout: 60_000 });
    check("the recall case loads", (await text(".top")).includes("simulator"), "labelled as simulator and synthetic");

    // ---- 1. what went wrong ----
    await caption(page, "A supplier recalls batch B-2217 of the HM-300 mixer. PayPal knows who paid, not which batch anyone received.", 4000);
    await button(page, /^Read it/).click();
    await page.getByText("What the notice says").waitFor({ timeout: 120_000 });
    const s1 = await text("#s1");
    check("the notice is read into quoted fields", s1.includes("B-2217") && s1.includes("HM-300-EU"), c.ai ? `by ${c.ai.model}` : "by pattern rules");
    await caption(page, c.ai ? `${c.ai.model} read the notice. Every line must quote the notice word for word, or it is dropped.` : "Every line read from the notice quotes it word for word, or it is dropped.", 3500);
    await shot(page, "notice-read", "#s1");
    await button(page, "Save these rules").click();
    await page.getByText("Rules in force, version 1").waitFor();
    await caption(page, "Nothing applies until a person saves the rules, in their own name.", 2500);

    // ---- 2. who might be affected ----
    await button(page, "Find affected customers").click();
    await page.locator("#s2 .matrix").waitFor({ timeout: 60_000 });
    await scrollTo(page, "#s2");
    await caption(page, "Two separate questions for every buyer: is this their PayPal payment, and was their unit affected? No scores.", 4500);
    await shot(page, "two-questions", "#s2 .card");
    check("the table of two answers shows", (await text("#s2")).includes("Ready for approval"));

    await scrollTo(page, "#s2 table");
    if (c.ai) {
      await button(page, "Ask the AI for an opinion on these").click();
      await page.getByText("opinion (").first().waitFor({ timeout: 120_000 }).catch(() => undefined);
      await caption(page, "The AI gives an opinion on look-alike product codes. An opinion confirms nothing.", 3500);
    }
    await caption(page, "HM-3000 even carries the recalled batch number. It is a different product, and only a person can say so.", 3500);
    await shot(page, "product-codes", "#s2 table");
    const decideAlias = async (alias: string, label: string) => {
      const row = page.locator("#s2 tbody tr").filter({ has: page.locator("td:first-child b", { hasText: new RegExp(`^${alias}$`) }) });
      await row.getByRole("button", { name: label }).click();
      await row.getByText(label === "Same product" ? "same product:" : "different:").waitFor({ timeout: 30_000 });
      await pause(page, 600);
    };
    await decideAlias("HM300", "Same product");
    await decideAlias("Kestrel hand mixer HM-300 white", "Same product");
    await decideAlias("HM-3000", "Different");
    check("people decide the look-alike codes", (await text("#s2")).includes("Every look-alike product code has been decided"));

    // ---- 3. the evidence ----
    await scrollTo(page, "#s3");
    await caption(page, "The Recovery Map: every buyer, where the record stands, and why.", 3500);
    await shot(page, "recovery-map", "#s3");
    await page.locator("#s3 .row").filter({ hasText: "#5019" }).first().click();
    await page.locator(".drawer").waitFor();
    await caption(page, "Shipped the week two batches were going out. The records cannot settle it, so it is held, not paid.", 4500);
    await shot(page, "held-record-evidence", ".drawer");
    if (c.ai) {
      const answer = page.waitForResponse((r) => r.url().endsWith("/explain"), { timeout: 240_000 }).then(async (r) => `${r.status()} ${(await r.text()).slice(0, 300)}`, (e) => `no response: ${String(e.message).slice(0, 200)}`);
      await button(page, "Ask the AI to explain why this is held").click();
      console.log("        explain response:", await answer);
      const explained = await page.getByText("from the evidence above only").waitFor({ timeout: 120_000 }).then(() => true, () => false);
      const toast = explained ? "" : await page.locator(".toast").first().innerText().catch(() => "no message");
      check("the AI explains a held record", explained, explained ? c.ai.model : toast);
      await page.getByText("from the evidence above only").scrollIntoViewIfNeeded().catch(() => undefined);
      await caption(page, "The AI explains the hold, citing only the stored evidence. It changes nothing.", 3500);
      await shot(page, "held-record-ai-explanation", ".drawer");
      await page.locator(".drawer").evaluate((el) => el.scrollTo({ top: 0 }));
    }
    check("a held record shows its evidence", (await text(".drawer")).includes("points the other way"));
    await page.locator(".drawer select").selectOption("customer_confirmed_unit");
    await page.locator(".drawer textarea").fill("Customer sent a photo of the label: B-2217");
    await caption(page, "The customer sent a photo of the label. A person confirms, with the reason stored as evidence.", 3000);
    await button(page, "Confirm this customer").click();
    await page.locator(".drawer").waitFor({ state: "detached" });

    // The customer link
    await page.locator("#s3 .row").filter({ hasText: "#5020" }).first().click();
    await button(page, "Make a link to ask the customer").click();
    const link = await page.locator(".drawer input[readonly]").inputValue();
    check("a one-use customer link is made", link.includes("?confirm="));
    await page.goto(link);
    await page.getByText("One question about your order").waitFor();
    await caption(page, "Or ask the customer: a one-use link asks only for the batch code on their unit.", 3000);
    await page.locator("input").first().fill("B-2224");
    await shot(page, "customer-link");
    await button(page, "Send").click();
    await page.getByText("Thank you").waitFor();
    await caption(page, "Their answer is stored as evidence. Staff still decide.", 2500);
    await page.goto(`http://localhost:${PORT}/`);
    await page.locator("#s3").waitFor({ timeout: 60_000 });

    // Reconcile a payment
    await scrollTo(page, "#s3");
    await page.locator("#s3 .row").filter({ hasText: "#4871" }).first().click();
    await page.locator(".drawer input[type=radio]").first().waitFor();
    await caption(page, "Two PayPal payments carry this order number. A refund goes to one payment, so a person must say which.", 4000);
    await shot(page, "reconcile-payment", ".drawer");
    await page.locator(".drawer input[type=radio]").first().check();
    await page.locator(".drawer textarea").fill("Matches the PayPal receipt the customer forwarded");
    await button(page, "This payment paid for the order").click();
    await page.locator(".drawer").waitFor({ state: "detached" });

    // ---- 4 and 5. options ----
    await scrollTo(page, "#s4");
    await caption(page, "Three options, priced on the real records. Paying on the ship date alone would pay someone who was not affected.", 4500);
    await shot(page, "options", "#s4");
    check("three options are priced", (await page.locator("#s4 .policy").count()) === 3);

    // ---- 6. approval ----
    await button(page, "Build the payment list").click();
    await page.getByText("Payment list, version 1").waitFor();
    await scrollTo(page, "#s6");
    await caption(page, "One exact payment list, with a version and a hash. If anything under it changes, the approval is withdrawn.", 4000);
    await shot(page, "payment-list", "#s6 .card");
    await button(page, "Send for approval").click();
    await button(page, /^Approve exactly this list/).waitFor();
    await button(page, /^Approve exactly this list/).click();
    await button(page, "Start paying").waitFor();
    check("the list is approved", (await text("#s6")).includes("approved"));

    // ---- 7. what happened ----
    await scrollTo(page, "#s7");
    await button(page, "Lose one reply from PayPal").click();
    await caption(page, "For the demo, one reply from PayPal will be lost after PayPal has acted.", 3000);
    await button(page, "Start paying").click();
    await page.getByText("Each payment, as PayPal reports it").waitFor();
    await scrollTo(page, "#s7");
    await page.getByText("Outcome unknown: asking PayPal").first().waitFor({ timeout: 60_000 });
    await caption(page, "That payment is 'unknown', not 'failed'. It will not be sent twice.", 3500);
    await shot(page, "paying-unknown", "#s7 .card");
    await page.waitForFunction(() => {
      const s = document.querySelector("#s7")?.textContent ?? "";
      return s.includes("Differences found") && !s.includes("Outcome unknown");
    }, null, { timeout: 180_000 });
    await scrollTo(page, "#s7");
    const s7 = await text("#s7");
    check("the lost reply settles with one refund", s7.includes("The first reply was lost") && s7.includes("No second payment was made"));
    await caption(page, "Asked again with the same request ID: PayPal returned the same refund. Only PayPal-confirmed payments show as paid.", 4500);
    await shot(page, "paid", "#s7 .card");
    await scrollTo(page, "#s7 .kpis");
    check("results against the known answers", s7.includes("units called proven that were not affected"));
    await caption(page, "Checked against the known answers of the invented data: nobody wrongly proven, nothing paid twice.", 4500);
    await shot(page, "results", "#s7 .kpis");
    await scrollTo(page, "#s7 .audit");
    await caption(page, "Every decision is on an audit trail that cannot be edited.", 3500);
    await shot(page, "audit-trail", "#s7 .card:last-of-type");
    check("no errors in the page", errors.length === 0, errors.join("; "));
  } catch (err) {
    check("the walk-through finished", false, err instanceof Error ? err.message.split("\n")[0]! : String(err));
    if (!fast) await page.screenshot({ path: path.join(SHOTS, "failure.png") }).catch(() => undefined);
  }

  const video = fast ? null : page.video();
  await context.close();
  await browser.close();
  await app.close();
  await c.runner.stop();
  await db.close();

  if (video) {
    const webm = await video.path();
    const mp4 = path.join(VIDEO, "make-good-demo.mp4");
    try {
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", mp4]);
      fs.rmSync(webm, { force: true });
      console.log(`\nVideo: ${path.relative(process.cwd(), mp4)}`);
    } catch {
      console.log(`\nVideo (webm, ffmpeg not available to convert): ${path.relative(process.cwd(), webm)}`);
    }
    console.log(`Screenshots: ${path.relative(process.cwd(), SHOTS)}`);
  }
  const failed = checks.filter((x) => !x.ok).length;
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
