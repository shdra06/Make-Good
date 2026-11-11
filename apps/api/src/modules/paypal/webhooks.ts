// PayPal webhooks.
//
// A webhook is a hint that something changed, never the source of truth.
// Events can arrive late, twice, or out of order, and anyone on the internet
// can post to this address. So:
//
//   * every event is stored once, keyed by PayPal's event ID (duplicates are ignored);
//   * the signature is checked with PayPal's verify-webhook-signature API,
//     passing the body exactly as received;
//   * an event that fails the check is kept for inspection and never acted on;
//   * a verified event only updates our copy of PayPal's ledger and wakes the
//     reconciliation of the operation it concerns. The operation's final state
//     still comes from asking PayPal.

import type { Clock } from "../../platform/clock.ts";
import type { Db } from "../../platform/db/db.ts";
import { json } from "../../platform/db/db.ts";
import { NotFoundError } from "../../platform/errors.ts";
import { enqueue } from "../../platform/jobs/queue.ts";
import { toMinor } from "../../platform/money.ts";
import { recomputeRefundedTotals } from "../transactions/sync.ts";
import type { PayPalConnections } from "./connections.ts";

export type WebhookDeps = { db: Db; clock: Clock; connections: PayPalConnections };

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export async function receivePayPalWebhook(
  deps: WebhookDeps,
  input: { connectionId: string; headers: Record<string, string | undefined>; rawBody: string; event: unknown },
): Promise<{ stored: boolean; verified: boolean }> {
  const { db, clock } = deps;
  if (!/^[0-9a-f-]{36}$/i.test(input.connectionId)) throw new NotFoundError("Webhook");
  const [conn] = await db.query<{ org_id: string; webhook_id: string | null; environment: string; status: string }>(
    "select org_id, webhook_id, environment, status from paypal_connections where id = $1",
    [input.connectionId],
  );
  if (!conn) throw new NotFoundError("Webhook");
  const event = rec(input.event);
  const eventId = str(event.id);
  const eventType = str(event.event_type);
  if (!eventId || !eventType) throw new NotFoundError("Webhook event");

  let verified = false;
  let detail: string;
  if (!conn.webhook_id) {
    detail = "No webhook ID is configured for this connection, so the signature cannot be checked.";
  } else if (conn.status !== "connected") {
    detail = `The connection is ${conn.status}.`;
  } else {
    try {
      const provider = await deps.connections.resolve(conn.org_id, input.connectionId);
      verified = await provider.verifyWebhookSignature({ webhookId: conn.webhook_id, headers: input.headers, event: input.event, rawBody: input.rawBody });
      detail = verified ? "PayPal confirmed the signature." : "PayPal reported that the signature does not match.";
    } catch (err) {
      detail = `The signature could not be checked: ${err instanceof Error ? err.message : "unknown error"}`;
    }
  }

  const now = clock.now();
  const resource = rec(event.resource);
  return db.tx(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `insert into provider_events (org_id, provider, environment, event_id, event_type, resource_type, resource_id, verified, verification_detail, payload, received_at)
       values ($1, 'paypal', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       on conflict (provider, event_id) do nothing returning id`,
      [conn.org_id, conn.environment, eventId, eventType, str(event.resource_type), str(resource.id), verified, detail, json(event), now.toISOString()],
    );
    if (rows[0] && verified) {
      await enqueue(tx, { type: "provider_event.process", orgId: conn.org_id, payload: { providerEventId: rows[0].id } }, now);
    }
    return { stored: Boolean(rows[0]), verified };
  });
}

/** Applies one stored, verified event. Safe to run twice. */
export async function processProviderEvent(deps: Pick<WebhookDeps, "db" | "clock">, providerEventId: string): Promise<string> {
  const { db, clock } = deps;
  const now = clock.now();
  const [event] = await db.query<{ id: string; org_id: string; environment: string; event_type: string; verified: boolean; payload: Json; processed_at: Date | null }>(
    "select id, org_id, environment, event_type, verified, payload, processed_at from provider_events where id = $1",
    [providerEventId],
  );
  if (!event) return "missing";
  if (event.processed_at) return "already processed";
  const done = async (result: string) => {
    await db.query("update provider_events set processed_at = $2, processing_result = $3 where id = $1", [event.id, now.toISOString(), result]);
    return result;
  };
  if (!event.verified) return done("ignored: signature not verified");

  const resource = rec(event.payload.resource);
  const type = event.event_type;

  if (type === "PAYMENT.CAPTURE.REFUNDED" || type === "PAYMENT.CAPTURE.REVERSED") {
    const refundId = str(resource.id);
    const amount = rec(resource.amount);
    const currency = str(amount.currency_code);
    const links = Array.isArray(resource.links) ? (resource.links as unknown[]).map(rec) : [];
    const captureId = /\/captures\/([A-Za-z0-9]+)/.exec(str(links.find((l) => l.rel === "up")?.href) ?? "")?.[1] ?? null;
    if (!refundId || !currency || !captureId) return done("ignored: the event does not name a refund, an amount and a capture");
    let minor: number;
    try {
      minor = Math.abs(toMinor(str(amount.value) ?? "0", currency));
    } catch {
      return done("ignored: the amount could not be read exactly");
    }
    const customId = str(resource.custom_id);
    await db.tx(async (tx) => {
      await tx.query(
        `insert into payment_transactions
           (org_id, environment, transaction_id, kind, event_code, provider_status, occurred_at, currency, gross_minor,
            custom_id, reference_transaction_id, source, raw, last_synced_at)
         values ($1, $2, $3, 'refund', 'T1107', 'S', $4, $5, $6, $7, $8, 'webhook', $9::jsonb, $10)
         on conflict (org_id, provider, environment, transaction_id) do update set
           custom_id = coalesce(payment_transactions.custom_id, excluded.custom_id), last_synced_at = excluded.last_synced_at`,
        [event.org_id, event.environment, refundId, str(resource.create_time) ?? now.toISOString(), currency, minor, customId, captureId, json(resource), now.toISOString()],
      );
      await recomputeRefundedTotals(tx, event.org_id);
      if (customId) {
        // If this refund is one of ours and we were unsure of its outcome, look it up now.
        const ops = await tx.query<{ id: string }>(
          "select id from payment_operations where org_id = $1 and idempotency_key = $2 and state in ('unknown', 'pending_provider', 'submitting')",
          [event.org_id, customId],
        );
        for (const op of ops) {
          await enqueue(tx, { type: "operation.reconcile", orgId: event.org_id, payload: { operationId: op.id }, dedupeKey: `operation.reconcile:${op.id}`, maxAttempts: 50 }, now);
        }
      }
    });
    return done(`recorded refund ${refundId} against ${captureId}`);
  }

  if (type.startsWith("CUSTOMER.DISPUTE.")) {
    const disputed = Array.isArray(resource.disputed_transactions) ? (resource.disputed_transactions as unknown[]).map(rec) : [];
    const ids = disputed.map((d) => str(d.seller_transaction_id)).filter((v): v is string => v !== null);
    const state = type === "CUSTOMER.DISPUTE.RESOLVED" ? "resolved" : "open";
    for (const id of ids) {
      await db.query(
        "update payment_transactions set dispute_state = $3 where org_id = $1 and transaction_id = $2 and kind = 'payment'",
        [event.org_id, id, state],
      );
    }
    return done(`marked ${ids.length} payment(s) as dispute ${state}`);
  }

  if (type.startsWith("PAYMENT.PAYOUTS-ITEM.") || type.startsWith("PAYMENT.PAYOUTSBATCH.")) {
    const senderItemId = str(rec(resource.payout_item).sender_item_id);
    const senderBatchId = str(rec(rec(resource.batch_header).sender_batch_header).sender_batch_id);
    const ops = await db.query<{ id: string }>(
      `select id from payment_operations
        where org_id = $1 and kind = 'payout' and (id::text = $2 or idempotency_key = $3)
          and state in ('unknown', 'pending_provider', 'submitting')`,
      [event.org_id, senderItemId ?? "", senderBatchId ?? ""],
    );
    for (const op of ops) {
      await enqueue(db, { type: "operation.reconcile", orgId: event.org_id, payload: { operationId: op.id }, dedupeKey: `operation.reconcile:${op.id}`, maxAttempts: 50 }, now);
    }
    return done(`woke ${ops.length} payout operation(s)`);
  }

  return done("stored: no action for this event type");
}
