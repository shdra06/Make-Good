// Verifies Make Good against the REAL PayPal sandbox. No simulator anywhere.
//
//   npm run sandbox             create test payments, then run everything
//   npm run sandbox -- resume   continue after you approved payments by hand
//
// It reads PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from apps/api/.env or,
// failing that, from the repository's root .env. Only sandbox hosts are used.
//
// What it does, in order:
//   1. Signs in and lists the permissions PayPal granted this app.
//   2. Creates real sandbox payments (by test card; if the account cannot take
//      cards, it prints approval links and stops until you approve them).
//   3. Runs the product end to end on those payments: orders, payment lookup,
//      incident, match, batch, approval, refunds through the worker.
//      One reply is thrown away on purpose after PayPal has acted.
//   4. Asks PayPal directly what happened, and proves each payment was
//      refunded exactly once.
//   5. Probes how PayPal refuses bad refunds, and records the real error names.
//   6. Tries Transaction Search and the disputes list.
//
// Every line it prints is something PayPal answered. Results are also written
// to apps/api/.data/sandbox-verification.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContainer } from "../src/container.ts";
import { loadConfig } from "../src/platform/config.ts";
import { openDb } from "../src/platform/db/db.ts";
import { migrate } from "../src/platform/db/migrate.ts";
import { JobRunner } from "../src/platform/jobs/queue.ts";
import { fromMinor, toMinor } from "../src/platform/money.ts";
import { OrderImport, upsertOrder } from "../src/modules/commerce/ingest.ts";
import { createBatch, decideBatch, previewBatch, startBatch, submitBatch } from "../src/modules/execution/batches.ts";
import { OperationExecutor } from "../src/modules/execution/executor.ts";
import { createOrganisation, registerUser } from "../src/modules/identity/service.ts";
import { addRuleVersion, createIncident, runIncidentMatch } from "../src/modules/incidents/service.ts";
import { ProviderError } from "../src/modules/paypal/provider.ts";
import { PayPalRestClient } from "../src/modules/paypal/rest-client.ts";
import { FaultInjectingProvider } from "../src/modules/paypal/simulator.ts";
import { lookupPaymentsByReference } from "../src/modules/transactions/sync.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, "..");
const STATE_FILE = path.join(API_ROOT, ".data", "sandbox-state.json");
const RESULT_FILE = path.join(API_ROOT, ".data", "sandbox-verification.json");
const SANDBOX = "https://api-m.sandbox.paypal.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now().toString(36).toUpperCase();

type Line = { step: string; ok: boolean | null; detail: string };
const lines: Line[] = [];
const facts: Record<string, unknown> = {};

function say(step: string, ok: boolean | null, detail = ""): void {
  lines.push({ step, ok, detail });
  console.log(`  ${ok === null ? "note" : ok ? "ok  " : "FAIL"} ${step}${detail ? `  (${detail})` : ""}`);
}

function describe(err: unknown): string {
  if (err instanceof ProviderError) return `${err.kind} ${err.httpStatus ?? ""} ${err.issue ?? ""}`.trim();
  return err instanceof Error ? err.message : String(err);
}

/** Reads two values from an env file without loading the rest into this process. */
function readKeys(): { clientId: string; clientSecret: string; from: string } | null {
  for (const file of [path.join(API_ROOT, ".env"), path.resolve(API_ROOT, "..", "..", ".env")]) {
    if (!fs.existsSync(file)) continue;
    const values: Record<string, string> = {};
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      const eq = line.indexOf("=");
      if (!line || line.startsWith("#") || eq < 1) continue;
      values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
    const clientId = values.PAYPAL_SANDBOX_CLIENT_ID || values.PAYPAL_CLIENT_ID;
    const clientSecret = values.PAYPAL_SANDBOX_CLIENT_SECRET || values.PAYPAL_CLIENT_SECRET;
    if (clientId && clientSecret) return { clientId, clientSecret, from: path.relative(path.resolve(API_ROOT, "..", ".."), file) || ".env" };
  }
  return null;
}

// ---------- creating test payments (only this script does this; the product never takes payments) ----------

let cachedToken: string | null = null;
async function rawCall(keys: { clientId: string; clientSecret: string }, method: string, urlPath: string, body?: unknown, requestId?: string) {
  if (!cachedToken) {
    const res = await fetch(`${SANDBOX}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${keys.clientId}:${keys.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    cachedToken = ((await res.json()) as { access_token?: string }).access_token ?? null;
    if (!cachedToken) throw new Error(`token request failed with ${res.status}`);
  }
  const res = await fetch(`${SANDBOX}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${cachedToken}`, "Content-Type": "application/json", Prefer: "return=representation", ...(requestId ? { "PayPal-Request-Id": requestId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: res.status, ok: res.ok, data, issue: data?.details?.[0]?.issue ?? data?.name ?? null, debugId: data?.debug_id ?? res.headers.get("paypal-debug-id") };
}

function purchaseUnit(invoiceId: string, cents: number, quantity: number) {
  const value = fromMinor(cents * quantity, "USD");
  return {
    reference_id: "default",
    invoice_id: invoiceId,
    description: "Make Good sandbox verification",
    amount: { currency_code: "USD", value, breakdown: { item_total: { currency_code: "USD", value } } },
    items: [{ name: "Hand mixer HM-300", sku: "HM-300", quantity: String(quantity), unit_amount: { currency_code: "USD", value: fromMinor(cents, "USD") } }],
  };
}

/** PayPal's published sandbox test card numbers. Tried in order. */
const TEST_CARDS = ["4032039317984658", "4111111111111111", "4012888888881881"];

async function payByCard(keys: { clientId: string; clientSecret: string }, invoiceId: string, cents: number, quantity: number) {
  let last = "";
  for (const number of TEST_CARDS) {
    const res = await rawCall(keys, "POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [purchaseUnit(invoiceId, cents, quantity)],
      payment_source: {
        card: {
          number, expiry: "2030-12", security_code: "123", name: "Test Buyer",
          billing_address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
        },
      },
    }, `mg-seed-${invoiceId}-${number.slice(-4)}`);
    const capture = res.data?.purchase_units?.[0]?.payments?.captures?.[0];
    if (res.ok && capture?.id && capture.status === "COMPLETED") return { captureId: capture.id as string, orderId: res.data.id as string };
    last = `${res.status} ${res.issue ?? ""} ${capture?.status ?? res.data?.status ?? ""}`.trim();
  }
  throw new Error(last || "card payment was not completed");
}

type Seed = { invoiceId: string; cents: number; quantity: number; orderId?: string; captureId?: string; approveUrl?: string };

async function seedPayments(keys: { clientId: string; clientSecret: string }, resume: boolean): Promise<Seed[] | null> {
  if (resume) {
    if (!fs.existsSync(STATE_FILE)) throw new Error("Nothing to resume: run without 'resume' first.");
    const seeds = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Seed[];
    for (const seed of seeds) {
      if (seed.captureId) continue;
      const res = await rawCall(keys, "POST", `/v2/checkout/orders/${seed.orderId}/capture`, undefined, `mg-cap-${seed.orderId}`);
      const capture = res.data?.purchase_units?.[0]?.payments?.captures?.[0];
      if (!res.ok || !capture?.id) {
        say(`capture approved order ${seed.orderId}`, false, `${res.status} ${res.issue ?? ""}: has it been approved?`);
        return null;
      }
      seed.captureId = capture.id;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(seeds, null, 2));
    say("capture the payments you approved", true, seeds.map((s) => s.captureId).join(", "));
    return seeds;
  }

  const seeds: Seed[] = [
    { invoiceId: `MG-${stamp}-1`, cents: 5900, quantity: 1 },
    { invoiceId: `MG-${stamp}-2`, cents: 5900, quantity: 1 },
    { invoiceId: `MG-${stamp}-3`, cents: 5900, quantity: 2 },
    { invoiceId: `MG-${stamp}-P`, cents: 1000, quantity: 1 }, // for probing refusals
  ];
  try {
    for (const seed of seeds) Object.assign(seed, await payByCard(keys, seed.invoiceId, seed.cents, seed.quantity));
    say("create 4 sandbox payments by test card", true, seeds.map((s) => s.captureId).join(", "));
    facts.seedMethod = "test card through the Orders API";
    return seeds;
  } catch (err) {
    say("create sandbox payments by test card", null, `not possible on this account: ${describe(err)}`);
  }

  // The account cannot take cards directly. Fall back to PayPal-wallet payments that a person approves.
  for (const seed of seeds) {
    const res = await rawCall(keys, "POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [purchaseUnit(seed.invoiceId, seed.cents, seed.quantity)],
      payment_source: { paypal: { experience_context: { brand_name: "Make Good test shop", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", return_url: "https://example.com/approved", cancel_url: "https://example.com/cancelled" } } },
    }, `mg-seed-${seed.invoiceId}`);
    const link = (res.data?.links ?? []).find((l: any) => l.rel === "payer-action" || l.rel === "approve");
    if (!res.ok || !link) {
      say("create a sandbox order for approval", false, `${res.status} ${res.issue ?? ""}`);
      return null;
    }
    seed.orderId = res.data.id;
    seed.approveUrl = link.href;
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(seeds, null, 2));
  facts.seedMethod = "PayPal wallet, approved by hand";
  console.log("\n  This sandbox account cannot take card payments directly, so the test payments need approving.");
  console.log("  Open each link, log in with a sandbox PERSONAL (buyer) account, and approve:\n");
  for (const seed of seeds) console.log(`    ${fromMinor(seed.cents * seed.quantity, "USD")} USD  ${seed.approveUrl}`);
  console.log("\n  Then run:  npm run sandbox -- resume\n");
  return null;
}

/** Cancels an unclaimed payout item, trying a few times: the sandbox sometimes needs a moment. */
async function cancelPayoutItem(keys: { clientId: string; clientSecret: string }, itemId: string): Promise<{ ok: boolean; detail: string }> {
  let detail = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    // First with no body, as the reference shows; then with an empty JSON body, in case the sandbox wants one.
    const res = await rawCall(keys, "POST", `/v1/payments/payouts-item/${encodeURIComponent(itemId)}/cancel`, attempt === 1 ? undefined : {});
    detail = `PayPal answered ${res.status} ${res.data?.transaction_status ?? res.issue ?? ""}`.trim();
    if (res.ok) return { ok: true, detail };
    if (res.status < 500) break;
    await sleep(5000);
  }
  return { ok: false, detail };
}

// ---------- the run ----------

async function main(): Promise<number> {
  const resume = process.argv.includes("resume");
  console.log("Make Good: verification against the PayPal sandbox\n");
  const keys = readKeys();
  if (!keys) {
    say("find PayPal sandbox keys", false, "set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the repository's .env");
    return 1;
  }
  say("find PayPal sandbox keys", true, `from ${keys.from}`);

  // npm run sandbox -- cancel-payout <payout item id>: tidy up a test payout left unclaimed by an earlier run.
  const cancelIndex = process.argv.indexOf("cancel-payout");
  if (cancelIndex !== -1) {
    const itemId = process.argv[cancelIndex + 1] ?? "";
    const cancel = await cancelPayoutItem(keys, itemId);
    say(`cancel unclaimed payout item ${itemId}`, cancel.ok ? true : null, cancel.detail);
    return cancel.ok ? 0 : 1;
  }
  const paypal = new PayPalRestClient({ environment: "sandbox", clientId: keys.clientId, clientSecret: keys.clientSecret });

  console.log("\n1. Sign-in and permissions");
  let scopes: string[] = [];
  try {
    scopes = (await paypal.verifyCredentials()).scopes;
    say("PayPal accepts the keys", true, `${scopes.length} permissions granted`);
  } catch (err) {
    say("PayPal accepts the keys", false, describe(err));
    return 1;
  }
  const has = (needle: string) => scopes.some((s) => s.endsWith(needle));
  const granted = {
    refunds: has("/services/payments/refund"),
    transactionSearch: has("/services/reporting/search/read"),
    payouts: has("/payments/payouts"),
    disputesRead: has("/services/disputes/read-seller"),
    webhooks: has("/services/applications/webhooks"),
    partnerReferrals: has("/services/customer/partner-referrals/readwrite"),
  };
  facts.granted = granted;
  for (const [name, yes] of Object.entries(granted)) say(`permission: ${name}`, yes ? true : null, yes ? "granted" : "not granted to this app");

  console.log("\n2. Test payments");
  const seeds = await seedPayments(keys, resume);
  if (!seeds) return 2;
  const [s1, s2, s3, probe] = seeds as [Seed, Seed, Seed, Seed];
  facts.captures = seeds.map((s) => ({ invoiceId: s.invoiceId, captureId: s.captureId, amount: fromMinor(s.cents * s.quantity, "USD") }));

  console.log("\n3. The product, end to end, on those payments");
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }, { readEnvFiles: false });
  // A fresh database in memory, so this run never touches the development server's data.
  const db = await openDb({ pglite: "memory" });
  await migrate(db);
  const c = await createContainer(config, { db, passwordCost: { N: 1024, r: 8, p: 1 } });
  const user = await registerUser(c.identity, { email: `verify-${stamp.toLowerCase()}@example.com`, password: `verify ${stamp} password`, name: "Sandbox Verify" });
  const org = await createOrganisation(c.identity, { name: `Sandbox ${stamp}`, defaultCurrency: "USD", userId: user.id });
  const conn = await c.connections.connectFirstParty(org.id, user.id, { environment: "sandbox", clientId: keys.clientId, clientSecret: keys.clientSecret });
  say("connect the organisation to PayPal", conn.status === "connected", `status ${conn.status}, environment ${conn.environment}${conn.lastError ? `, ${conn.lastError}` : ""}`);
  if (conn.status !== "connected") return 1;

  const [store] = await c.db.query<{ id: string }>("insert into commerce_connections (org_id, kind, name) values ($1, 'custom', 'Sandbox test shop') returning id", [org.id]);
  for (const seed of [s1, s2, s3]) {
    const total = fromMinor(seed.cents * seed.quantity, "USD");
    await c.db.tx((tx) => upsertOrder(tx, org.id, store!.id, OrderImport.parse({
      externalId: seed.invoiceId, orderNumber: seed.invoiceId, placedAt: new Date().toISOString(), currency: "USD",
      customer: { email: `buyer-${seed.invoiceId.toLowerCase()}@example.com`, name: "Test Buyer" },
      paymentMethod: "paypal", paymentReference: seed.captureId, total,
      lines: [{ externalId: "1", sku: "HM-300", title: "Hand mixer HM-300", quantity: seed.quantity, unitPrice: fromMinor(seed.cents, "USD") }],
      fulfilments: [{ externalId: "1", shippedAt: new Date().toISOString(), lines: [{ lineExternalId: "1", quantity: seed.quantity, batchCode: "LOT-24B" }] }],
    })));
  }
  const provider = await c.connections.resolve(org.id, conn.id);
  const looked = await lookupPaymentsByReference(c.deps, { orgId: org.id, connectionId: conn.id, provider });
  say("fetch the 3 payments from PayPal by ID and link them to orders", looked.found === 3, `found ${looked.found} of ${looked.looked}${looked.notFound.length ? `, not found: ${looked.notFound.join(", ")}` : ""}`);

  const incident = await createIncident(c.deps, { orgId: org.id, userId: user.id, kind: "recall", title: "HM-300 batch LOT-24B overheats", description: "Sandbox verification" });
  await addRuleVersion(c.deps, {
    orgId: org.id, incidentId: incident.id, userId: user.id,
    scope: { type: "product", skus: ["HM-300"], batchCodes: ["LOT-24B"], serials: [], orderedFrom: null, orderedTo: null, shippedFrom: null, shippedTo: null, warehouses: [] },
    // Half of each payment, so that "refunded twice" would be visible as a fully refunded payment.
    compensation: { type: "percent", percentBps: 5000, includeTax: true, includeShipping: false, minMinor: null, maxMinor: null, rounding: "half_up", allowPayout: false, refundWindowDays: 180 },
  });
  const match = await runIncidentMatch(c.deps, { orgId: org.id, incidentId: incident.id, userId: user.id, payoutsAvailable: false });
  say("match affected customers", match.autoConfirmed === 3, JSON.stringify(match.stats.byClassification));
  const preview = await previewBatch(c.db, org.id, incident.id);
  say("dry run", preview.totals.count === 3, `${preview.totals.count} refunds, ${fromMinor(preview.totals.byCurrency.USD?.amountMinor ?? 0, "USD")} USD in total; nothing sent`);

  const batch = await createBatch(c.deps, { orgId: org.id, incidentId: incident.id, userId: user.id, name: "Sandbox verification" });
  await submitBatch(c.deps, { orgId: org.id, batchId: batch.id, userId: user.id });
  const decided = await decideBatch(c.deps, { orgId: org.id, batchId: batch.id, userId: user.id, role: "owner", decision: "approve", comment: "sandbox verification" });
  say("approve the batch", decided.status === "approved");

  // The worker, with one deliberate fault: the first refund goes through at PayPal and its reply is discarded.
  const faulty = new FaultInjectingProvider(provider);
  faulty.dropNextReplies(1);
  const executor = new OperationExecutor({ db: c.db, clock: c.clock, providers: async () => faulty });
  const runner = new JobRunner(c.db, executor.handlers(), { workerId: "sandbox-verify", clock: c.clock, concurrency: 1 });
  await startBatch(c.deps, { orgId: org.id, batchId: batch.id, userId: user.id, spacingMs: 1500 });
  const deadline = Date.now() + 4 * 60_000;
  let status = "executing";
  let sawUnknown = false;
  while (Date.now() < deadline) {
    const ran = await runner.runOnce();
    const states = await c.db.query<{ state: string }>("select state from payment_operations where batch_id = $1", [batch.id]);
    if (states.some((s) => s.state === "unknown") && !sawUnknown) {
      sawUnknown = true;
      console.log("  ...   one refund has no answer (reply discarded on purpose). It is now marked unknown, not failed. Waiting for the lookup.");
    }
    status = (await c.db.query<{ status: string }>("select status from batches where id = $1", [batch.id]))[0]!.status;
    if (status !== "executing") break;
    if (ran === 0) await sleep(1000);
  }
  const ops = await c.db.query<{ id: string; state: string; capture_id: string; amount_minor: number; provider_refund_id: string | null; attempts: number; idempotency_key: string; failure_code: string | null }>(
    "select id, state, capture_id, amount_minor, provider_refund_id, attempts, idempotency_key, failure_code from payment_operations where batch_id = $1 order by created_at, id",
    [batch.id],
  );
  say("the worker finishes the batch", status === "completed", `batch ${status}; ${ops.filter((o) => o.state === "succeeded").length} of ${ops.length} refunds succeeded`);
  for (const op of ops) {
    say(`refund for payment ${op.capture_id}`, op.state === "succeeded", `${op.state}, ${fromMinor(op.amount_minor, "USD")} USD, PayPal refund ${op.provider_refund_id ?? "-"}, ${op.attempts} call(s)${op.failure_code ? `, ${op.failure_code}` : ""}`);
  }
  facts.refunds = ops.map((o) => ({ captureId: o.capture_id, refundId: o.provider_refund_id, amount: fromMinor(o.amount_minor, "USD"), calls: o.attempts, state: o.state }));

  console.log("\n4. Recovery: the discarded reply");
  const dropped = faulty.injected[0];
  if (!dropped) {
    say("a reply was discarded after PayPal acted", false, "the fault was never triggered");
  } else {
    const op = ops.find((o) => o.idempotency_key === dropped.requestId);
    say("a reply was discarded after PayPal acted", true, `PayPal had created refund ${dropped.providerId}`);
    say("the operation went to 'unknown', not 'failed'", sawUnknown);
    say("asking PayPal again with the same request ID returned the SAME refund", op?.provider_refund_id === dropped.providerId, `first ${dropped.providerId}, after recovery ${op?.provider_refund_id}`);
    const items = await c.db.query<{ kind: string; status: string }>("select kind, status from reconciliation_items where operation_id = $1", [op?.id]);
    say("a reconciliation record explains what happened", items.some((i) => i.kind === "unknown_resolved_succeeded"), JSON.stringify(items));
    facts.recovery = { requestId: dropped.requestId, refundAtPayPal: dropped.providerId, refundAfterRecovery: op?.provider_refund_id, calls: op?.attempts };
  }

  console.log("\n5. Asking PayPal directly: was each payment refunded exactly once?");
  for (const op of ops) {
    try {
      const refund = await paypal.getRefund(op.provider_refund_id!);
      const capture = await paypal.getCapture(op.capture_id);
      say(`PayPal's record of refund ${refund.id}`, refund.status === "COMPLETED" && toMinor(refund.amount.value, "USD") === op.amount_minor, `${refund.status}, ${refund.amount.value} ${refund.amount.currency_code}; payment is ${capture.status}`);
      // Refund whatever is left. If our refund had happened twice, nothing would be left.
      const rest = await paypal.refundCapture(op.capture_id, { requestId: `mg-verify-rest-${op.id}` });
      const expected = toMinor(capture.amount.value, "USD") - op.amount_minor;
      say(`what was left on ${op.capture_id}`, toMinor(rest.amount.value, "USD") === expected, `${rest.amount.value} USD left and now refunded; expected ${fromMinor(expected, "USD")}. So exactly one refund of ${fromMinor(op.amount_minor, "USD")} had been made.`);
    } catch (err) {
      say(`check payment ${op.capture_id} at PayPal`, false, describe(err));
    }
  }

  console.log("\n6. How PayPal refuses bad refunds (real error names)");
  const refusals: Record<string, string> = {};
  const refuse = async (label: string, fn: () => Promise<unknown>) => {
    try {
      const out = (await fn()) as { id?: string; status?: string; amount?: { value: string } };
      refusals[label] = `ACCEPTED ${out?.id ?? ""} ${out?.status ?? ""} ${out?.amount?.value ?? ""}`.trim();
      say(label, null, `PayPal accepted it: ${refusals[label]}`);
    } catch (err) {
      refusals[label] = describe(err);
      say(label, err instanceof ProviderError && err.kind === "rejected" ? true : null, `PayPal answered: ${describe(err)}`);
    }
  };
  const cap = probe.captureId!;
  const usd = (value: string) => ({ currency_code: "USD", value });
  const first = await paypal.refundCapture(cap, { requestId: `mg-probe-a-${stamp}`, amount: usd("4.00") });
  say("partial refund of 4.00 on a 10.00 payment", first.status === "COMPLETED" || first.status === "PENDING", `${first.id} ${first.status}`);
  const again = await paypal.refundCapture(cap, { requestId: `mg-probe-a-${stamp}`, amount: usd("4.00") }).catch((e) => e);
  say("same request ID, same amount, sent again", !(again instanceof Error) && again.id === first.id, again instanceof Error ? describe(again) : `returned ${again.id} (first was ${first.id})`);
  await refuse("same request ID with a different amount", () => paypal.refundCapture(cap, { requestId: `mg-probe-a-${stamp}`, amount: usd("1.00") }));
  await refuse("more than what is left (7.00 of 6.00)", () => paypal.refundCapture(cap, { requestId: `mg-probe-b-${stamp}`, amount: usd("7.00") }));
  await refuse("a different currency (EUR on a USD payment)", () => paypal.refundCapture(cap, { requestId: `mg-probe-c-${stamp}`, amount: { currency_code: "EUR", value: "1.00" } }));
  await refuse("too many decimal places (1.005)", () => paypal.refundCapture(cap, { requestId: `mg-probe-d-${stamp}`, amount: usd("1.005") }));
  const rest = await paypal.refundCapture(cap, { requestId: `mg-probe-e-${stamp}` }).catch((e) => e);
  say("full refund of the rest", !(rest instanceof Error), rest instanceof Error ? describe(rest) : `${rest.amount.value} USD`);
  await refuse("a refund on a fully refunded payment", () => paypal.refundCapture(cap, { requestId: `mg-probe-f-${stamp}`, amount: usd("1.00") }));
  await refuse("a refund on a payment ID that does not exist", () => paypal.refundCapture("0AA00000AA000000A", { requestId: `mg-probe-g-${stamp}`, amount: usd("1.00") }));
  await refuse("looking up a payment ID that does not exist", () => paypal.getCapture("0AA00000AA000000A"));
  facts.refusals = refusals;

  console.log("\n7. Transaction Search and disputes");
  try {
    const page = await paypal.searchTransactions({ start: new Date(Date.now() - 2 * 86_400_000).toISOString(), end: new Date().toISOString(), page: 1, pageSize: 100 });
    const ours = page.transactions.filter((t) => seeds.some((s) => s.captureId === t.transaction_id)).length;
    say("Transaction Search answers", true, `${page.totalItems} transactions in the last 2 days; ${ours} of our 4 new payments are visible yet (PayPal says new ones can take up to 3 hours); last refreshed ${page.lastRefreshedAt ?? "unknown"}`);
    facts.transactionSearch = { totalItems: page.totalItems, oursVisible: ours, lastRefreshedAt: page.lastRefreshedAt, sampleEventCodes: [...new Set(page.transactions.map((t) => t.event_code))].slice(0, 8) };
  } catch (err) {
    say("Transaction Search answers", null, `PayPal answered: ${describe(err)}`);
    facts.transactionSearch = { error: describe(err) };
  }
  try {
    const disputes = await paypal.listDisputesForTransaction(s1.captureId!);
    say("disputes list answers", true, `${disputes.length} dispute(s) on payment ${s1.captureId}`);
    facts.disputes = { count: disputes.length };
  } catch (err) {
    say("disputes list answers", null, `PayPal answered: ${describe(err)}`);
    facts.disputes = { error: describe(err) };
  }
  console.log("\n8. Payouts");
  if (!granted.payouts) {
    say("payouts", null, "not run: PayPal has not granted this app the payouts permission");
  } else {
    // A payout of 1.00 to an address that has no PayPal account. PayPal holds it as
    // UNCLAIMED, which exercises create, read and the duplicate rule, and then it is cancelled.
    const senderBatchId = `mg-probe-payout-${stamp}`;
    const item = { senderItemId: `probe-${stamp}`, recipientType: "EMAIL" as const, receiver: `mg-unclaimed-${stamp.toLowerCase()}@example.com`, amount: usd("1.00"), note: "Make Good sandbox verification" };
    try {
      const created = await paypal.createPayout({ senderBatchId, emailSubject: "Make Good sandbox verification", items: [item] });
      let seen = await paypal.getPayoutBatch(created.payout_batch_id);
      for (let i = 0; i < 10 && (seen.batch_status === "PENDING" || seen.batch_status === "PROCESSING"); i++) {
        await sleep(3000);
        seen = await paypal.getPayoutBatch(created.payout_batch_id);
      }
      const first = seen.items[0];
      say("create a payout and read it back", true, `batch ${seen.payout_batch_id} is ${seen.batch_status}; item ${first?.payout_item_id ?? "-"} is ${first?.transaction_status ?? "-"}${first?.error_name ? ` (${first.error_name})` : ""}`);
      facts.payout = { batchId: seen.payout_batch_id, batchStatus: seen.batch_status, itemStatus: first?.transaction_status, itemError: first?.error_name };
      try {
        const repeat = await paypal.createPayout({ senderBatchId, emailSubject: "Make Good sandbox verification", items: [item] });
        say("the same payout sent again", repeat.payout_batch_id === seen.payout_batch_id, `PayPal returned batch ${repeat.payout_batch_id} (first was ${seen.payout_batch_id})`);
        (facts.payout as Record<string, unknown>).repeat = `returned ${repeat.payout_batch_id}`;
      } catch (err) {
        const links = JSON.stringify((err as ProviderError).body ?? {});
        const pointsBack = links.includes(seen.payout_batch_id);
        say("the same payout sent again", err instanceof ProviderError && err.kind === "rejected", `PayPal refused: ${describe(err)}; the refusal ${pointsBack ? "names" : "does not name"} the original payout`);
        (facts.payout as Record<string, unknown>).repeat = `${describe(err)}; names original: ${pointsBack}`;
      }
      if (first?.transaction_status === "UNCLAIMED" && first.payout_item_id) {
        // Tidying up after the probe. Not something the product does.
        const cancel = await cancelPayoutItem(keys, first.payout_item_id);
        say("tidy up: cancel the unclaimed test payout", cancel.ok ? true : null, cancel.ok ? cancel.detail : `${cancel.detail}. Sandbox money only; PayPal returns an unclaimed payout by itself after 30 days.`);
        (facts.payout as Record<string, unknown>).cancel = cancel.detail;
      }
    } catch (err) {
      say("create a payout", null, `PayPal answered: ${describe(err)}`);
      facts.payout = { error: describe(err) };
    }
  }
  say("webhook signature check", null, "not run: needs a registered webhook and a public address");

  const failed = lines.filter((l) => l.ok === false).length;
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ at: new Date().toISOString(), environment: "sandbox", failed, facts, lines }, null, 2));
  console.log(`\n${failed === 0 ? "No check failed." : `${failed} check(s) failed.`} Results saved to .data/sandbox-verification.json`);
  await c.db.close();
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error("Stopped:", describe(err));
  process.exit(1);
});
