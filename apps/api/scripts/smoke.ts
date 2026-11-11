// An end-to-end check against a RUNNING server, over real HTTP.
//
//   npm run smoke                       against http://localhost:4000
//   npm run smoke -- http://host:port   against another address
//
// It registers a fresh user and organisation, connects the built-in PayPal
// SIMULATOR, loads sample data, and walks three scenarios: a recall, a billing
// error found by monitoring, and currency exposure with live reference rates.
// No real PayPal call is made. Every line it prints is something it observed.

const base = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
let cookie = "";
let failures = 0;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // leave as text
  }
  return { status: res.status, body: parsed };
}

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const money = (minor: number, currency: string) => `${currency} ${(minor / (currency === "JPY" ? 1 : 100)).toFixed(currency === "JPY" ? 0 : 2)}`;

async function waitForBatch(org: string, batchId: string): Promise<any> {
  for (let i = 0; i < 60; i++) {
    const res = await call("GET", `/api/orgs/${org}/batches/${batchId}`);
    if (["completed", "completed_with_failures", "paused"].includes(res.body.batch.status)) return res.body;
    await sleep(1000);
  }
  return (await call("GET", `/api/orgs/${org}/batches/${batchId}`)).body;
}

async function main(): Promise<void> {
  console.log(`Make Good smoke test against ${base}\n`);
  const health = await call("GET", "/api/health");
  check("server is up", health.status === 200, `database: ${health.body?.database}`);

  const stamp = Date.now().toString(36);
  const reg = await call("POST", "/api/auth/register", { email: `smoke-${stamp}@example.com`, password: `smoke test ${stamp} password`, name: "Smoke Test" });
  check("register and sign in", reg.status === 200);
  const org = (await call("POST", "/api/orgs", { name: `Smoke Shop ${stamp}` })).body.id as string;
  check("create organisation", typeof org === "string");

  const conn = await call("POST", `/api/orgs/${org}/paypal/simulator`);
  check("connect the PayPal simulator", conn.body?.environment === "simulator", "no real PayPal calls in this run");
  const seed = await call("POST", `/api/orgs/${org}/demo/seed`);
  check("load sample data", seed.status === 200, `${seed.body?.orders} orders, ${seed.body?.payments} payments`);

  console.log("\nScenario A: manufacturing recall");
  const incident = (await call("POST", `/api/orgs/${org}/incidents`, { kind: "recall", title: "HM-300 batch LOT-24B overheats" })).body.id;
  await call("POST", `/api/orgs/${org}/incidents/${incident}/rules`, {
    scope: { type: "product", skus: ["HM-300"], batchCodes: ["LOT-24B"] },
    compensation: { type: "full_refund" },
  });
  const match = await call("POST", `/api/orgs/${org}/incidents/${incident}/match`);
  check("match affected customers", match.status === 200, JSON.stringify(match.body?.stats?.byClassification));
  const preview = await call("GET", `/api/orgs/${org}/incidents/${incident}/preview`);
  const totals = Object.entries(preview.body.totals.byCurrency as Record<string, { count: number; amountMinor: number }>)
    .map(([c, v]) => `${v.count} x ${money(v.amountMinor, c)}`).join(", ");
  check("dry run moves no money", preview.status === 200, `${preview.body.totals.count} payable: ${totals}; not included: ${JSON.stringify(preview.body.notIncluded)}`);
  const batch = (await call("POST", `/api/orgs/${org}/incidents/${incident}/batches`, { name: "Recall LOT-24B" })).body.id;
  await call("POST", `/api/orgs/${org}/batches/${batch}/submit`);
  const approved = await call("POST", `/api/orgs/${org}/batches/${batch}/decision`, { decision: "approve", comment: "smoke test" });
  check("approve the batch", approved.body?.status === "approved");
  const started = await call("POST", `/api/orgs/${org}/batches/${batch}/start`);
  check("start paying", started.status === 200, `${started.body?.queued} operations queued`);
  const done = await waitForBatch(org, batch);
  const succeeded = done.operations.filter((o: any) => o.state === "succeeded").length;
  check("worker finishes the batch", done.batch.status === "completed", `${succeeded} of ${done.totalOperations} succeeded, e.g. refund ${done.operations[0]?.provider_refund_id}`);

  console.log("\nScenario C: billing error found by monitoring");
  const run = await call("POST", `/api/orgs/${org}/detections/run`);
  const findings = (await call("GET", `/api/orgs/${org}/detections?status=open`)).body.findings;
  const dup = findings.filter((f: any) => f.detector === "duplicate_charge");
  check("detect double charges", dup.length > 0, `${dup.length} found; ${run.body?.raised} new`);
  if (dup.length > 0) {
    const converted = await call("POST", `/api/orgs/${org}/detections/${dup[0].id}/convert`);
    const id = converted.body.incidentId;
    const m = await call("POST", `/api/orgs/${org}/incidents/${id}/match`);
    const b = (await call("POST", `/api/orgs/${org}/incidents/${id}/batches`, { name: "Double charges" })).body.id;
    await call("POST", `/api/orgs/${org}/batches/${b}/submit`);
    await call("POST", `/api/orgs/${org}/batches/${b}/decision`, { decision: "approve" });
    await call("POST", `/api/orgs/${org}/batches/${b}/start`);
    const d = await waitForBatch(org, b);
    check("refund the duplicates", d.batch.status === "completed", `${m.body?.stats?.byClassification?.exact_unit} proven duplicates, ${d.totalOperations} refunded`);
  }

  console.log("\nScenario D: currency exposure (live reference rates)");
  const incident2 = (await call("POST", `/api/orgs/${org}/incidents`, { kind: "pricing_error", title: "Kettle sold above list price" })).body.id;
  const today = new Date();
  await call("POST", `/api/orgs/${org}/incidents/${incident2}/rules`, {
    scope: { type: "overcharge", sku: "KT-120", correctUnitPriceMinor: 3900, from: new Date(today.getTime() - 30 * 86400000).toISOString(), to: today.toISOString() },
    compensation: { type: "overcharge_difference" },
  });
  const over = await call("POST", `/api/orgs/${org}/incidents/${incident2}/match`);
  check("find overcharged orders", over.status === 200, `${over.body?.candidates} customers`);
  const fx = await call("GET", `/api/orgs/${org}/fx/exposure`);
  check("exposure by currency", fx.status === 200, fx.body?.byCurrency?.map((c: any) => `${c.currency} ${c.customers} customers`).join(", "));
  const history = await call("GET", "/api/fx/history?base=USD&quote=EUR&days=14");
  const last = history.body?.points?.at(-1);
  check("live reference rates", history.status === 200 && Boolean(last), last ? `USD/EUR ${last.rate} on ${last.date}; ${history.body.disclaimer}` : history.body?.refreshError);

  console.log("\nRecords");
  const audit = await call("GET", `/api/orgs/${org}/audit?size=5`);
  check("audit chain intact", audit.body?.chain?.ok === true, `${audit.body?.chain?.rows} rows`);
  const dash = await call("GET", `/api/orgs/${org}/dashboard`);
  const paid = dash.body.operations.filter((o: any) => o.state === "succeeded").reduce((a: number, o: any) => a + o.n, 0);
  check("dashboard reflects the work", paid > 0, `${paid} payments succeeded`);
  const spec = await call("GET", "/api/openapi.json");
  check("OpenAPI description", spec.status === 200, `${Object.keys(spec.body?.paths ?? {}).length} paths`);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
