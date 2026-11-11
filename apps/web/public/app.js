// Make Good: the merchant's page. Plain JavaScript, no build step.
//
// The page asks seven questions in order and answers each from the server:
//   1 what went wrong            5 how much each option costs
//   2 who might be affected      6 what was approved
//   3 what the evidence says     7 what actually happened
//   4 what the options are
// Nothing here decides anything. Every figure and label comes from the API.

// ---------- small helpers ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "disabled" || k === "selected") el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `The request failed (${res.status}).`);
    err.status = res.status;
    err.code = data && data.error && data.error.code;
    err.details = data && data.error && data.error.details;
    throw err;
  }
  return data;
}
const get = (url) => call("GET", url);
const post = (url, body = {}) => call("POST", url, body);

const NO_DECIMALS = new Set(["JPY", "HUF", "TWD"]);
function money(minor, currency = "USD") {
  if (minor === null || minor === undefined) return "–";
  const places = NO_DECIMALS.has(currency) ? 0 : 2;
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: places, maximumFractionDigits: places }).format(Number(minor) / 10 ** places);
}
const moneyMap = (byCurrency) => {
  const parts = Object.entries(byCurrency || {}).filter(([, v]) => v).map(([c, v]) => money(v, c));
  return parts.length ? parts.join(" + ") : "–";
};
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "–");
const short = (s, n = 10) => (s && s.length > n ? `${s.slice(0, n)}…` : s || "–");

// ---------- words for the values the server sends ----------

const PAYMENT = {
  verified: ["Payment verified", "ok", "One PayPal payment is tied to this order by an identifier both systems carry, or by a named person."],
  ambiguous: ["Payment ambiguous", "hold", "A payment fits, but another payment or order fits too, or only email, amount and time agree."],
  missing: ["Payment not found", "hold", "The order should have a PayPal payment and none has been matched, or a payment has no order."],
  not_paypal: ["Not paid by PayPal", "", "The order was paid another way. There is nothing at PayPal to refund."],
};
const UNIT = {
  proven: ["Unit proven", "ok", "A record names the unit or batch itself."],
  supported: ["Supported by records", "hold", "No unit-level record, but the merchant's own records agree. An inference."],
  uncertain: ["Uncertain", "hold", "Consistent with being affected, but mixed stock, a single source, or a later change to the order."],
  unknown: ["Unknown", "hold", "The right product. Nothing about batch or date."],
  not_affected: ["Not affected", "", "The records show this purchase was not affected."],
};
const CELL_ACTION = (identity, unit) =>
  unit === "proven"
    ? identity === "verified" ? ["Ready for approval", "ready"] : identity === "not_paypal" ? ["Owed outside PayPal", "hold"] : ["Reconcile the payment", "hold"]
    : identity === "verified" || identity === "not_paypal" ? ["Needs evidence of the unit", "hold"] : ["Investigate", "hold"];
const KIND = { fact: ["Fact", "ok"], inference: ["Inference", "info"], assumption: ["Assumption", "hold"] };
const STRENGTH = { proves: "settles it", supports: "adds weight", weak: "suggestive only", contradicts: "points the other way" };
const SOURCE = {
  order: "order", order_line: "order line", fulfilment_line: "packing record", inventory_batch: "stock record", payment_transaction: "PayPal payment",
  order_payment_link: "order ↔ payment", order_adjustment: "return or refund", customer_statement: "customer", claim_evidence: "claim", reviewer: "member of staff",
  product_alias: "product-code alias", incident_scope: "incident rules",
};
const HELD_WHY = {
  waiting_for_confirmation: "Waiting for a person's decision",
  payment_not_reconciled: "The payment is not settled",
  eligibility_not_confirmed: "The unit is not proven and nobody has confirmed it",
  paid_under_another_incident: "Already paid under another incident",
  payment_in_another_batch: "Another payment list is refunding the same PayPal payment",
  second_refund_on_same_payment: "One refund per PayPal payment per list; this goes on the next",
  payout_needs_its_own_approval: "A payout needs a payment list and approval of its own",
  refund_goes_in_a_refund_batch: "A refund goes on a refund list",
  needs_manual_handling: "Cannot be refunded to the original payment automatically",
  nothing_to_pay: "Nothing left to pay",
  already_in_a_batch_or_paid: "Already on a list, or paid",
  excluded: "Excluded: returned, already refunded, or in a dispute",
  declined: "Declined by a person",
};
const OP_STATE = {
  planned: ["Not sent", ""], queued: ["Queued", "info"], submitting: ["Sent, awaiting reply", "info"], pending_provider: ["Pending at PayPal", "info"],
  unknown: ["Outcome unknown: asking PayPal", "hold"], succeeded: ["Paid: confirmed by PayPal", "ok"], failed_retryable: ["Failed, can be retried", "stop"],
  failed_final: ["Failed", "stop"], cancelled: ["Cancelled", ""],
};
const BASIS = [
  ["customer_confirmed_unit", "The customer confirmed the code on their unit"],
  ["merchant_records_checked", "We checked records outside this system"],
  ["policy_include_unproven", "We choose to pay without proof of the unit"],
];
const RULES = {
  full_refund: { label: "Full refund of the affected units", rule: { type: "full_refund" } },
  half: { label: "Half the price of the affected units", rule: { type: "percent", percentBps: 5000 } },
  fixed: { label: "20.00 USD for each affected unit", rule: { type: "fixed_per_unit", fixedMinor: 2000, fixedCurrency: "USD" } },
};
const chip = (text, tone = "", title = "") => h("span", { class: `chip ${tone}`, title }, text);

// ---------- state ----------

const state = {
  me: null, org: null, incidentId: null, incidents: [],
  map: null, evidence: null, rows: [], incident: null, evaluation: null, policies: null, preview: null,
  batch: null, manifest: null, audit: null, aliases: null, reconciliation: [],
  lastMatch: null, filter: null, detail: null, priceWith: "current",
  busy: 0, toast: null, form: {},
};
let pollTimer = null;
let toastTimer = null;

function toast(message, isError = false) {
  state.toast = { message, isError };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast = null; render(); }, isError ? 9000 : 4500);
  render();
}

/** Runs an action, shows that something is happening, and reports a failure in plain words. */
async function run(action, done) {
  state.busy++;
  render();
  try {
    await action();
    if (done) toast(done);
  } catch (err) {
    toast(err.message || String(err), true);
    if (err.status === 401) { state.me = null; }
  } finally {
    state.busy--;
    render();
  }
}

const orgUrl = () => `/api/orgs/${state.org.orgId}`;
const incUrl = () => `${orgUrl()}/incidents/${state.incidentId}`;

async function boot() {
  const token = new URLSearchParams(location.search).get("confirm");
  if (token) {
    // A customer opened a confirmation link. They see one question and nothing else.
    state.confirm = { token, question: null, error: null, done: false };
    try {
      state.confirm.question = await get(`/api/public/confirm/${encodeURIComponent(token)}`);
    } catch (err) {
      state.confirm.error = "This link has already been used, or is not valid.";
    }
    render();
    return;
  }
  try {
    state.me = await get("/api/me");
  } catch {
    state.me = null;
    render();
    return;
  }
  state.org = state.me.organisations[0] || null;
  try {
    if (state.org) {
      state.incidents = await get(`${orgUrl()}/incidents`);
      const recall = state.incidents.find((i) => i.kind === "recall") || state.incidents[0];
      if (recall) {
        state.incidentId = recall.id;
        await refresh();
      }
    }
  } catch (err) {
    if (err.status === 401) state.me = null;
    else toast(err.message || String(err), true);
  }
  render();
}

async function refresh() {
  if (!state.org || !state.incidentId) return;
  const [map, evidence, list, incident, evaluation, audit, recon] = await Promise.all([
    get(`${incUrl()}/recovery-map`),
    get(`${incUrl()}/evidence`),
    get(`${incUrl()}/candidates?size=200&includeCleared=true`),
    get(incUrl()),
    get(`${incUrl()}/evaluation`),
    get(`${orgUrl()}/audit?size=60`).catch(() => null),
    get(`${orgUrl()}/reconciliation`).catch(() => []),
  ]);
  Object.assign(state, { map, evidence, rows: list.rows, incident, evaluation, audit, reconciliation: recon });
  if (map.rule) {
    const policies = state.priceWith === "current" ? undefined : DEFAULT_POLICIES.map((p) => ({ ...p, compensation: RULES[state.priceWith].rule }));
    [state.policies, state.preview] = await Promise.all([post(`${incUrl()}/policies/compare`, policies ? { policies } : {}), get(`${incUrl()}/preview`)]);
  } else {
    state.policies = null;
    state.preview = null;
  }
  const current = (incident.batches || []).find((b) => !["cancelled", "rejected"].includes(b.status));
  if (current) {
    state.batch = await get(`${orgUrl()}/batches/${current.id}?size=200`);
    state.manifest = await get(`${orgUrl()}/batches/${current.id}/manifest`).catch(() => null);
  } else {
    state.batch = null;
    state.manifest = null;
  }
  schedulePoll();
}

const DEFAULT_POLICIES = [
  { key: "proven_only", label: "Pay only customers whose unit is proven", include: ["proven"], askTheRest: false },
  { key: "ask_the_rest", label: "Pay proven units now, and ask the others to confirm their batch code", include: ["proven"], askTheRest: true },
  { key: "include_likely", label: "Also pay customers who are likely affected, after you review them", include: ["proven", "supported", "uncertain"], askTheRest: false },
];

/** While payments are moving, ask the server again every second and a half. */
function schedulePoll() {
  clearTimeout(pollTimer);
  const live = state.batch && (["executing", "paused"].includes(state.batch.batch.status) ||
    (state.batch.operations || []).some((o) => ["queued", "submitting", "unknown", "pending_provider"].includes(o.state)));
  if (!live) return;
  pollTimer = setTimeout(async () => {
    try {
      await refresh();
    } catch { /* the next tick will try again */ }
    if (!state.detail) render();
  }, 1500);
}

// ---------- actions ----------

const startDemo = () => run(async () => {
  const id = Math.random().toString(36).slice(2, 10);
  const password = `${crypto.randomUUID()}-Demo`;
  await post("/api/auth/register", { email: `demo-${id}@example.com`, password, name: "Ada (demo)" });
  const org = await post("/api/orgs", { name: `Kitchen Co ${id}` });
  await post(`/api/orgs/${org.id}/paypal/simulator`);
  const seeded = await post(`/api/orgs/${org.id}/demo/recall-scenario`);
  state.me = await get("/api/me");
  state.org = state.me.organisations.find((o) => o.orgId === org.id);
  state.incidentId = seeded.incidentId;
  await refresh();
}, "The recall case is loaded: 32 synthetic orders on the simulator.");

const signIn = () => run(async () => {
  await post("/api/auth/login", { email: state.form.email || "", password: state.form.password || "" });
  await boot();
});

const signOut = () => run(async () => {
  await post("/api/auth/logout");
  Object.assign(state, { me: null, org: null, incidentId: null, map: null, batch: null, manifest: null, detail: null });
});

const readNotice = (method) => run(async () => {
  const doc = state.evidence.documents[0];
  const result = await post(`${incUrl()}/documents/${doc.id}/extract`, { method });
  state.form.skus = (result.output.proposedScope ? result.output.proposedScope.skus : []).join(", ");
  state.form.batches = (result.output.proposedScope ? result.output.proposedScope.batchCodes : []).join(", ");
  await refresh();
}, "The notice was read. Check each line against the notice before saving any rules.");

const saveRules = () => run(async () => {
  const extraction = state.evidence.extractions.find((e) => e.status === "proposed");
  const list = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
  const scope = { type: "product", skus: list(state.form.skus), batchCodes: list(state.form.batches) };
  const compensation = RULES[state.form.rule || "full_refund"].rule;
  if (extraction) await post(`${incUrl()}/extractions/${extraction.id}/accept`, { scope, compensation });
  else await post(`${incUrl()}/rules`, { scope, compensation, note: "Entered by hand." });
  await refresh();
}, "Rules saved in your name.");

const findCustomers = () => run(async () => {
  state.lastMatch = await post(`${incUrl()}/match`);
  state.aliases = await post(`${incUrl()}/aliases/suggest`, { withAi: false });
  await refresh();
});

const askClaudeAboutAliases = () => run(async () => {
  state.aliases = await post(`${incUrl()}/aliases/suggest`, { withAi: true });
  if (state.aliases.aiNote) toast(state.aliases.aiNote, true);
});

const decideAlias = (alias, decision) => run(async () => {
  await post(`${orgUrl()}/aliases/${alias.id}/decision`, { decision });
  state.lastMatch = await post(`${incUrl()}/match`);
  state.aliases = await post(`${incUrl()}/aliases/suggest`, { withAi: false });
  await refresh();
}, decision === "confirm" ? `"${alias.alias}" is now treated as ${alias.canonicalSku}, in your name. The match was run again.` : `"${alias.alias}" will stay unmatched.`);

const openDetail = (id) => run(async () => {
  state.detail = { id, data: await get(`${orgUrl()}/candidates/${id}`), explanation: null };
  state.form.basis = BASIS[0][0];
  state.form.note = "";
  state.form.paymentId = null;
});
const closeDetail = () => { state.detail = null; render(); };

const decideRecord = (decision) => run(async () => {
  const result = await post(`${incUrl()}/candidates/decide`, {
    candidateIds: [state.detail.id], decision, basis: decision === "confirm" ? state.form.basis : undefined, note: state.form.note || undefined,
  });
  if (result.changed === 0) throw new Error(result.refused[0] ? result.refused[0].why : "Nothing changed.");
  state.detail = null;
  await refresh();
}, decision === "confirm" ? "Confirmed in your name. Your reason is stored as evidence." : "Declined in your name.");

const reconcile = () => run(async () => {
  if (!state.form.paymentId) throw new Error("Choose the payment that paid for this order.");
  if (!(state.form.note || "").trim()) throw new Error("Say how you know: for example, the receipt the customer sent.");
  const result = await post(`${orgUrl()}/candidates/${state.detail.id}/reconcile-payment`, { paymentTransactionId: state.form.paymentId, note: state.form.note.trim() });
  state.lastMatch = result.match;
  state.detail = null;
  await refresh();
}, "The payment is settled in your name, and the match was run again.");

const makeLink = () => run(async () => {
  state.detail.link = (await post(`${orgUrl()}/candidates/${state.detail.id}/confirm-link`)).url;
});

const explain = () => run(async () => {
  state.detail.explanation = await post(`${orgUrl()}/candidates/${state.detail.id}/explain`);
});

const reprice = (key) => run(async () => { state.priceWith = key; await refresh(); });

const buildList = () => run(async () => {
  await post(`${incUrl()}/batches`, { name: `${state.map.incident.title}: payment list` });
  await refresh();
}, "Payment list built. Nothing is sent until it is approved and started.");
const batchAction = (action, body, done) => run(async () => {
  await post(`${orgUrl()}/batches/${state.batch.batch.id}/${action}`, body);
  await refresh();
}, done);
const stageFault = (body) => run(async () => {
  const r = await post(`${orgUrl()}/demo/faults`, body);
  toast(r.staged);
});

// ---------- rendering ----------

function render() {
  const root = document.getElementById("app");
  const scroll = document.querySelector(".drawer") ? document.querySelector(".drawer").scrollTop : 0;
  root.replaceChildren(...(state.confirm ? [buyerPage()] : state.me ? page() : [landing()]));
  if (state.busy > 0) root.append(h("div", { class: "busy", role: "progressbar", "aria-label": "Working" }));
  if (state.toast) root.append(h("div", { class: `toast ${state.toast.isError ? "err" : ""}`, role: "status" }, state.toast.message));
  if (document.querySelector(".drawer")) document.querySelector(".drawer").scrollTop = scroll;
}

function buyerPage() {
  const c = state.confirm;
  const send = () => run(async () => {
    await post(`/api/public/confirm/${encodeURIComponent(c.token)}`, { batchCode: state.form.code || "" });
    c.done = true;
  });
  return h("div", { class: "landing" },
    c.error ? [h("h1", {}, "This link cannot be used"), h("p", { class: "lede" }, c.error)]
    : c.done ? [h("h1", {}, "Thank you"), h("p", { class: "lede" }, `${c.question.merchant} has your answer. A member of their staff will check it and contact you about what happens next. You do not need to do anything else.`)]
    : [h("h1", {}, "One question about your order"),
       h("p", { class: "lede" }, `${c.question.merchant} is checking orders because of this: ${c.question.incident}.`),
       h("p", {}, `Your order ${c.question.orderNumber || ""} included: ${c.question.product || "a product"}. Please find the batch code printed on the product or its box, and type it here exactly as printed.`),
       h("label", { class: "field", style: "margin-top:18px;max-width:320px" }, h("span", {}, "Batch code"), h("input", { type: "text", autocomplete: "off", oninput: (e) => (state.form.code = e.target.value) })),
       h("button", { class: "btn primary", onclick: send }, "Send"),
       h("p", { class: "small muted", style: "margin-top:12px" }, "We ask only for the code. We will never ask for a password or payment details through this page.")]);
}

function landing() {
  return h("div", { class: "landing" },
    h("h1", {}, "Who is owed money, why, how much, and what was actually paid."),
    h("p", { class: "lede" }, "A supplier recalls one batch of a product. Refunding is the easy part. Working out which customers received that batch, from records that never quite agree, is the hard part. Make Good does that part in the open."),
    h("ol", {},
      h("li", {}, "Read the supplier's notice into rules a person checks."),
      h("li", {}, "Answer two questions for every buyer: is this their PayPal payment, and was their unit affected?"),
      h("li", {}, "Show who is ready, who is held and who is left out, with the record behind each."),
      h("li", {}, "Approve one exact payment list. Pay only that list, through PayPal, and show only what PayPal confirms.")),
    h("button", { class: "btn primary", onclick: startDemo, disabled: state.busy > 0 }, "Open the recall case"),
    h("p", { class: "small muted", style: "margin-top:10px" }, "Loads 32 invented orders for a kitchen shop on a built-in PayPal simulator. No real money and no real customers. It takes a few seconds."),
    h("div", { class: "signin" },
      h("h3", {}, "Already have an account?"),
      h("label", { class: "field" }, h("span", {}, "Email"), h("input", { type: "email", autocomplete: "username", oninput: (e) => (state.form.email = e.target.value) })),
      h("label", { class: "field" }, h("span", {}, "Password"), h("input", { type: "password", autocomplete: "current-password", oninput: (e) => (state.form.password = e.target.value) })),
      h("button", { class: "btn", onclick: signIn }, "Sign in")));
}

function page() {
  if (!state.org || !state.map) {
    return [topBar(), h("main", {}, h("div", { class: "card pad" },
      h("h3", {}, "No incident yet"),
      h("p", { class: "sub" }, "This account has no recall case loaded."),
      h("button", { class: "btn primary", onclick: startDemo }, "Open the recall case in a new demo account")))];
  }
  const out = [topBar(), h("main", {}, s1(), s2(), s3(), s45(), s6(), s7())];
  if (state.detail) out.push(h("div", { class: "scrim", onclick: closeDetail }), drawer());
  return out;
}

function progress() {
  const m = state.map;
  const b = state.batch && state.batch.batch;
  return {
    rules: Boolean(m.rule), matched: Boolean(m.lastMatch), listed: Boolean(b),
    approved: Boolean(b && ["approved", "executing", "paused", "completed", "completed_with_failures"].includes(b.status)),
    paid: Boolean(b && ["completed", "completed_with_failures"].includes(b.status)),
  };
}

function topBar() {
  const m = state.map;
  const p = m ? progress() : {};
  const env = m ? m.dataLabels.paypal : null;
  const steps = [
    ["s1", "What went wrong", p.rules], ["s2", "Who might be affected", p.matched], ["s3", "The evidence", p.matched],
    ["s4", "Options and cost", p.listed], ["s6", "What was approved", p.approved], ["s7", "What happened", p.paid],
  ];
  return h("div", { class: "top" },
    h("div", { class: "top-row" },
      h("div", { class: "brand" }, "Make Good", h("small", {}, "Evidence-backed incident recovery on PayPal")),
      h("div", { class: "labels" },
        m && h("span", { class: `label ${env === "simulator" ? "sim" : env === "sandbox" ? "sandbox" : ""}`, title: m.dataLabels.paypalMeaning },
          "PayPal: ", h("b", {}, env === "simulator" ? "simulator, no real money" : env === "sandbox" ? "sandbox, test money" : env)),
        m && h("span", { class: `label ${m.dataLabels.merchantRecords === "synthetic" ? "sim" : ""}` },
          "Merchant records: ", h("b", {}, m.dataLabels.merchantRecords === "synthetic" ? "synthetic (invented)" : "your own")),
        h("span", { class: "label" }, state.me.user.name),
        h("button", { class: "btn small", onclick: signOut }, "Sign out"))),
    m && h("nav", { class: "steps", "aria-label": "The seven questions" },
      steps.map(([id, text, done], i) => h("a", { class: `step ${done ? "done" : ""}`, href: `#${id}` }, h("i", {}, String(i + 1)), text))));
}

function section(id, number, title, hint, ...body) {
  return h("section", { class: "section", id },
    h("header", {}, h("span", { class: "q" }, `Question ${number}`), h("h2", {}, title), hint && h("p", { class: "hint" }, hint)),
    ...body);
}
const lockedNote = (text) => h("div", { class: "locked-note" }, text);

// ----- 1. what went wrong -----

function noticeWithQuotes(body, extraction) {
  const out = extraction ? extraction.output : null;
  const marks = [];
  const add = (quote, no) => {
    const at = quote ? body.indexOf(quote) : -1;
    if (at >= 0) marks.push({ at, end: at + quote.length, no });
  };
  if (out) {
    out.products.forEach((p) => add(p.quote, !p.included));
    out.batchCodes.forEach((b) => add(b.quote, !b.affected));
    out.remedy.forEach((r) => add(r.quote, false));
    out.dates.forEach((d) => add(d.quote, false));
  }
  marks.sort((a, b) => a.at - b.at);
  const parts = [];
  let cursor = 0;
  for (const m of marks) {
    if (m.at < cursor) continue;
    parts.push(body.slice(cursor, m.at), h("mark", { class: m.no ? "no" : "" }, body.slice(m.at, m.end)));
    cursor = m.end;
  }
  parts.push(body.slice(cursor));
  return h("div", { class: "paper", tabindex: "0" }, parts);
}

function s1() {
  const { map, evidence } = state;
  const doc = evidence.documents[0];
  const extraction = evidence.extractions[0] || null;
  const out = extraction ? extraction.output : null;
  const right = [];

  if (!doc) right.push(lockedNote("No document is attached to this incident."));
  else if (!extraction) {
    right.push(h("div", { class: "card pad" },
      h("h3", {}, "Read the notice"),
      h("p", { class: "sub" }, "Pull out which products and batches the supplier names. Every line will quote the notice, and nothing is applied until you save it."),
      h("div", { class: "actions" },
        h("button", { class: "btn primary", onclick: () => readNotice("auto") }, evidence.ai.configured ? "Read it with Claude" : "Read it"),
        evidence.ai.configured && h("button", { class: "btn", onclick: () => readNotice("pattern_rules") }, "Read it with pattern rules")),
      !evidence.ai.configured && h("p", { class: "note" }, "No Claude key is set on this server, so the notice is read with plain text rules against your catalogue. The check on the result is the same either way.")));
  } else {
    const by = extraction.method === "claude" ? `Read by Claude (${extraction.model})` : "Read by pattern rules, no AI";
    right.push(h("div", { class: "card pad" },
      h("h3", {}, "What the notice says"),
      h("p", { class: "sub" }, `${by}. Each line was checked: it quotes the notice word for word, and its value is inside the quote.`),
      h("div", {},
        fieldRow("Products", out.products.map((p) => h("div", {},
          h("b", {}, p.code), " ", chip(p.included ? "affected" : "not affected", p.included ? "stop" : ""), " ", !p.inCatalogue && chip("not in your catalogue", "hold"),
          h("div", { class: "quote" }, `“${p.quote}”`)))),
        fieldRow("Batches", out.batchCodes.map((b) => h("div", {}, h("b", {}, b.code), " ", chip(b.affected ? "affected" : "not affected", b.affected ? "stop" : ""), h("div", { class: "quote" }, `“${b.quote}”`)))),
        out.remedy.length > 0 && fieldRow("Remedy", out.remedy.map((r) => h("div", {}, h("b", {}, r.kind.replace(/_/g, " ")), h("div", { class: "quote" }, `“${r.quote}”`)))),
        out.dates.length > 0 && fieldRow("Dates", out.dates.map((d) => h("div", {}, h("b", {}, `${d.from} to ${d.to}`), " ", chip(d.meaning.replace(/_/g, " "), "outline"), h("div", { class: "quote" }, `“${d.quote}”`))))),
      out.dropped.map((d) => h("p", { class: "bad" }, `Dropped: ${d.field} “${d.value}”. ${d.why}`)),
      out.warnings.map((w) => h("p", { class: "warn" }, w))));

    if (map.rule) {
      right.push(h("div", { class: "card pad", style: "margin-top:14px" },
        h("h3", {}, `Rules in force, version ${map.rule.version}`),
        h("div", { class: "field-row" }, h("span", { class: "k" }, "Products"), h("span", {}, map.rule.scope.skus.join(", "))),
        h("div", { class: "field-row" }, h("span", { class: "k" }, "Batches"), h("span", {}, (map.rule.scope.batchCodes || []).join(", ") || "every unit")),
        h("div", { class: "field-row" }, h("span", { class: "k" }, "Owed"), h("span", {}, map.rule.compensationInWords)),
        h("div", { class: "field-row" }, h("span", { class: "k" }, "Saved by"), h("span", {}, `${extraction.decided_by || "a member of staff"}, ${day(map.rule.created_at)}`))));
    } else {
      if (state.form.skus === undefined && out.proposedScope) {
        state.form.skus = out.proposedScope.skus.join(", ");
        state.form.batches = out.proposedScope.batchCodes.join(", ");
      }
      right.push(h("div", { class: "card pad", style: "margin-top:14px" },
        h("h3", {}, "Save the rules"),
        h("p", { class: "sub" }, "These become the incident's rules in your name. Change them if the reading is wrong."),
        h("label", { class: "field" }, h("span", {}, "Affected product codes"), h("input", { type: "text", value: state.form.skus || "", oninput: (e) => (state.form.skus = e.target.value) })),
        h("label", { class: "field" }, h("span", {}, "Affected batch codes"), h("input", { type: "text", value: state.form.batches || "", oninput: (e) => (state.form.batches = e.target.value) })),
        h("label", { class: "field" }, h("span", {}, "What each affected customer is owed"),
          h("select", { onchange: (e) => (state.form.rule = e.target.value) }, Object.entries(RULES).map(([k, r]) => h("option", { value: k, selected: (state.form.rule || "full_refund") === k }, r.label)))),
        h("button", { class: "btn primary", onclick: saveRules }, "Save these rules")));
    }
  }

  return section("s1", 1, "What went wrong?", "The supplier knows which batch is faulty. Nobody yet knows which customers received it.",
    h("div", { class: "grid2" },
      h("div", {},
        h("p", { style: "margin-bottom:10px" }, map.incident.description),
        doc && h("div", { class: "small muted", style: "margin-bottom:6px" }, doc.title, " ", doc.data_label === "synthetic" && chip("synthetic document", "hold")),
        doc && noticeWithQuotes(doc.body, extraction)),
      h("div", {}, right)));
}
const fieldRow = (label, items) => h("div", { class: "field-row" }, h("span", { class: "k" }, label), h("div", {}, items.length ? items : h("span", { class: "muted" }, "none found")));

// ----- 2. who might be affected -----

function s2() {
  const { map } = state;
  if (!map.rule) return section("s2", 2, "Who might be affected?", null, lockedNote("Save the rules first."));
  const body = [];
  body.push(h("div", { class: "actions", style: "margin:0 0 14px" },
    h("button", { class: map.lastMatch ? "btn" : "btn primary", onclick: findCustomers }, map.lastMatch ? "Run the match again" : "Find affected customers"),
    map.lastMatch && h("span", { class: "small muted" }, `Last run ${clock(map.lastMatch.finished_at)}.`),
    state.lastMatch && state.lastMatch.disputes && h("span", { class: "small muted" },
      state.lastMatch.disputes.failed ? state.lastMatch.disputes.failed : `PayPal was asked about disputes on ${state.lastMatch.disputes.checked} payments: ${state.lastMatch.disputes.open} open.`)));
  if (!map.lastMatch) return section("s2", 2, "Who might be affected?", "Two separate questions are answered for every buyer of the product.", ...body);

  const live = map.matrix.reduce((a, m) => a + m.count, 0);
  const g = (d) => map.groups.find((x) => x.disposition === d) || { count: 0 };
  const ready = ["ready", "in_a_batch", "in_progress", "outcome_unknown", "paid", "payment_failed"].reduce((a, d) => a + g(d).count, 0);
  const held = map.groups.filter((x) => x.group === "held").reduce((a, x) => a + x.count, 0);
  body.push(h("div", { class: "funnel" },
    stat(map.lastMatch.stats.linesConsidered, "order lines for the product"),
    stat(g("not_affected").count, "shown not to be affected"),
    stat(live, "records that may be owed"),
    stat(ready, "settled by the records or by a person"),
    stat(held, "waiting for a person")));

  const identities = ["verified", "ambiguous", "missing", "not_paypal"].filter((i) => map.matrix.some((m) => m.paymentIdentity === i));
  const units = ["proven", "supported", "uncertain", "unknown"];
  const cellOf = (i, u) => map.matrix.find((m) => m.paymentIdentity === i && m.eligibility === u);
  body.push(h("div", { class: "card pad" },
    h("h3", {}, "The two answers, crossed"),
    h("p", { class: "sub" }, "Down: does this PayPal payment belong to this order? Across: was this purchase affected? These are categories with stated grounds. There are no scores."),
    h("div", { class: "matrix", role: "table" },
      h("div", {}),
      units.map((u) => h("div", { class: "head", title: UNIT[u][2] }, UNIT[u][0])),
      identities.map((i) => [
        h("div", { class: "side", title: PAYMENT[i][2] }, PAYMENT[i][0]),
        units.map((u) => {
          const c = cellOf(i, u);
          const [action, tone] = CELL_ACTION(i, u);
          const selected = state.filter && state.filter.paymentIdentity === i && state.filter.eligibility === u;
          return h("button", {
            class: `cell ${c ? tone : "empty"} ${selected ? "sel" : ""}`, disabled: !c,
            onclick: () => { state.filter = selected ? null : { paymentIdentity: i, eligibility: u, label: `${PAYMENT[i][0]} and ${UNIT[u][0].toLowerCase()}` }; render(); location.hash = "s3"; },
          }, h("div", { class: "n" }, c ? c.count : 0), h("div", { class: "a" }, c ? action : ""), c && h("div", { class: "small muted num" }, moneyMap(c.amount)));
        }),
      ]))));

  body.push(aliasPanel());
  return section("s2", 2, "Who might be affected?", "PayPal knows who paid. It does not know which batch anyone received. Only the merchant's packing records, or the customer, can say.", ...body);
}
const stat = (n, text) => h("div", { class: "stat" }, h("div", { class: "n" }, n), h("div", { class: "t" }, text));

function aliasPanel() {
  const a = state.aliases;
  if (!a || a.aliases.length === 0) return null;
  const open = a.aliases.filter((x) => x.status === "suggested");
  return h("div", { class: "card pad", style: "margin-top:14px" },
    h("h3", {}, "Product codes written differently"),
    h("p", { class: "sub" }, open.length > 0
      ? `${open.length} kind(s) of order line look like a recalled product but do not carry its code. They are not matched. Only you can say whether they are the same product.`
      : "Every look-alike product code has been decided."),
    h("div", { class: "scroll-x" }, h("table", { class: "plain" },
      h("thead", {}, h("tr", {}, ["On the order", "Looks like", "Why it was noticed", "Lines", "Batch codes recorded", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, a.aliases.map((x) => h("tr", {},
        h("td", {}, h("b", {}, x.alias), h("div", { class: "small muted" }, x.sampleTitles.join(" · "))),
        h("td", {}, x.canonicalSku),
        h("td", {}, x.reason, x.ai && h("div", { class: "note" }, `Claude's opinion (${x.ai.model}): ${x.ai.verdict.replace(/_/g, " ")}. ${x.ai.reason} It quoted “${x.ai.quotedTitle}”. This is an opinion, not a decision.`)),
        h("td", { class: "num" }, x.lines),
        h("td", {}, x.batchCodes.join(", ") || "–"),
        h("td", { class: "nowrap" }, x.status === "suggested"
          ? [h("button", { class: "btn small", onclick: () => decideAlias(x, "confirm") }, "Same product"), " ", h("button", { class: "btn small", onclick: () => decideAlias(x, "reject") }, "Different")]
          : chip(x.status === "confirmed" ? `same product: ${x.decidedBy || "confirmed"}` : `different: ${x.decidedBy || "rejected"}`, x.status === "confirmed" ? "ok" : ""))))))),
    state.evidence.ai.configured && open.length > 0 && h("div", { class: "actions" }, h("button", { class: "btn small", onclick: askClaudeAboutAliases }, "Ask Claude for an opinion on these")));
}

// ----- 3. the evidence: the Recovery Map -----

function s3() {
  const { map, rows } = state;
  if (!map.lastMatch) return section("s3", 3, "What does the evidence say?", null, lockedNote("Run the match first."));
  const f = state.filter;
  const shown = rows.filter((r) => !f || ((!f.paymentIdentity || r.payment_identity === f.paymentIdentity) && (!f.eligibility || f.eligibility.split("|").includes(r.eligibility)) && r.status !== "cleared"));
  const groups = map.groups.map((g) => ({ ...g, rows: shown.filter((r) => r.disposition === g.disposition) })).filter((g) => g.rows.length > 0);
  return section("s3", 3, "What does the evidence say?", "The Recovery Map. Every buyer of the product, where the record stands, and why. Open a row for the records behind it.",
    f && h("div", { class: "filterbar" }, "Showing:", chip(f.label, "info"), h("button", { class: "btn small", onclick: () => { state.filter = null; render(); } }, "Show everyone")),
    groups.map((g) => h("div", { class: "group" },
      h("div", { class: "group-head" },
        h("h3", {}, `${g.label} · ${g.rows.length}`), h("span", { class: "why" }, g.why),
        h("span", { class: "sum" }, g.disposition === "paid" ? moneyMap(g.paid) : g.group === "left_out" ? "" : moneyMap(g.amount))),
      h("div", { class: "rows" }, g.rows.map(mapRow)))));
}

function mapRow(r) {
  const cleared = r.status === "cleared";
  return h("button", { class: "row", onclick: () => openDetail(r.id) },
    h("span", { class: "mono" }, r.order_number || "no order"),
    h("span", { class: "who" }, r.customer_name || r.customer_email || "unknown customer"),
    h("span", { class: "what" }, r.line_title ? `${r.affected_quantity} × ${r.sku ? r.sku.trim() : "(no product code)"} · ${r.line_title}` : "PayPal payment with no store order"),
    h("span", { class: "chips" },
      !cleared && chip(PAYMENT[r.payment_identity][0], PAYMENT[r.payment_identity][1], PAYMENT[r.payment_identity][2]),
      chip(UNIT[r.eligibility][0], UNIT[r.eligibility][1], UNIT[r.eligibility][2]),
      r.decided_by && chip(`by ${r.decided_by}`, "outline")),
    h("span", { class: "right num" }, r.payment_state === "succeeded" ? money(r.payment_amount_minor, r.currency) : r.payable_minor ? money(r.payable_minor, r.currency) : "–"));
}

function drawer() {
  const d = state.detail.data;
  const c = d.candidate;
  const group = state.map.groups.find((g) => g.disposition === c.disposition) || { label: c.disposition, why: "" };
  const ev = (dimension) => d.evidence.filter((e) => e.dimension === dimension);
  const truth = state.evaluation.available && d.order ? state.evaluation.cases.find((x) => x.orderNumber === d.order.order_number) : null;
  const held = c.status === "proposed";

  return h("aside", { class: "drawer", role: "dialog", "aria-label": "Customer record" },
    h("button", { class: "btn small close", onclick: closeDetail }, "Close"),
    h("p", { class: "small muted mono" }, d.order ? `Order ${d.order.order_number} · ${day(d.order.placed_at)}` : "PayPal payment with no store order"),
    h("h2", {}, c.customer_name || c.customer_email || "Unknown customer"),
    h("p", { style: "margin-top:6px" }, chip(group.label, group.group === "held" ? "hold" : group.group === "paid" ? "ok" : ""), " ", h("span", { class: "small muted" }, group.why)),

    h("div", { class: "answer" },
      h("div", { class: "ask" }, "Question 1 · Does this PayPal payment belong to this order?"),
      h("div", { class: "is" }, PAYMENT[c.payment_identity][0]), h("p", { class: "small muted" }, PAYMENT[c.payment_identity][2]),
      d.payment && h("p", { class: "small", style: "margin:8px 0" }, "PayPal payment ", h("span", { class: "mono" }, d.payment.transaction_id), ` · ${money(d.payment.gross_minor, d.payment.currency)} · refunded so far ${money(d.payment.refunded_minor, d.payment.currency)}`,
        d.payment.dispute_state === "open" && [" ", chip("dispute open", "stop")]),
      ev("payment").map(evidenceRow)),

    h("div", { class: "answer" },
      h("div", { class: "ask" }, "Question 2 · Was this purchase affected?"),
      h("div", { class: "is" }, UNIT[c.eligibility][0]), h("p", { class: "small muted" }, UNIT[c.eligibility][2]),
      ev("eligibility").map(evidenceRow)),

    ev("state").length > 0 && h("div", { class: "answer" }, h("div", { class: "ask" }, "The order and payment as they stand"), ev("state").map(evidenceRow)),

    (c.missing || []).length > 0 && h("div", { class: "answer" },
      h("div", { class: "ask" }, "What is missing"), h("ul", { style: "margin:8px 0 0;padding-left:18px" }, c.missing.map((m) => h("li", {}, m)))),

    held && c.decision === "reconcile_payment" && reconcileForm(d),
    held && c.decision === "needs_eligibility_evidence" && confirmForm(),
    held && c.decision === "investigate" && h("div", { class: "answer" },
      h("div", { class: "ask" }, "Next step"),
      h("p", { style: "margin-top:6px" }, d.order ? "Settle the payment first. Then the unit can be confirmed." : "No order in the store's records carries this payment. Find the order, import it, and run the match again. PayPal's record alone cannot show which batch this customer received.")),
    c.decided_by_name && h("p", { class: "note" }, `${c.status === "declined" ? "Declined" : "Confirmed"} by ${c.decided_by_name} on ${day(c.decided_at)}${c.decision_basis ? `: ${(BASIS.find((b) => b[0] === c.decision_basis) || [0, c.decision_basis.replace(/_/g, " ")])[1].toLowerCase()}` : ""}.${c.decision_note ? ` “${c.decision_note}”` : ""}`),

    d.calculation && h("div", { class: "answer" },
      h("div", { class: "ask" }, "What is owed, step by step"),
      h("table", { class: "plain", style: "margin-top:6px" }, h("tbody", {}, (d.calculation.steps.steps || []).map((s) => h("tr", {},
        h("td", {}, h("b", {}, s.label), h("div", { class: "small muted" }, s.detail)),
        h("td", { class: "right num nowrap" }, s.amountMinor === null ? "" : money(s.amountMinor, d.calculation.currency)))))),
      h("p", { class: "small muted", style: "margin-top:8px" }, d.calculation.route_reason)),

    d.operations.length > 0 && h("div", { class: "answer" },
      h("div", { class: "ask" }, "Payments for this record"),
      d.operations.map((o) => h("div", { class: "ev" },
        h("div", { class: "meta" }, chip(...opLabel(o))),
        h("div", {}, `${money(o.amount_minor, o.currency)} ${o.kind}`, o.provider_refund_id && [" · PayPal refund ", h("span", { class: "mono" }, o.provider_refund_id)],
          h("div", { class: "small muted" }, `Request ID ${o.idempotency_key} · ${o.attempts} call(s) to PayPal · payment list version ${o.manifest_version || "–"}`),
          o.failure_message && h("div", { class: "small", style: "color:var(--stop)" }, `${o.failure_code}: ${o.failure_message}`))))),

    state.evidence.ai.configured && held && h("div", { class: "answer" },
      h("div", { class: "ask" }, "Explanation"),
      state.detail.explanation
        ? [h("p", { style: "margin:6px 0" }, state.detail.explanation.explanation.summary),
           h("ul", { style: "margin:0;padding-left:18px" }, state.detail.explanation.explanation.points.map((p) => h("li", {}, p.text, " ", h("span", { class: "muted small" }, `[${p.cites.join(", ")}]`)))),
           h("p", { class: "small muted", style: "margin-top:6px" }, `Written by Claude (${state.detail.explanation.model}) from the evidence above only. It changes nothing about this record.`)]
        : h("button", { class: "btn small", style: "margin-top:8px", onclick: explain }, "Ask Claude to explain why this is held")),

    truth && h("details", { class: "answer" },
      h("summary", { class: "ask", style: "cursor:pointer" }, "The known answer for this invented record"),
      h("p", { style: "margin-top:8px" }, truth.note),
      h("p", { class: "small muted" }, `In truth: ${truth.truthAffectedUnits} affected unit(s); a correct PayPal refund would be ${money(truth.owedMinor)}. The matching engine cannot read this.`)));
}

const opLabel = (o) => (o.state === "cancelled" && o.failure_code === "APPROVAL_NO_LONGER_COVERS" ? ["Withheld: approval no longer covered it", "stop"] : OP_STATE[o.state] || [o.state, ""]);

function evidenceRow(e) {
  const [label, tone] = KIND[e.kind] || [e.kind, ""];
  return h("div", { class: "ev" },
    h("div", { class: "meta" }, chip(label, tone), h("span", { class: "src" }, `${SOURCE[e.source] || e.source} · ${STRENGTH[e.strength] || e.strength}`)),
    h("div", {}, e.fact));
}

function confirmForm() {
  return h("div", { class: "answer" },
    h("div", { class: "ask" }, "Your decision"),
    h("p", { class: "small muted", style: "margin:6px 0 10px" }, "The records cannot settle this. If you confirm, your reason is stored as evidence in your name and shown on the payment list."),
    h("label", { class: "field" }, h("span", {}, "What are you relying on?"),
      h("select", { onchange: (e) => (state.form.basis = e.target.value) }, BASIS.map(([k, t]) => h("option", { value: k, selected: state.form.basis === k }, t)))),
    h("label", { class: "field" }, h("span", {}, "Note"), h("textarea", { placeholder: "For example: customer sent a photo of the label, B-2217", oninput: (e) => (state.form.note = e.target.value) })),
    h("div", { class: "actions" }, h("button", { class: "btn primary", onclick: () => decideRecord("confirm") }, "Confirm this customer"), h("button", { class: "btn danger", onclick: () => decideRecord("decline") }, "Decline"),
      h("button", { class: "btn", onclick: makeLink }, "Make a link to ask the customer")),
    state.detail.link && h("label", { class: "field", style: "margin-top:10px" }, h("span", {}, "Send this link to the customer. It works once. Their answer appears here as evidence; you still decide."),
      h("input", { type: "text", readonly: true, value: state.detail.link, onfocus: (e) => e.target.select() })));
}

function reconcileForm(d) {
  const options = d.paymentOptions || [];
  return h("div", { class: "answer" },
    h("div", { class: "ask" }, "Settle the payment"),
    options.length === 0
      ? h("p", { style: "margin-top:6px" }, d.order && d.order.payment_reference
          ? `The store recorded PayPal payment ID ${d.order.payment_reference}, and PayPal does not know it. Correct the ID on the order and import it again.`
          : "No PayPal payment has been matched to this order. Nothing can be refunded until one is found.")
      : [h("p", { class: "small muted", style: "margin:6px 0 10px" }, "More than one payment could be this order's. A refund goes to one payment, so a person must say which. Your choice is recorded in your name."),
         options.map((p) => h("label", { class: "option" },
           h("input", { type: "radio", name: "payment", onchange: () => (state.form.paymentId = p.id) }),
           h("div", {}, h("span", { class: "mono" }, p.transaction_id), ` · ${money(p.gross_minor, p.currency)} · ${day(p.occurred_at)} ${clock(p.occurred_at)}`,
             h("div", { class: "small muted" }, `${p.payer_name || "payer unknown"} · ${p.detail}${p.other_orders ? ` · also tied to ${p.other_orders} other order(s)` : ""}`)))),
         h("label", { class: "field", style: "margin-top:10px" }, h("span", {}, "How do you know?"), h("textarea", { placeholder: "For example: matches the PayPal receipt the customer forwarded", oninput: (e) => (state.form.note = e.target.value) })),
         h("button", { class: "btn primary", onclick: reconcile }, "This payment paid for the order")]);
}

// ----- 4 and 5. options, and what each costs -----

function s45() {
  const { policies, map } = state;
  if (!map.lastMatch || !policies) return section("s4", "4 and 5", "What are the options, and what would each cost?", null, lockedNote("Run the match first."));
  return section("s4", "4 and 5", "What are the options, and what would each cost?", "A dry calculation on the records as they stand. Nothing is saved and nothing is paid by looking.",
    h("div", { class: "filterbar", style: "margin-bottom:12px" }, "Price each option with:",
      h("select", { style: "width:auto", onchange: (e) => reprice(e.target.value) },
        h("option", { value: "current", selected: state.priceWith === "current" }, `The rule in force (${policies.currentRule.inWords})`),
        Object.entries(RULES).map(([k, r]) => h("option", { value: k, selected: state.priceWith === k }, r.label)))),
    h("div", { class: "grid3" }, policies.policies.map((p) => h("div", { class: "card policy" },
      h("h3", {}, p.label),
      h("div", {}, h("div", { class: "big" }, moneyMap(p.payNow.amount)), h("div", { class: "small muted" }, `to ${p.payNow.customers} customer(s) now, by refund to the original payment`)),
      h("div", { class: "line" }, h("span", {}, "Of which: unit not proven"), h("b", {}, p.ofWhichUnproven.customers ? `${p.ofWhichUnproven.customers} · ${moneyMap(p.ofWhichUnproven.amount)}` : "none")),
      p.askedToConfirm !== null && h("div", { class: "line" }, h("span", {}, "Asked to confirm their batch code"), h("b", {}, `${p.askedToConfirm} · up to ${moneyMap(p.additionalIfAllConfirm.amount)} more`)),
      h("div", { class: "line" }, h("span", {}, "Possibly affected, not paid"), h("b", {}, p.notPaid.customers)),
      h("div", { class: "line" }, h("span", {}, "Waiting for the payment to be settled"), h("b", {}, p.blockedUntilPaymentReconciled.customers ? `${p.blockedUntilPaymentReconciled.customers} · ${moneyMap(p.blockedUntilPaymentReconciled.amount)}` : "none")),
      h("div", { class: "line" }, h("span", {}, "Owed outside PayPal or by hand"), h("b", {}, p.outsidePayPalOrManual.customers)),
      h("p", { class: "trade" }, p.tradeOff),
      p.againstKnownAnswers && h("p", { class: "truth" },
        `Against the known answers for this invented data: this option would pay for ${p.againstKnownAnswers.unitsPaidThatWereNotAffected} unit(s) that were not affected, and leaves ${p.againstKnownAnswers.affectedUnitsNotPaidNow} affected unit(s) unpaid for now.`),
      p.key === "include_likely" && p.ofWhichUnproven.customers > 0 && h("button", {
        class: "btn small", onclick: () => { state.filter = { eligibility: "supported|uncertain", label: "Unit supported or uncertain" }; render(); location.hash = "s3"; },
      }, "Review these records one by one")))),
    h("p", { class: "small muted", style: "margin-top:12px" }, "Choosing an option is not a button. To pay a record the records cannot prove, open it and confirm it in your name with a reason. To change what is owed, save a new version of the rules. Both withdraw any approval already given."));
}

// ----- 6. what was approved -----

function s6() {
  const { map, preview, batch, manifest } = state;
  if (!map.lastMatch || !preview) return section("s6", 6, "What was approved?", null, lockedNote("Run the match first."));
  const hint = "An approval covers one exact list of payments. If anything the list rests on changes, the approval is withdrawn.";

  if (!batch) {
    return section("s6", 6, "What was approved?", hint, h("div", { class: "card pad" },
      h("h3", {}, "Nothing has been approved yet"),
      h("p", {}, `${preview.totals.count} refund(s) could go on a payment list now, totalling ${moneyMap(Object.fromEntries(Object.entries(preview.totals.byCurrency).map(([c, v]) => [c, v.amountMinor])))}.`),
      leftOutTable(preview.held),
      h("div", { class: "actions" }, h("button", { class: "btn primary", disabled: preview.totals.count === 0, onclick: buildList }, "Build the payment list"))));
  }

  const b = batch.batch;
  const versions = batch.manifests || [];
  const withdrawn = !manifest && versions[0] && versions[0].status === "invalidated";
  const body = [];
  if (withdrawn) {
    body.push(h("div", { class: "banner stop" },
      h("b", {}, `Version ${versions[0].version} of this list, and any approval of it, was withdrawn.`), " What it would pay changed after it was built:",
      h("ul", {}, (versions[0].invalidated_reason || []).slice(0, 6).map((r) => h("li", {}, r.detail))),
      h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => batchAction("revise", {}, "A new version of the list was built. It needs a new approval.") }, "Build a new version of the list"))));
  }
  if (manifest) {
    const c = manifest.content;
    const total = c.items.reduce((a, i) => a + i.amountMinor, 0);
    body.push(h("div", { class: "card pad" },
      h("div", { class: "manifest-head" },
        h("h3", { style: "margin:0" }, `Payment list, version ${manifest.version}`),
        chip(b.status.replace(/_/g, " "), ["approved", "completed"].includes(b.status) ? "ok" : b.status === "completed_with_failures" ? "stop" : "info"),
        h("span", { class: "num" }, h("b", {}, `${c.items.length} payments · ${money(total, c.items[0] ? c.items[0].currency : "USD")}`)),
        h("a", { class: "btn small", href: `${orgUrl()}/batches/${b.id}/manifest?format=csv`, style: "margin-left:auto;text-decoration:none" }, "Export CSV"),
        h("a", { class: "btn small", href: `${orgUrl()}/batches/${b.id}/manifest`, target: "_blank", rel: "noopener", style: "text-decoration:none" }, "Open JSON")),
      h("p", { class: "hash", style: "margin:8px 0 12px" }, `sha-256 ${manifest.contentHash} · built ${day(c.createdAt)} ${clock(c.createdAt)} by ${c.createdBy.name} · rules version ${c.rule.version} · PayPal: ${c.environment}`),
      h("div", { class: "scroll-x", style: "max-height:340px;overflow-y:auto" }, h("table", { class: "plain" },
        h("thead", {}, h("tr", {}, ["#", "Order", "Customer", "Why payable", "Refund to PayPal payment", "Amount"].map((t) => h("th", {}, t)))),
        h("tbody", {}, c.items.map((i) => h("tr", {},
          h("td", { class: "num muted" }, i.n), h("td", { class: "mono" }, i.orderNumber), h("td", {}, i.customerName),
          h("td", {}, chip(PAYMENT[i.paymentIdentity][0], PAYMENT[i.paymentIdentity][1]), " ", chip(UNIT[i.eligibility][0], UNIT[i.eligibility][1]),
            i.confirmedBy && h("div", { class: "small muted" }, `confirmed by ${i.confirmedBy}: ${(i.confirmationBasis || "no basis recorded").replace(/_/g, " ")}`)),
          h("td", { class: "mono" }, i.captureId || i.recipient), h("td", { class: "right num" }, money(i.amountMinor, i.currency))))))),
      h("h3", { style: "margin-top:16px" }, `Left off this list · ${c.notIncluded.length}`), leftOutTable(c.notIncluded),
      h("div", { class: "actions" },
        b.status === "draft" && h("button", { class: "btn primary", onclick: () => batchAction("submit", {}, "Sent for approval.") }, "Send for approval"),
        b.status === "pending_approval" && h("button", { class: "btn primary", onclick: () => batchAction("decision", { decision: "approve", comment: "Checked against the list." }, "Approved. The approval covers this version of the list and no other.") }, `Approve exactly this list (version ${manifest.version})`),
        b.status === "pending_approval" && h("button", { class: "btn danger", onclick: () => batchAction("decision", { decision: "reject" }, "Rejected. Nobody will be paid from this list.") }, "Reject"),
        b.status === "approved" && h("button", { class: "btn primary", onclick: () => batchAction("start", {}, "Started. Each payment is checked against the approved list once more before it is sent.") }, "Start paying"),
        b.status === "pending_approval" && h("span", { class: "small muted" }, "In a real team a second person approves. This demo account has one user."))));
  }
  if (versions.length > 0) {
    body.push(h("div", { class: "card pad", style: "margin-top:14px" },
      h("h3", {}, "Versions and approvals"),
      h("table", { class: "plain" }, h("tbody", {},
        versions.map((v) => h("tr", {},
          h("td", {}, `Version ${v.version}`), h("td", {}, chip(v.status === "current" ? "in force" : v.status, v.status === "current" ? "ok" : v.status === "invalidated" ? "stop" : "")),
          h("td", { class: "hash" }, short(v.content_hash, 16)), h("td", { class: "small muted" }, `${v.item_count} payments · built ${clock(v.created_at)} by ${v.created_by || "–"}`))),
        (batch.approvals || []).map((a) => h("tr", {},
          h("td", {}, a.decision === "approve" ? "Approved" : "Rejected"), h("td", {}, a.name), h("td", { class: "hash" }, short(a.manifest_hash, 16)),
          h("td", { class: "small muted" }, `version ${a.manifest_version || "–"} · ${clock(a.created_at)}${a.comment ? ` · “${a.comment}”` : ""}`)))))));
  }
  if (["completed", "completed_with_failures"].includes(b.status) && preview.totals.count > 0) {
    body.push(h("div", { class: "actions" }, h("span", { class: "small muted" }, `${preview.totals.count} more record(s) became payable.`),
      h("button", { class: "btn", onclick: buildList }, "Build another payment list")));
  }
  return section("s6", 6, "What was approved?", hint, ...body);
}

function leftOutTable(held) {
  if (!held || held.length === 0) return h("p", { class: "small muted" }, "Nobody is left off.");
  return h("div", { class: "scroll-x", style: "max-height:240px;overflow-y:auto;margin-top:8px" }, h("table", { class: "plain" },
    h("thead", {}, h("tr", {}, ["Order", "Customer", "Why it is left off", "Would be"].map((t) => h("th", {}, t)))),
    h("tbody", {}, held.map((x) => h("tr", {},
      h("td", { class: "mono" }, x.orderNumber || "no order"), h("td", {}, x.customerName || x.customerEmail || "–"),
      h("td", {}, HELD_WHY[x.why] || x.why), h("td", { class: "right num" }, x.wouldPayMinor ? money(x.wouldPayMinor, x.currency || "USD") : "–"))))));
}

// ----- 7. what actually happened -----

function s7() {
  const { batch, map, evaluation, audit } = state;
  const body = [];
  if (!batch) return section("s7", 7, "What actually happened?", null, lockedNote("Nothing has been sent."));
  const b = batch.batch;
  const sim = map.dataLabels.paypal === "simulator";

  if (b.status === "approved" && sim && state.manifest) {
    const first = state.manifest.content.items[0];
    body.push(h("div", { class: "card pad", style: "margin-bottom:14px" },
      h("h3", {}, "Make something go wrong (simulator only)"),
      h("p", { class: "sub" }, "Two things that happen with real payments. Stage either before you start paying, and watch what the system does."),
      h("div", { class: "actions", style: "margin-top:0" },
        h("button", { class: "btn small", onclick: () => stageFault({ kind: "lose_next_reply" }) }, "Lose one reply from PayPal"),
        first && h("button", { class: "btn small", onclick: () => stageFault({ kind: "refund_elsewhere", captureId: first.captureId }) }, `Refund ${first.orderNumber} in the PayPal dashboard first`))));
  }

  const started = ["executing", "paused", "completed", "completed_with_failures", "cancelled"].includes(b.status);
  if (!started) body.push(lockedNote("Nothing has been sent. Payments start only after the list is approved."));
  else {
    const counts = {};
    batch.operations.forEach((o) => { const k = opLabel(o)[0]; counts[k] = (counts[k] || 0) + 1; });
    body.push(h("div", { class: "card pad" },
      h("div", { class: "manifest-head", style: "margin-bottom:10px" },
        h("h3", { style: "margin:0" }, "Each payment, as PayPal reports it"),
        Object.entries(counts).map(([k, n]) => chip(`${n} ${k.toLowerCase()}`, Object.values(OP_STATE).find((v) => v[0] === k)?.[1] || "stop")),
        b.paused_reason && chip(`paused: ${b.paused_reason}`, "hold")),
      h("div", { class: "scroll-x", style: "max-height:380px;overflow-y:auto" }, h("table", { class: "plain" },
        h("thead", {}, h("tr", {}, ["Order", "Customer", "Amount", "Status", "PayPal refund ID", "Calls", "Note"].map((t) => h("th", {}, t)))),
        h("tbody", {}, batch.operations.map((o) => h("tr", {},
          h("td", { class: "mono" }, o.order_number), h("td", {}, o.customer_name), h("td", { class: "right num" }, money(o.amount_minor, o.currency)),
          h("td", {}, chip(...opLabel(o))), h("td", { class: "mono" }, o.provider_refund_id || "–"), h("td", { class: "num" }, o.attempts),
          h("td", { class: "small" }, o.failure_message ? `${o.failure_code}: ${o.failure_message}` : o.attempts > 1 && o.state === "succeeded" ? "The first reply was lost. Asked again with the same request ID; PayPal returned the same refund." : "")))))),
      h("p", { class: "small muted", style: "margin-top:10px" }, "A payment shows as paid only when PayPal's own record says so. A failed refund stays failed: it is never sent some other way without a new decision by a person.")));
    const mine = (state.reconciliation || []).filter((r) => r.batch_id === b.id);
    if (mine.length > 0) {
      body.push(h("div", { class: "card pad", style: "margin-top:14px" }, h("h3", {}, "Differences found and how they were settled"),
        mine.map((r) => h("div", { class: "ev" }, h("div", { class: "meta" }, chip(r.status, r.status === "resolved" ? "ok" : "stop")), h("div", {}, h("b", {}, r.kind.replace(/_/g, " ")), h("div", { class: "small muted" }, r.resolution || "Open: a person is needed."))))));
    }
  }

  if (evaluation.available && started) body.push(kpis(evaluation));
  if (audit) {
    body.push(h("div", { class: "card pad", style: "margin-top:14px" },
      h("div", { class: "manifest-head" }, h("h3", { style: "margin:0" }, "Audit trail"),
        chip(audit.chain.ok ? `${audit.chain.rows} entries, chain intact` : "the chain is broken", audit.chain.ok ? "ok" : "stop")),
      h("p", { class: "sub", style: "margin-top:6px" }, "Every decision and every change, with who made it. Entries cannot be edited or deleted, and each one carries a hash of the one before."),
      h("div", { class: "audit" }, audit.rows.map((a) => h("div", {},
        h("span", { class: "muted" }, `${day(a.created_at)} ${clock(a.created_at)}`),
        h("span", {}, a.actor_name || (a.actor_kind === "ai" ? "Claude" : a.actor_kind)),
        h("span", {}, a.action.replace(/[._]/g, " ")))))));
  }
  return section("s7", 7, "What actually happened?", "PayPal's answer, not ours.", ...body);
}

function kpis(e) {
  const pct = (x) => (x === null ? "–" : `${Math.round(x * 100)}%`);
  const k = (n, text) => h("div", { class: "stat" }, h("div", { class: "n" }, n), h("div", { class: "t" }, text));
  return h("div", { class: "card pad", style: "margin-top:14px" },
    h("h3", {}, "Checked against the known answers"),
    h("p", { class: "sub" }, e.basis),
    h("div", { class: "kpis" },
      k(`${e.eligibility.correct} of ${e.eligibility.truthAffectedUnits}`, "affected units proven from records alone"),
      k(e.eligibility.wrongInclusions, "units called proven that were not affected"),
      k(`${e.eligibility.heldAffected + e.eligibility.heldNotAffected}`, `units held for a person (${e.eligibility.heldAffected} truly affected, ${e.eligibility.heldNotAffected} not)`),
      k(e.eligibility.missed, "affected units missed"),
      k(pct(e.eligibility.precision), "precision of “proven”"),
      k(`${e.payment.falseMatches}`, `payments tied to the wrong order (${e.payment.verifiedAndRight} right, ${e.payment.held} held)`),
      k(`${e.money.linesPaid - e.money.overpaidLines - e.money.underpaidLines} of ${e.money.linesPaid}`, "paid lines that received exactly what was owed"),
      k(e.duplicates.paymentsRefundedTwiceInThisIncident + e.money.paidToUnaffected, "double refunds, or refunds to unaffected customers")));
}

boot();
