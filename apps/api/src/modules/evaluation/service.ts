// Measuring the product against known answers.
//
// The sample-data loader invents merchant records and so knows, for each one,
// whether the customer really holds an affected unit, which PayPal payment
// really paid for the order, and what a correct refund would be. Those
// answers are in `evaluation_labels`. The matching engine never reads them.
//
// This file compares what the system concluded and did with those answers.
// Every figure it returns is a count from this database, for this incident.
// It is evidence about the prototype on synthetic records. It is not evidence
// about merchants, and it says so in its own output.

import type { Queryable } from "../../platform/db/db.ts";

type LabelRow = {
  order_id: string; order_line_id: string; order_number: string; case_tag: string; note: string; affected_units: number;
  owed_minor: number; currency: string; true_capture_id: string | null; quantity: number; dataset: string;
};
type CandidateRow = {
  id: string; order_id: string | null; order_line_id: string | null; status: string; eligibility: string; payment_identity: string;
  decision: string; affected_quantity: number; decided_by: string | null; created_at: Date; decided_at: Date | null;
  payable_minor: number | null; route: string | null; capture_id: string | null; paid_minor: number; refunds: number;
};

export type CaseVerdict = "correct" | "held_for_review" | "missed" | "wrong_inclusion" | "correctly_left_out";

const ratio = (a: number, b: number): number | null => (b === 0 ? null : Math.round((a / b) * 1000) / 1000);
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

export async function evaluateIncident(q: Queryable, orgId: string, incidentId: string) {
  const labels = await q.query<LabelRow>(
    `select l.order_id, l.order_line_id, o.order_number, l.case_tag, l.note, l.affected_units, l.owed_minor, trim(l.currency) as currency,
            l.true_capture_id, ol.quantity, l.dataset
       from evaluation_labels l
       join orders o on o.org_id = l.org_id and o.id = l.order_id
       join order_lines ol on ol.org_id = l.org_id and ol.id = l.order_line_id
      where l.org_id = $1 order by o.order_number, l.id`,
    [orgId],
  );
  if (labels.length === 0) {
    return {
      available: false as const,
      why: "There are no known answers for this organisation's records. Accuracy can only be measured on sample data whose right answers are known, or on a merchant's incident that was checked by hand afterwards.",
    };
  }
  const candidates = await q.query<CandidateRow>(
    `select c.id, c.order_id, c.order_line_id, c.status, c.eligibility, c.payment_identity, c.decision, c.affected_quantity,
            c.decided_by, c.created_at, c.decided_at, k.payable_minor, k.route, p.transaction_id as capture_id,
            coalesce((select sum(op.amount_minor) from payment_operations op
                       where op.org_id = c.org_id and op.candidate_id = c.id and op.state = 'succeeded'), 0)::bigint as paid_minor,
            (select count(*) from payment_operations op
              where op.org_id = c.org_id and op.candidate_id = c.id and op.state = 'succeeded')::int as refunds
       from candidates c
       left join compensation_calculations k on k.org_id = c.org_id and k.candidate_id = c.id and k.is_current
       left join payment_transactions p on p.org_id = c.org_id and p.id = c.payment_transaction_id
      where c.org_id = $1 and c.incident_id = $2`,
    [orgId, incidentId],
  );
  const byLine = new Map<string, CandidateRow[]>();
  for (const c of candidates) {
    if (c.order_line_id) byLine.set(c.order_line_id, [...(byLine.get(c.order_line_id) ?? []), c]);
  }

  // ---------- 1. who is affected ----------
  const eligibility = { truthAffectedUnits: 0, engineProvenUnits: 0, correct: 0, wrongInclusions: 0, heldAffected: 0, heldNotAffected: 0, missed: 0, notSeenLines: 0 };
  const people = { confirmed: 0, confirmedAndAffected: 0, confirmedButNotAffected: 0, declined: 0, declinedButAffected: 0 };
  const cases: Array<{
    orderNumber: string; caseTag: string; note: string; truthAffectedUnits: number; engine: { proven: number; held: number; cleared: number; seen: boolean };
    verdict: CaseVerdict; paymentVerdict: string; owedMinor: number; wouldPayMinor: number | null; paidMinor: number;
  }> = [];
  // ---------- 2. which payment ----------
  const payment = { orders: 0, verifiedAndRight: 0, falseMatches: 0, held: 0, heldWhereGuessWasRight: 0, noPayPalPayment: 0 };
  // ---------- 3. how much ----------
  const amounts = { compared: 0, exact: 0, mismatches: [] as Array<{ orderNumber: string; expectedMinor: number; calculatedMinor: number }> };
  // ---------- 4. what was actually paid ----------
  const money = { linesPaid: 0, paidMinor: 0, owedOnPaidLinesMinor: 0, overpaidLines: 0, underpaidLines: 0, paidToUnaffected: 0, linesRefundedMoreThanOnce: 0 };

  for (const label of labels) {
    const rows = byLine.get(label.order_line_id) ?? [];
    const live = rows.filter((r) => r.status !== "cleared");
    const proven = live.filter((r) => r.eligibility === "proven").reduce((a, r) => a + r.affected_quantity, 0);
    const held = live
      .filter((r) => r.eligibility !== "proven" && ["proposed", "confirmed", "declined"].includes(r.status))
      .reduce((a, r) => a + r.affected_quantity, 0);
    const cleared = rows.filter((r) => r.status === "cleared").reduce((a, r) => a + r.affected_quantity, 0);
    const truth = label.affected_units;
    const correct = Math.min(proven, truth);
    const wrong = Math.max(0, proven - truth);
    const heldAffected = Math.min(held, truth - correct);
    const missed = truth - correct - heldAffected;
    eligibility.truthAffectedUnits += truth;
    eligibility.engineProvenUnits += proven;
    eligibility.correct += correct;
    eligibility.wrongInclusions += wrong;
    eligibility.heldAffected += heldAffected;
    eligibility.heldNotAffected += held - heldAffected;
    eligibility.missed += missed;
    if (rows.length === 0) eligibility.notSeenLines++;

    for (const r of live) {
      if (r.eligibility === "proven" || !r.decided_by) continue;
      if (r.status === "confirmed") {
        people.confirmed++;
        if (truth > 0) people.confirmedAndAffected++;
        else people.confirmedButNotAffected++;
      } else if (r.status === "declined") {
        people.declined++;
        if (truth > 0) people.declinedButAffected++;
      }
    }

    const verdict: CaseVerdict =
      wrong > 0 ? "wrong_inclusion"
      : missed > 0 ? "missed"
      : held > 0 ? "held_for_review"
      : truth > 0 ? "correct"
      : "correctly_left_out";

    // Payment identity is judged once per order line that the engine holds as a record.
    let paymentVerdict = "not_applicable";
    const subject = live[0];
    if (subject) {
      payment.orders++;
      if (subject.payment_identity === "verified") {
        if (label.true_capture_id && subject.capture_id === label.true_capture_id) {
          payment.verifiedAndRight++;
          paymentVerdict = "verified_and_right";
        } else {
          payment.falseMatches++;
          paymentVerdict = "false_match";
        }
      } else if (subject.payment_identity === "not_paypal" || (subject.payment_identity === "missing" && !label.true_capture_id)) {
        payment.noPayPalPayment++;
        paymentVerdict = "no_paypal_payment";
      } else {
        payment.held++;
        paymentVerdict = "held";
        if (label.true_capture_id && subject.capture_id === label.true_capture_id) payment.heldWhereGuessWasRight++;
      }
    }

    // Amounts: only where the system would itself pay through PayPal.
    const payable = live.filter((r) => r.status === "confirmed" && r.payment_identity === "verified" && r.route === "refund_original");
    const paidMinor = live.reduce((a, r) => a + r.paid_minor, 0);
    let wouldPay: number | null = null;
    if (payable.length > 0 && paidMinor === 0) {
      wouldPay = payable.reduce((a, r) => a + (r.payable_minor ?? 0), 0);
      amounts.compared++;
      if (wouldPay === label.owed_minor) amounts.exact++;
      else amounts.mismatches.push({ orderNumber: label.order_number, expectedMinor: label.owed_minor, calculatedMinor: wouldPay });
    }
    if (paidMinor > 0) {
      money.linesPaid++;
      money.paidMinor += paidMinor;
      money.owedOnPaidLinesMinor += label.owed_minor;
      if (paidMinor > label.owed_minor) money.overpaidLines++;
      if (paidMinor < label.owed_minor) money.underpaidLines++;
      if (truth === 0) money.paidToUnaffected++;
      if (live.some((r) => r.refunds > 1)) money.linesRefundedMoreThanOnce++;
    }
    cases.push({
      orderNumber: label.order_number, caseTag: label.case_tag, note: label.note, truthAffectedUnits: truth,
      engine: { proven, held, cleared, seen: rows.length > 0 }, verdict, paymentVerdict,
      owedMinor: label.owed_minor, wouldPayMinor: wouldPay, paidMinor,
    });
  }

  // ---------- 5. duplicates, completion and reconciliation (all payments of the incident, labelled or not) ----------
  const [dupes] = await q.query<{ n: number }>(
    `select count(*)::int as n from (
       select op.capture_id from payment_operations op
        where op.org_id = $1 and op.incident_id = $2 and op.kind = 'refund' and op.state = 'succeeded'
        group by op.capture_id having count(*) > 1) d`,
    [orgId, incidentId],
  );
  const [overCapture] = await q.query<{ n: number }>(
    `select count(*)::int as n from payment_transactions p
      where p.org_id = $1 and p.kind = 'payment'
        and (select coalesce(sum(op.amount_minor), 0) from payment_operations op
              where op.org_id = p.org_id and op.kind = 'refund' and op.state = 'succeeded' and op.capture_id = p.transaction_id) > p.gross_minor`,
    [orgId],
  );
  const states = await q.query<{ state: string; failure_code: string | null; n: number; amount_minor: number }>(
    `select state, failure_code, count(*)::int as n, coalesce(sum(amount_minor), 0)::bigint as amount_minor
       from payment_operations where org_id = $1 and incident_id = $2 group by 1, 2 order by 1`,
    [orgId, incidentId],
  );
  const recon = await q.query<{ kind: string; status: string; n: number }>(
    `select r.kind, r.status, count(*)::int as n from reconciliation_items r
       join payment_operations op on op.org_id = r.org_id and op.id = r.operation_id
      where r.org_id = $1 and op.incident_id = $2 group by 1, 2`,
    [orgId, incidentId],
  );
  const [calls] = await q.query<{ attempts: number; operations: number }>(
    `select count(*)::int as attempts, count(distinct a.operation_id)::int as operations
       from provider_attempts a join payment_operations op on op.org_id = a.org_id and op.id = a.operation_id
      where a.org_id = $1 and op.incident_id = $2`,
    [orgId, incidentId],
  );

  // ---------- 6. work left for people ----------
  const records = candidates.filter((c) => c.status !== "cleared");
  const needPerson = records.filter((c) => c.status === "proposed");
  const workload = {
    records: records.length,
    settledByRecordsAlone: records.filter((c) => c.status === "confirmed" && !c.decided_by).length,
    waitingForAPerson: needPerson.length,
    waitingByReason: needPerson.reduce<Record<string, number>>((acc, c) => ((acc[c.decision] = (acc[c.decision] ?? 0) + 1), acc), {}),
    decidedByAPerson: records.filter((c) => c.decided_by !== null).length,
    leftOutByTheRecords: candidates.filter((c) => c.status === "cleared" || c.status === "excluded").length,
  };

  // ---------- 7. time ----------
  const [times] = await q.query<{ created_at: Date; first_match: Date | null; first_approval: Date | null; last_finish: Date | null }>(
    `select i.created_at,
            (select min(finished_at) from match_runs m where m.org_id = i.org_id and m.incident_id = i.id) as first_match,
            (select min(approved_at) from batches b where b.org_id = i.org_id and b.incident_id = i.id) as first_approval,
            (select max(finished_at) from batches b where b.org_id = i.org_id and b.incident_id = i.id and b.status in ('completed', 'completed_with_failures')) as last_finish
       from incidents i where i.org_id = $1 and i.id = $2`,
    [orgId, incidentId],
  );
  const seconds = (from: Date | null | undefined, to: Date | null | undefined) =>
    from && to ? Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000)) : null;
  const decisionSeconds = records
    .filter((c) => c.decided_at !== null)
    .map((c) => Math.max(0, Math.round((new Date(c.decided_at!).getTime() - new Date(c.created_at).getTime()) / 1000)));

  return {
    available: true as const,
    dataset: labels[0]!.dataset,
    basis:
      "Synthetic merchant records whose right answers were fixed when the records were invented. The matching engine cannot read those answers. These figures describe this prototype on this data set. They are not measurements of any merchant, and say nothing about demand or about disputes avoided.",
    labelledLines: labels.length,
    eligibility: {
      ...eligibility,
      /** Of the units the system called proven, the share that really were affected. */
      precision: ratio(eligibility.correct, eligibility.engineProvenUnits),
      /** Of the units really affected, the share the system proved from records alone. */
      recall: ratio(eligibility.correct, eligibility.truthAffectedUnits),
      /** Of the units really affected, the share the system either proved or held for a person. */
      foundOrHeld: ratio(eligibility.correct + eligibility.heldAffected, eligibility.truthAffectedUnits),
    },
    people,
    payment: { ...payment, accuracyWhereVerified: ratio(payment.verifiedAndRight, payment.verifiedAndRight + payment.falseMatches) },
    amounts,
    money,
    duplicates: { paymentsRefundedTwiceInThisIncident: dupes?.n ?? 0, paymentsRefundedBeyondTheirAmount: overCapture?.n ?? 0 },
    completion: { byState: states, reconciliation: recon, callsToPayPal: calls?.attempts ?? 0, operationsCalled: calls?.operations ?? 0 },
    workload,
    timings: {
      note: "Clock times recorded by this system during this run. They show how long the software and its user took here, not how long a merchant's staff would take.",
      secondsFromIncidentToFirstMatch: seconds(times?.created_at, times?.first_match),
      secondsFromIncidentToFirstApproval: seconds(times?.created_at, times?.first_approval),
      secondsFromIncidentToLastBatchFinished: seconds(times?.created_at, times?.last_finish),
      decisionsByPeople: decisionSeconds.length,
      medianSecondsFromMatchToAPersonsDecision: median(decisionSeconds),
    },
    cases,
  };
}
