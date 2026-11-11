// Make Good console. Plain JavaScript, no build step. All text from customers is escaped.
const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (c) => "$" + (Number(c || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (iso) => (iso ? String(iso).slice(0, 10) : "");
const LEVELS = { 1: "Exact", 2: "Likely", 3: "Product only", 4: "Amount only", 5: "Claim" };
const STATES = { ready: "Ready to pay", needs_confirm: "Needs confirmation", confirmed: "Confirmed", declined: "Not affected", excluded: "Excluded", queued: "In a batch", paid: "Paid", failed: "Failed" };
let status = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { method: opts.method || (opts.body ? "POST" : "GET"), headers: opts.raw ? { "Content-Type": "text/csv" } : { "Content-Type": "application/json" }, body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4500);
}
const guard = (fn) => async (...a) => {
  try {
    await fn(...a);
  } catch (e) {
    toast(e.message);
  }
};
const lvl = (n) => `<span class="chip lvl lvl${n}">${n} · ${LEVELS[n]}</span>`;
const stateChip = (s) => `<span class="chip ${s === "paid" || s === "completed" || s === "done" ? "live" : s === "failed" || s === "excluded" ? "bad" : s === "queued" || s === "running" || s === "approved" ? "info" : ""}">${esc(STATES[s] || s)}</span>`;

async function boot() {
  status = await api("/api/status");
  $("#shop").textContent = status.shop.name;
  $("#modes").innerHTML = `<span class="chip ${status.paypalMode === "mock" ? "mock" : "live"}">PayPal: ${status.paypalMode === "mock" ? "MOCK (sample data)" : "SANDBOX"}</span><span class="chip ${status.aiMode === "mock" ? "mock" : "live"}">AI: ${status.aiMode === "mock" ? "MOCK rules" : "Claude"}</span>`;
  window.addEventListener("hashchange", route);
  route();
}

function route() {
  const [, a, b, c] = location.hash.split("/");
  const go = a === "i" ? incidentPage(b, c || "rules") : a === "confirm" ? confirmPage(b) : a === "claim" ? claimPage(b) : a === "status" ? statusPage(b) : home();
  go.catch((e) => (app.innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a href="#/">Back to start</a></div>`));
}

// ------------------------------------------------------------------ home
async function home() {
  status = await api("/api/status");
  const incidents = await api("/api/incidents");
  app.innerHTML = `
    <div class="card">
      <h1>Pay back many customers at once, correctly.</h1>
      <p class="muted">Describe what went wrong. Make Good finds who is owed money from your PayPal payments and your order file, says how sure it is about each customer, and sends the refunds after you approve.</p>
    </div>
    <div class="grid2">
      <div class="card">
        <h2>Your shop's data</h2>
        <div class="tiles">
          <div class="tile"><b>${status.ledger.payments}</b><span>PayPal payments read</span></div>
          <div class="tile"><b>${status.ledger.orders}</b><span>orders imported</span></div>
        </div>
        <div class="row">
          <button id="reread">Read PayPal again</button>
          <label class="btn" style="cursor:pointer">Upload order file (CSV)<input id="csv" type="file" accept=".csv,text/csv" hidden></label>
          ${status.demo ? `<a class="small" href="/api/demo/orders.csv">Download the sample order file</a>` : ""}
        </div>
        <p class="small muted">PayPal knows who paid, when and how much. It does not know which batch a customer received, so the order file matters.</p>
      </div>
      <div class="card">
        <h2>Check for double charges</h2>
        <p class="muted">Looks for the same customer charged the same amount twice within 10 minutes. A plain rule, no AI.</p>
        <div class="row"><button id="scan">Scan the last 120 days</button></div>
        <div id="scanOut"></div>
      </div>
    </div>
    <div class="card">
      <h2>Start an incident</h2>
      <label>What happened? Write it in your own words.
        <textarea id="desc" placeholder="Example: batch B-2217 of mixer HM-300 has a faulty motor. It shipped between 10 Aug and 7 Sep. Refund the mixer in full."></textarea>
      </label>
      <div class="row">
        <button class="primary" id="draft">Draft the rules</button>
        ${status.demo ? `<button id="useDemo">Use the demo story</button>` : ""}
        <span class="small muted">${status.aiMode === "mock" ? "No AI key is set, so simple built-in rules write the draft." : "Claude writes a draft. You confirm it before anything happens."}</span>
      </div>
    </div>
    <div class="card">
      <h2>Incidents</h2>
      ${incidents.length === 0 ? `<p class="muted">None yet.</p>` : `<div class="scroll"><table><thead><tr><th>Incident</th><th>Status</th><th class="num">Customers</th><th class="num">Paid</th><th></th></tr></thead><tbody>${incidents
        .map((i) => {
          const n = i.counts.filter((c) => c.state !== "excluded").reduce((s, c) => s + c.n, 0);
          const paid = i.counts.filter((c) => c.state === "paid").reduce((s, c) => s + c.c, 0);
          return `<tr><td><b>${esc(i.title)}</b><div class="small muted">${day(i.created_at)}</div></td><td>${stateChip(i.status)}</td><td class="num">${n}</td><td class="num">${usd(paid)}</td><td><a href="#/i/${i.id}/${i.status === "draft" ? "rules" : "customers"}">Open</a></td></tr>`;
        })
        .join("")}</tbody></table></div>`}
    </div>`;

  $("#useDemo")?.addEventListener("click", () => ($("#desc").value = status.demo.description));
  $("#draft").addEventListener("click", guard(async () => {
    $("#draft").disabled = true;
    try {
      const out = await api("/api/incidents", { body: { description: $("#desc").value } });
      sessionStorage.setItem("unsure:" + out.incident.id, JSON.stringify(out.unsure));
      location.hash = `#/i/${out.incident.id}/rules`;
    } finally {
      $("#draft").disabled = false;
    }
  }));
  $("#reread").addEventListener("click", guard(async () => {
    const r = await api("/api/backfill", { body: {} });
    toast(`Read ${r.payments} payments in ${r.windows} requests.`);
    home();
  }));
  $("#csv").addEventListener("change", guard(async (e) => {
    const text = await e.target.files[0].text();
    const r = await api("/api/orders", { raw: text, method: "POST" });
    toast(`Imported ${r.lines} order lines; ${r.skipped.length} skipped.`);
    home();
  }));
  $("#scan").addEventListener("click", guard(async () => {
    const pairs = await api("/api/scan/duplicates");
    $("#scanOut").innerHTML = pairs.length === 0 ? `<p class="note good">No double charges found.</p>` : `<div class="note warn"><b>${pairs.length} customers were charged twice.</b><ul class="plain">${pairs.map((p) => `<li>${esc(p.name)}: ${esc(p.amount)} twice, ${p.minutesApart} minutes apart</li>`).join("")}</ul></div><div class="row"><button class="primary" id="openDup">Open an incident to refund the second charges</button></div>`;
    $("#openDup")?.addEventListener("click", guard(async () => {
      const inc = await api("/api/scan/duplicates/open", { body: {} });
      location.hash = `#/i/${inc.id}/customers`;
    }));
  }));
}

// ------------------------------------------------------------------ incident
async function incidentPage(id, tab) {
  const inc = await api(`/api/incidents/${id}`);
  const tabs = [["rules", "1 Rules"], ["customers", "2 Customers"], ["payments", "3 Payments"], ["claims", "4 Claims"], ["report", "5 Report"]];
  app.innerHTML = `
    <div class="row spread"><div><a class="small" href="#/">← All incidents</a><h1>${esc(inc.title)}</h1></div>${stateChip(inc.status)}</div>
    <nav class="tabs">${tabs.map(([k, t]) => `<a class="${k === tab ? "on" : ""}" href="#/i/${id}/${k}">${t}</a>`).join("")}</nav>
    <div id="tab"></div>`;
  const el = $("#tab");
  await { rules: rulesTab, customers: customersTab, payments: paymentsTab, claims: claimsTab, report: reportTab }[tab](inc, el);
}

async function rulesTab(inc, el) {
  if (inc.kind === "duplicate") {
    el.innerHTML = `<div class="card"><h2>Rules</h2><p class="note">This incident was opened by the double-charge scan. The rule is fixed: refund the second charge in full.</p><p>${esc(inc.description)}</p><a href="#/i/${inc.id}/customers">See the customers →</a></div>`;
    return;
  }
  const r = inc.rules;
  const unsure = JSON.parse(sessionStorage.getItem("unsure:" + inc.id) || "[]");
  const draftBy = inc.rules_source === "claude" ? "Claude" : "built-in rules (no AI key)";
  el.innerHTML = `
    <div class="card">
      <div class="row spread"><h2>Rules</h2><span class="chip ${inc.status === "draft" ? "mock" : "live"}">${inc.status === "draft" ? `Draft written by ${draftBy}` : "Confirmed by a person"}</span></div>
      <p class="muted">${esc(inc.description)}</p>
      ${unsure.length ? `<div class="note warn"><b>The draft was not sure about:</b><ul class="plain">${unsure.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></div>` : ""}
      <div class="form">
        <label class="wide">Incident name<input id="title" value="${esc(inc.title)}"></label>
        <label>Affected product<select id="sku">${status.ledger.skus.map((s) => `<option value="${esc(s.sku)}" ${s.sku === r.sku ? "selected" : ""}>${esc(s.sku)} · ${esc(s.item_name || "")}</option>`).join("")}</select></label>
        <label>Affected batch code (empty = every unit)<input id="batch" value="${esc(r.batch || "")}"></label>
        <label>Batch shipped from<input id="shipFrom" type="date" value="${day(r.shipFrom)}"></label>
        <label>Batch shipped until<input id="shipTo" type="date" value="${day(r.shipTo)}"></label>
        <label>Bought from (optional)<input id="paidFrom" type="date" value="${day(r.paidFrom)}"></label>
        <label>Bought until (optional)<input id="paidTo" type="date" value="${day(r.paidTo)}"></label>
        <label>What each customer gets<select id="remedy"><option value="full_line" ${r.remedy === "full_line" ? "selected" : ""}>Full price of the affected item</option><option value="percent" ${r.remedy === "percent" ? "selected" : ""}>A percentage of the item</option><option value="fixed" ${r.remedy === "fixed" ? "selected" : ""}>A fixed amount</option></select></label>
        <label>Percentage or fixed amount<input id="amount" placeholder="e.g. 20 or 10.00" value="${r.remedy === "percent" ? r.percent ?? "" : r.remedy === "fixed" ? ((r.fixedCents ?? 0) / 100).toFixed(2) : ""}"></label>
        <label class="wide">Message to customers<textarea id="notice">${esc(r.notice)}</textarea></label>
        <label class="wide">What a claimant with no record must show (one per line)<textarea id="facts">${esc((r.claimFacts || []).join("\n"))}</textarea></label>
      </div>
      <div class="row">
        <button class="primary" id="confirm">Confirm rules and find affected customers</button>
        <span class="small muted">Only the item is refunded: not shipping, and not other items in the order.</span>
      </div>
    </div>`;
  const iso = (d, end) => (d ? new Date(`${d}T${end ? "23:59:59.999" : "00:00:00.000"}Z`).toISOString() : null);
  $("#confirm").addEventListener("click", guard(async () => {
    const remedy = $("#remedy").value;
    const amount = $("#amount").value.trim();
    const rules = {
      sku: $("#sku").value, batch: $("#batch").value.trim() || null,
      paidFrom: iso($("#paidFrom").value), paidTo: iso($("#paidTo").value, true), shipFrom: iso($("#shipFrom").value), shipTo: iso($("#shipTo").value, true),
      remedy, percent: remedy === "percent" ? Number(amount) : undefined, fixedCents: remedy === "fixed" ? Math.round(Number(amount) * 100) : undefined,
      capCents: null, claimFacts: $("#facts").value.split("\n").map((s) => s.trim()).filter(Boolean), notice: $("#notice").value.trim(),
    };
    await api(`/api/incidents/${inc.id}/rules`, { method: "PUT", body: { rules, title: $("#title").value.trim() } });
    const m = await api(`/api/incidents/${inc.id}/match`, { body: {} });
    toast(`${m.ready.count} customers are ready to pay; ${m.needsConfirm.count} need to confirm.`);
    location.hash = `#/i/${inc.id}/customers`;
  }));
}

async function customersTab(inc, el) {
  const rows = await api(`/api/incidents/${inc.id}/affected`);
  if (rows.length === 0) {
    el.innerHTML = `<div class="card"><p>No customers yet. <a href="#/i/${inc.id}/rules">Confirm the rules</a> to find them.</p></div>`;
    return;
  }
  const live = rows.filter((r) => r.state !== "excluded" && r.state !== "declined");
  const sum = (xs) => xs.reduce((s, r) => s + r.owed_cents, 0);
  const ready = rows.filter((r) => r.state === "ready" || r.state === "confirmed");
  const need = rows.filter((r) => r.state === "needs_confirm");
  const excluded = rows.filter((r) => r.state === "excluded");
  el.innerHTML = `
    <div class="tiles">${[1, 2, 3, 4, 5].filter((n) => live.some((r) => r.level === n)).map((n) => { const xs = live.filter((r) => r.level === n); return `<div class="tile l${n}"><b>${xs.length}</b><span>${n} · ${LEVELS[n]} · ${usd(sum(xs))}</span></div>`; }).join("")}
      <div class="tile"><b>${excluded.length}</b><span>excluded${excluded.length ? ": " + esc([...new Set(excluded.map((r) => r.excluded_reason))].join("; ").toLowerCase()) : ""}</span></div></div>
    <div class="card">
      <div class="row spread">
        <div><h2>${ready.length} ready to pay · ${usd(sum(ready))}</h2><p class="small muted">${need.length} more need the customer to confirm the batch code (${usd(sum(need))}). They are not paid until they do.</p></div>
        <button class="primary" id="mkBatch" ${ready.length ? "" : "disabled"}>Create a batch for the ${ready.length} ready customers</button>
      </div>
      <div class="row"><label style="max-width:240px">Show<select id="filter"><option value="">Everyone (${rows.length})</option>${Object.keys(STATES).filter((s) => rows.some((r) => r.state === s)).map((s) => `<option value="${s}">${STATES[s]} (${rows.filter((r) => r.state === s).length})</option>`).join("")}</select></label></div>
      <div class="scroll"><table><thead><tr><th>Customer</th><th>Order or payment</th><th>Paid</th><th>How sure</th><th class="num">Owed</th><th>Status</th><th>Why</th></tr></thead><tbody id="rows"></tbody></table></div>
    </div>`;
  const draw = () => {
    const f = $("#filter").value;
    $("#rows").innerHTML = rows.filter((r) => !f || r.state === f).slice(0, 600).map((r) => `<tr>
      <td>${esc(r.customer_name || "")}<div class="small muted">${esc(r.email || "")}</div></td>
      <td class="mono">${esc(r.order_number || r.ref_key)}</td><td>${day(r.paid_at)}</td><td>${lvl(r.level)}</td><td class="num">${usd(r.owed_cents)}</td>
      <td>${stateChip(r.state)}${r.state === "needs_confirm" ? `<div class="small"><a href="#/confirm/${r.confirm_token}" target="_blank">customer's confirm page</a></div>` : ""}</td>
      <td class="small">${esc(r.excluded_reason || r.why)}</td></tr>`).join("");
  };
  $("#filter").addEventListener("change", draw);
  draw();
  $("#mkBatch").addEventListener("click", guard(async () => {
    await api(`/api/incidents/${inc.id}/batches`, { body: { label: `Batch of ${ready.length} customers` } });
    location.hash = `#/i/${inc.id}/payments`;
  }));
}

async function paymentsTab(inc, el) {
  const batches = await api(`/api/incidents/${inc.id}/batches`);
  if (batches.length === 0) {
    el.innerHTML = `<div class="card"><p>No batches yet. Create one from the <a href="#/i/${inc.id}/customers">customers</a> tab.</p></div>`;
    return;
  }
  el.innerHTML = batches.map((b) => {
    const p = b.preview;
    const done = b.items.filter((i) => i.state !== "queued").length;
    const tooOld = b.items.some((i) => i.error === "REFUND_TIME_LIMIT_EXCEEDED");
    return `<div class="card" data-batch="${b.id}">
      <div class="row spread"><h2>${esc(b.label)}</h2>${stateChip(b.state)}</div>
      <div class="tiles">
        <div class="tile"><b>${usd(p.totalCents)}</b><span>${b.item_count} payments in total</span></div>
        <div class="tile"><b>${p.refunds.count}</b><span>refunds to the original payment · ${usd(p.refunds.cents)}</span></div>
        <div class="tile"><b>${p.payouts.count}</b><span>payouts by email · ${usd(p.payouts.cents)} · fees about ${usd(p.payouts.feeCents)}</span></div>
        <div class="tile"><b>${p.balanceCents === null ? "n/a" : usd(p.balanceCents)}</b><span>PayPal balance now</span></div>
      </div>
      ${p.payouts.count ? `<p class="note">Why payouts: ${Object.entries(p.payouts.reasons).map(([k, v]) => `${v} × ${esc(k)}`).join("; ")}. A payout is a new payment to the customer's email, and an unclaimed one returns after 30 days.</p>` : ""}
      <p class="small muted">On a refund, PayPal does not return the fees you paid on the original sale.</p>
      <div class="row">
        ${b.state === "draft" ? `<button class="primary" data-act="approve">Approve this batch</button><span class="small muted">Nothing is sent until you approve.</span>` : ""}
        ${b.state === "approved" || b.state === "paused" ? `<button class="primary" data-act="run">${b.state === "paused" ? "Resume sending" : "Send the money"}</button><span class="small muted">Approved by ${esc(b.approved_by || "")}.</span>` : ""}
        ${tooOld ? `<button data-act="reroute">Queue the too-old refunds as payouts</button>` : ""}
      </div>
      <div class="bar"><i style="width:${b.item_count ? (100 * done) / b.item_count : 0}%"></i></div>
      <p class="small muted" data-progress>${done} of ${b.item_count} answered by PayPal.</p>
      <div class="scroll" style="max-height:340px"><table><thead><tr><th>Customer</th><th>Order</th><th>Kind</th><th class="num">Amount</th><th>PayPal's answer</th><th>PayPal ID</th></tr></thead><tbody>${b.items.slice(0, 400).map((i) => `<tr>
        <td>${esc(i.customer_name || i.email || "")}</td><td class="mono">${esc(i.ref_key)}</td><td>${i.kind}</td><td class="num">${usd(i.amount_cents)}</td>
        <td>${stateChip(i.state === "queued" ? "queued" : i.state)}${i.error ? `<div class="small muted">${esc(i.error)}</div>` : ""}</td><td class="mono">${esc(i.paypal_id || "")}</td></tr>`).join("")}</tbody></table></div>
    </div>`;
  }).join("");

  el.querySelectorAll("[data-batch]").forEach((card) => {
    const bid = card.dataset.batch;
    card.querySelector('[data-act="approve"]')?.addEventListener("click", guard(async () => {
      await api(`/api/batches/${bid}/approve`, { body: {} });
      paymentsTab(inc, el);
    }));
    card.querySelector('[data-act="reroute"]')?.addEventListener("click", guard(async () => {
      await api(`/api/batches/${bid}/reroute`, { body: {} });
      paymentsTab(inc, el);
    }));
    card.querySelector('[data-act="run"]')?.addEventListener("click", guard(async (e) => {
      e.target.disabled = true;
      const total = batches.find((b) => b.id === bid).item_count;
      let done = batches.find((b) => b.id === bid).items.filter((i) => i.state !== "queued").length;
      const es = new EventSource(`/api/batches/${bid}/events`);
      es.addEventListener("item", () => {
        done++;
        card.querySelector(".bar i").style.width = `${(100 * done) / total}%`;
        card.querySelector("[data-progress]").textContent = `${done} of ${total} answered by PayPal.`;
      });
      let finished = false;
      const finish = (s) => {
        if (finished) return;
        finished = true;
        es.close();
        clearInterval(poll);
        toast(s === "done" ? "All payments in this batch were answered by PayPal." : "The batch was paused. See the reason in the report.");
        paymentsTab(inc, el);
      };
      es.addEventListener("state", (ev) => {
        const s = JSON.parse(ev.data).state;
        if (s === "done" || s === "paused") finish(s);
      });
      // Wait for the live connection before starting, so no update is missed.
      await new Promise((res) => {
        es.onopen = res;
        setTimeout(res, 1500);
      });
      await api(`/api/batches/${bid}/run`, { body: {} });
      // Fallback: if the live connection drops, ask the server directly.
      const poll = setInterval(async () => {
        const b = (await api(`/api/incidents/${inc.id}/batches`)).find((x) => x.id === bid);
        if (b && (b.state === "done" || b.state === "paused")) finish(b.state);
      }, 1500);
    }));
  });
}

async function claimsTab(inc, el) {
  const claims = await api(`/api/incidents/${inc.id}/claims`);
  el.innerHTML = `
    <div class="card">
      <div class="row spread"><h2>Claims from people not on the list</h2><a class="btn" href="#/claim/${inc.id}" target="_blank">Open the public claim page</a></div>
      <p class="muted">Each claim is checked against your records first. AI reads the rest for you and points out concerns. It cannot approve a claim; you decide.</p>
      ${claims.length === 0 ? `<p class="muted">No claims yet.</p>` : claims.map((c) => `<div class="claim" data-claim="${c.id}">
        <div class="row spread"><b>${esc(c.email)}</b><span class="row">${c.order_ref ? `<span class="chip">order ${esc(c.order_ref)}</span>` : ""}${c.batch_code ? `<span class="chip">batch ${esc(c.batch_code)}</span>` : ""}<span class="chip ${c.decision === "approved" || c.decision === "moved-to-records" ? "live" : c.decision === "rejected" ? "bad" : "mock"}">${esc(c.decision === "review" ? "Needs your decision" : c.decision === "moved-to-records" ? "Found in your records" : c.decision)}</span></span></div>
        <p>${esc(c.text)}</p>
        ${c.flags.length ? `<div class="note warn"><ul class="plain">${c.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
        ${c.ai ? `<div class="small"><span class="chip actor">${c.ai.source === "claude" ? "AI reading" : "Rule-based reading"}</span> ${esc(c.ai.summary)}<ul class="plain">${c.ai.facts.map((f) => `<li>${esc(f.fact)}: <b>${esc(f.met)}</b>${f.quote ? ` <span class="quote">“${esc(f.quote)}”</span>` : ""}</li>`).join("")}</ul></div>` : ""}
        ${c.decision_note ? `<p class="small muted">${esc(c.decided_by === "rule" ? "Rule" : c.decided_by || "")}: ${esc(c.decision_note)}</p>` : ""}
        ${c.decision === "review" ? `<div class="row"><input placeholder="Your reason (kept in the record)" style="max-width:380px"><button class="primary" data-ok="1">Approve</button><button class="danger" data-ok="0">Reject</button></div>` : ""}
      </div>`).join("")}
    </div>`;
  el.querySelectorAll("[data-claim]").forEach((card) => card.querySelectorAll("button[data-ok]").forEach((btn) => btn.addEventListener("click", guard(async () => {
    await api(`/api/claims/${card.dataset.claim}/decision`, { body: { approve: btn.dataset.ok === "1", note: card.querySelector("input").value } });
    toast(btn.dataset.ok === "1" ? "Approved. The claimant is now ready to be added to a batch." : "Rejected.");
    claimsTab(inc, el);
  }))));
}

async function reportTab(inc, el) {
  const r = await api(`/api/incidents/${inc.id}/report`);
  const st = (k) => r.byState[k] || { count: 0, cents: 0 };
  el.innerHTML = `
    <div class="tiles">
      <div class="tile"><b>${usd(r.paid.refundCents + r.paid.payoutCents)}</b><span>confirmed paid by PayPal</span></div>
      <div class="tile"><b>${r.paid.refunds}</b><span>refunds completed</span></div>
      <div class="tile"><b>${r.paid.payouts}</b><span>payouts completed</span></div>
      <div class="tile"><b>${r.waiting.count}</b><span>waiting (unclaimed or pending) · ${usd(r.waiting.cents)}</span></div>
      <div class="tile"><b>${st("needs_confirm").count}</b><span>still need the customer to confirm</span></div>
      <div class="tile"><b>${r.failed.length}</b><span>failed</span></div>
    </div>
    <div class="grid2">
      <div class="card"><h2>By how sure we were</h2><table><thead><tr><th>Level</th><th class="num">Customers</th><th class="num">Owed</th></tr></thead><tbody>${r.byLevel.map((l) => `<tr><td>${lvl(l.level)}</td><td class="num">${l.count}</td><td class="num">${usd(l.cents)}</td></tr>`).join("")}</tbody></table>
        ${r.excluded.length ? `<h3>Left out, and why</h3><ul class="plain">${r.excluded.map((e) => `<li>${e.count} · ${esc(e.reason)}</li>`).join("")}</ul>` : ""}
        ${r.failed.length ? `<h3>Failed payments</h3><ul class="plain">${r.failed.map((f) => `<li class="mono">${esc(f.ref)} ${esc(f.kind)} ${esc(f.amount)}: ${esc(f.error || "")}</li>`).join("")}</ul>` : ""}
        <h3>Claims</h3><p class="small">${Object.entries(r.claims).map(([k, v]) => `${v} ${esc(k)}`).join(" · ") || "none"}</p>
      </div>
      <div class="card"><h2>What happened, and who did it</h2><div class="timeline">${r.events.map((e) => `<div><span class="chip actor ${e.actor === "paypal" ? "live" : e.actor === "ai" ? "info" : e.actor === "person" ? "" : "mock"}">${esc(e.actor)}</span><span>${esc(e.detail)}<span class="small muted"> · ${esc(e.at.slice(11, 19))}</span></span></div>`).join("")}</div></div>
    </div>`;
}

// ------------------------------------------------------------------ public pages (what a customer sees)
const publicShell = (inner) => (app.innerHTML = `<div class="card public">${inner}</div>`);

async function confirmPage(tok) {
  const c = await api(`/api/public/confirm/${tok}`);
  publicShell(`
    <p class="small muted">${esc(c.shop)}</p><h1>Hi ${esc(c.name)}, please check your ${esc(c.product)}</h1>
    <p>Some units of this product have a fault. We think yours may be one of them${c.order ? ` (order ${esc(c.order)})` : ""}. If it is, we will refund ${esc(c.amount)} to your original payment.</p>
    ${c.state === "needs_confirm" ? `<label>Type the batch code printed on the base of the product<input id="code" placeholder="for example B-1234" autocomplete="off"></label><div class="row"><button class="primary" id="send">Check my product</button></div>` : `<p class="note">${esc(STATES[c.state] || c.state)}. <a href="#/status/${c.statusToken}">See your status</a></p>`}
    <div id="out"></div>`);
  $("#send")?.addEventListener("click", guard(async () => {
    const r = await api(`/api/public/confirm/${tok}`, { body: { code: $("#code").value } });
    $("#out").innerHTML = `<p class="note ${r.ok ? "good" : ""}">${esc(r.message)} ${r.statusToken ? `<a href="#/status/${r.statusToken}">See your status</a>` : ""}</p>`;
    $("#send").disabled = true;
  }));
}

async function claimPage(incidentId) {
  const i = await api(`/api/public/incident/${incidentId}`);
  publicShell(`
    <p class="small muted">${esc(i.shop)}</p><h1>Claim a refund: ${esc(i.title)}</h1>
    <p>Most affected customers are refunded without doing anything. Use this form only if you have not heard from us. We check every claim against our payment records, and a person reviews it.</p>
    ${i.facts.length ? `<div class="note"><b>Please include:</b><ul class="plain">${i.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
    <div class="form">
      <label>Your email<input id="email" type="email" autocomplete="email"></label>
      <label>Order number, if you have it<input id="order"></label>
      ${i.needsBatch ? `<label>Batch code printed on the product<input id="batch"></label>` : ""}
      <label class="wide">What happened?<textarea id="text"></textarea></label>
    </div>
    <div class="row"><button class="primary" id="send">Send my claim</button></div><div id="out"></div>`);
  $("#send").addEventListener("click", guard(async () => {
    const r = await api("/api/public/claims", { body: { incidentId, email: $("#email").value, orderRef: $("#order").value, batchCode: $("#batch")?.value, text: $("#text").value } });
    $("#send").disabled = true;
    $("#out").innerHTML = `<p class="note good">${esc(r.note || "Thank you. A person will review your claim.")} <a href="#/status/${r.statusToken}">Follow your claim</a></p>`;
  }));
}

async function statusPage(tok) {
  const s = await api(`/api/public/status/${tok}`);
  const p = s.payment;
  const line = p
    ? p.state === "completed" ? `Your ${p.kind} of ${p.amount} was completed on ${day(p.at)}.`
      : p.state === "unclaimed" ? `We sent ${p.amount} to your email. Please accept it within 30 days.`
      : p.state === "failed" ? `We could not send your ${p.kind}. We are looking into it.`
      : `Your ${p.kind} of ${p.amount} is on its way.`
    : s.claim ? ({ review: "A person is reviewing your claim.", approved: "Your claim was approved. Your payment is being prepared.", rejected: "Your claim was not accepted.", "moved-to-records": "We found you in our records. Your refund is being prepared." })[s.claim.decision]
    : s.customer ? ({ needs_confirm: "We need you to confirm your batch code.", confirmed: "Confirmed. Your refund is being prepared.", ready: "Your refund is being prepared.", declined: "Your product is not from the affected batch.", excluded: "This order is not part of the refund programme." })[s.customer.state] || "" : "";
  publicShell(`
    <p class="small muted">${esc(s.shop)} · ${esc(s.email)}</p><h1>Your refund status</h1>
    <p class="note ${p?.state === "completed" ? "good" : ""}">${esc(line)}</p>
    ${s.claim?.note ? `<p>${esc(s.claim.note)}</p>` : ""}
    ${p?.paypalId ? `<p class="small muted">PayPal reference: <span class="mono">${esc(p.paypalId)}</span>${p.mock ? " (MOCK: sample data, not a real PayPal record)" : ""}</p>` : ""}
    ${s.claim?.decision === "rejected" ? `<p class="small">If you think this is wrong, reply to the shop's email and ask for a second look.</p>` : ""}`);
}

boot().catch((e) => (app.innerHTML = `<p class="pad">${esc(e.message)}</p>`));
