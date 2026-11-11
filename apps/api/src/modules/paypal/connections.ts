// A merchant's connection to PayPal: creating it, checking it, and turning it
// into a provider the rest of the system can call.
//
// Three ways to connect, in order of how a real product would use them:
//
//   partner      PayPal seller onboarding. The merchant clicks through
//                PayPal's own consent screen; we then act for them with OUR
//                credentials plus a header naming their account. This is the
//                right model for a hosted product. It needs PayPal to approve
//                us as a partner, so here it is implemented but cannot be
//                switched on without that approval.
//   first_party  The merchant's own REST app credentials, encrypted at rest.
//                Fine for development, for a single merchant running their own
//                copy, and for the sandbox. Not the default for a hosted product.
//   simulator    No PayPal. A built-in model, labelled as such everywhere.

import { audit } from "../../platform/audit.ts";
import type { Clock } from "../../platform/clock.ts";
import type { Config } from "../../platform/config.ts";
import { maskTail, type SecretBox } from "../../platform/crypto.ts";
import type { Db } from "../../platform/db/db.ts";
import { json } from "../../platform/db/db.ts";
import { ConflictError, ForbiddenError, NotConfiguredError, NotFoundError, ValidationError } from "../../platform/errors.ts";
import { ProviderError, type PayPalProvider } from "./provider.ts";
import { PayPalRestClient } from "./rest-client.ts";
import { SimulatedPayPal } from "./simulator.ts";

export type Capabilities = {
  refunds: boolean;
  transactionSearch: boolean;
  payouts: boolean;
  disputes: boolean;
  webhooks: boolean;
  scopes: string[];
};

/** OAuth scopes as named in PayPal's API specifications. */
const SCOPE = {
  refunds: "https://uri.paypal.com/services/payments/refund",
  transactionSearch: "https://uri.paypal.com/services/reporting/search/read",
  payouts: "https://uri.paypal.com/payments/payouts",
  disputes: "https://uri.paypal.com/services/disputes/read-seller",
  webhooks: "https://uri.paypal.com/services/applications/webhooks",
};

export function capabilitiesFrom(scopes: string[]): Capabilities {
  const has = (s: string) => scopes.includes(s);
  return {
    refunds: has(SCOPE.refunds),
    transactionSearch: has(SCOPE.transactionSearch),
    payouts: has(SCOPE.payouts),
    disputes: has(SCOPE.disputes),
    webhooks: has(SCOPE.webhooks),
    scopes,
  };
}

type ConnectionRow = {
  id: string; org_id: string; environment: "sandbox" | "live" | "simulator"; mode: "first_party" | "partner" | "simulator";
  client_id: string | null; secret_ciphertext: string | null; merchant_id: string | null; webhook_id: string | null;
  status: "pending" | "connected" | "invalid" | "revoked"; capabilities: Partial<Capabilities>; last_verified_at: Date | null;
  last_error: string | null; created_at: Date; updated_at: Date;
};

export type ConnectionView = {
  id: string; environment: ConnectionRow["environment"]; mode: ConnectionRow["mode"]; status: ConnectionRow["status"];
  clientIdMasked: string | null; merchantId: string | null; webhookConfigured: boolean; capabilities: Partial<Capabilities>;
  lastVerifiedAt: Date | null; lastError: string | null;
};

const view = (r: ConnectionRow): ConnectionView => ({
  id: r.id, environment: r.environment, mode: r.mode, status: r.status,
  clientIdMasked: r.client_id ? maskTail(r.client_id, 6) : null, merchantId: r.merchant_id,
  webhookConfigured: Boolean(r.webhook_id), capabilities: r.capabilities ?? {}, lastVerifiedAt: r.last_verified_at, lastError: r.last_error,
});

export type ConnectionDeps = {
  db: Db;
  clock: Clock;
  secrets: SecretBox;
  config: Pick<Config, "allowSimulator" | "allowLivePayPal" | "paypalPartner" | "publicUrl">;
  fetchImpl?: typeof fetch;
};

export class PayPalConnections {
  readonly #deps: ConnectionDeps;
  readonly #providers = new Map<string, { stamp: string; provider: PayPalProvider }>();
  readonly #simulators = new Map<string, SimulatedPayPal>();

  constructor(deps: ConnectionDeps) {
    this.#deps = deps;
  }

  async #row(orgId: string, connectionId: string): Promise<ConnectionRow> {
    const rows = await this.#deps.db.query<ConnectionRow>("select * from paypal_connections where org_id = $1 and id = $2", [orgId, connectionId]);
    if (!rows[0]) throw new NotFoundError("PayPal connection");
    return rows[0];
  }

  async list(orgId: string): Promise<ConnectionView[]> {
    const rows = await this.#deps.db.query<ConnectionRow>("select * from paypal_connections where org_id = $1 order by created_at", [orgId]);
    return rows.map(view);
  }

  /** The connection payments and syncs use: the connected one, live before sandbox before simulator. */
  async active(orgId: string): Promise<ConnectionView | null> {
    const rows = await this.#deps.db.query<ConnectionRow>(
      `select * from paypal_connections where org_id = $1 and status = 'connected'
        order by case environment when 'live' then 0 when 'sandbox' then 1 else 2 end, created_at limit 1`,
      [orgId],
    );
    return rows[0] ? view(rows[0]) : null;
  }

  /** Builds (or reuses) the provider for a connection. This is what the executor calls. */
  readonly resolve = async (orgId: string, connectionId: string): Promise<PayPalProvider> => {
    const row = await this.#row(orgId, connectionId);
    if (row.status !== "connected") {
      throw new NotConfiguredError("PAYPAL_NOT_CONNECTED", `The PayPal connection is ${row.status}. Reconnect PayPal to continue.`);
    }
    const stamp = `${row.id}:${new Date(row.updated_at).getTime()}`;
    const cached = this.#providers.get(row.id);
    if (cached?.stamp === stamp) return cached.provider;
    const provider = await this.#build(row);
    this.#providers.set(row.id, { stamp, provider });
    return provider;
  };

  async #build(row: ConnectionRow): Promise<PayPalProvider> {
    const { config, secrets, fetchImpl } = this.#deps;
    if (row.mode === "simulator") return this.simulatorFor(row.org_id);
    if (row.environment === "live" && !config.allowLivePayPal) {
      throw new ForbiddenError("Live PayPal access is switched off on this server.");
    }
    if (row.mode === "partner") {
      if (!config.paypalPartner) {
        throw new NotConfiguredError("PARTNER_NOT_CONFIGURED", "PayPal partner credentials are not configured on this server.");
      }
      return new PayPalRestClient({
        environment: row.environment as "sandbox" | "live", clientId: config.paypalPartner.clientId,
        clientSecret: config.paypalPartner.clientSecret, actingForMerchantId: row.merchant_id ?? undefined,
        allowLive: config.allowLivePayPal, fetchImpl,
      });
    }
    return new PayPalRestClient({
      environment: row.environment as "sandbox" | "live", clientId: row.client_id!,
      clientSecret: secrets.decrypt(row.secret_ciphertext!), allowLive: config.allowLivePayPal, fetchImpl,
    });
  }

  /**
   * The simulator for an organisation. It lives in memory, so after a restart
   * it is rebuilt from the payments and refunds already recorded.
   */
  async simulatorFor(orgId: string): Promise<SimulatedPayPal> {
    const existing = this.#simulators.get(orgId);
    if (existing) return existing;
    const { db, clock } = this.#deps;
    const sim = new SimulatedPayPal({ now: () => clock.now() });
    const payments = await db.query<{
      transaction_id: string; currency: string; gross_minor: number; refunded_minor: number; occurred_at: Date; invoice_id: string | null;
      custom_id: string | null; payer_email: string | null; payer_name: string | null; payer_id: string | null; payer_country: string | null;
      items: Array<{ code?: string; name?: string; quantity?: number; unitMinor?: number }>; dispute_state: string | null;
    }>(
      `select transaction_id, trim(currency) as currency, gross_minor, refunded_minor, occurred_at, invoice_id, custom_id,
              payer_email, payer_name, payer_id, payer_country, items, dispute_state
         from payment_transactions where org_id = $1 and environment = 'simulator' and kind = 'payment'`,
      [orgId],
    );
    for (const p of payments) {
      sim.addCapture({
        id: p.transaction_id, currency: p.currency, amountMinor: p.gross_minor, refundedMinor: p.refunded_minor,
        createdAt: new Date(p.occurred_at), invoiceId: p.invoice_id ?? undefined, customId: p.custom_id ?? undefined,
        payerEmail: p.payer_email ?? undefined, payerName: p.payer_name ?? undefined, payerId: p.payer_id ?? undefined,
        payerCountry: p.payer_country ?? undefined, disputed: p.dispute_state === "open",
        items: (Array.isArray(p.items) ? p.items : []).map((i) => ({ code: i.code, name: i.name, quantity: i.quantity ?? 1, unitMinor: i.unitMinor ?? 0 })),
      });
    }
    const refunds = await db.query<{ transaction_id: string; reference_transaction_id: string; currency: string; gross_minor: number; occurred_at: Date; custom_id: string | null }>(
      `select transaction_id, reference_transaction_id, trim(currency) as currency, gross_minor, occurred_at, custom_id
         from payment_transactions where org_id = $1 and environment = 'simulator' and kind = 'refund' and reference_transaction_id is not null`,
      [orgId],
    );
    for (const r of refunds) {
      sim.restoreRefund({ id: r.transaction_id, captureId: r.reference_transaction_id, currency: r.currency, amountMinor: r.gross_minor, createdAt: new Date(r.occurred_at), requestId: r.custom_id ?? undefined });
    }
    this.#simulators.set(orgId, sim);
    return sim;
  }

  async #upsert(orgId: string, userId: string, values: {
    environment: ConnectionRow["environment"]; mode: ConnectionRow["mode"]; clientId: string | null; secretCiphertext: string | null;
    merchantId: string | null; webhookId: string | null; status: ConnectionRow["status"]; capabilities: Partial<Capabilities>; lastError: string | null;
  }): Promise<ConnectionView> {
    const { db, clock } = this.#deps;
    const now = clock.now();
    return db.tx(async (tx) => {
      const rows = await tx.query<ConnectionRow>(
        `insert into paypal_connections
           (org_id, environment, mode, client_id, secret_ciphertext, merchant_id, webhook_id, status, capabilities,
            last_verified_at, last_error, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$12)
         on conflict (org_id, environment) do update set
           mode = excluded.mode, client_id = excluded.client_id, secret_ciphertext = excluded.secret_ciphertext,
           merchant_id = excluded.merchant_id, webhook_id = excluded.webhook_id, status = excluded.status,
           capabilities = excluded.capabilities, last_verified_at = excluded.last_verified_at,
           last_error = excluded.last_error, updated_at = excluded.updated_at
         returning *`,
        [orgId, values.environment, values.mode, values.clientId, values.secretCiphertext, values.merchantId, values.webhookId,
         values.status, json(values.capabilities), values.status === "connected" ? now.toISOString() : null, values.lastError, now.toISOString()],
      );
      await audit(tx, {
        orgId, actor: { kind: "user", userId }, action: "paypal.connection_saved", entityType: "paypal_connection", entityId: rows[0]!.id,
        // Never the secret, and only the tail of the client ID.
        data: { environment: values.environment, mode: values.mode, status: values.status, clientId: maskTail(values.clientId, 6) }, at: now,
      });
      return view(rows[0]!);
    });
  }

  async connectSimulator(orgId: string, userId: string): Promise<ConnectionView> {
    if (!this.#deps.config.allowSimulator) throw new ForbiddenError("The simulator is switched off on this server.");
    return this.#upsert(orgId, userId, {
      environment: "simulator", mode: "simulator", clientId: null, secretCiphertext: null, merchantId: null, webhookId: null,
      status: "connected", capabilities: { refunds: true, transactionSearch: true, payouts: true, disputes: true, webhooks: false, scopes: ["simulator"] }, lastError: null,
    });
  }

  /**
   * Connects with the merchant's own REST app credentials. The credentials are
   * tried against PayPal first; they are stored (encrypted) either way, with
   * the status PayPal gave, so the merchant can see what went wrong.
   */
  async connectFirstParty(orgId: string, userId: string, input: { environment: "sandbox" | "live"; clientId: string; clientSecret: string; webhookId?: string | null }): Promise<ConnectionView> {
    const { config, secrets, fetchImpl } = this.#deps;
    if (input.environment === "live" && !config.allowLivePayPal) {
      throw new ForbiddenError("Live PayPal access is switched off on this server. Use the sandbox.");
    }
    const clientId = input.clientId.trim();
    const clientSecret = input.clientSecret.trim();
    if (clientId.length < 20 || clientSecret.length < 20) throw new ValidationError("That does not look like a PayPal client ID and secret.");
    let status: ConnectionRow["status"] = "connected";
    let capabilities: Partial<Capabilities> = {};
    let lastError: string | null = null;
    try {
      const client = new PayPalRestClient({ environment: input.environment, clientId, clientSecret, allowLive: config.allowLivePayPal, fetchImpl });
      capabilities = capabilitiesFrom((await client.verifyCredentials()).scopes);
    } catch (err) {
      status = "invalid";
      lastError = err instanceof ProviderError ? `${err.kind}: ${err.message}` : "Could not reach PayPal to check the credentials.";
    }
    return this.#upsert(orgId, userId, {
      environment: input.environment, mode: "first_party", clientId, secretCiphertext: secrets.encrypt(clientSecret),
      merchantId: null, webhookId: input.webhookId?.trim() || null, status, capabilities, lastError,
    });
  }

  /** Asks PayPal again whether the connection works, and records the answer. */
  async verify(orgId: string, connectionId: string): Promise<ConnectionView> {
    const row = await this.#row(orgId, connectionId);
    if (row.mode === "simulator") return view(row);
    if (row.status === "revoked") throw new ConflictError("CONNECTION_REVOKED", "This connection was disconnected. Connect PayPal again.");
    const now = this.#deps.clock.now();
    let status: ConnectionRow["status"] = "connected";
    let lastError: string | null = null;
    let capabilities = row.capabilities;
    try {
      const provider = await this.#build(row);
      capabilities = capabilitiesFrom((await provider.verifyCredentials()).scopes);
    } catch (err) {
      status = "invalid";
      lastError = err instanceof Error ? err.message : "Could not check the connection.";
    }
    const rows = await this.#deps.db.query<ConnectionRow>(
      `update paypal_connections set status = $3, capabilities = $4::jsonb, last_error = $5,
              last_verified_at = case when $3 = 'connected' then $6 else last_verified_at end, updated_at = $6
        where org_id = $1 and id = $2 returning *`,
      [orgId, connectionId, status, json(capabilities), lastError, now.toISOString()],
    );
    this.#providers.delete(connectionId);
    return view(rows[0]!);
  }

  /** Disconnects: the stored secret is wiped, and nothing can be sent through this connection again. */
  async disconnect(orgId: string, connectionId: string, userId: string): Promise<void> {
    const { db, clock } = this.#deps;
    const now = clock.now();
    await db.tx(async (tx) => {
      const live = await tx.query(
        `select 1 from payment_operations where org_id = $1 and paypal_connection_id = $2
            and state in ('queued','submitting','unknown','pending_provider') limit 1`,
        [orgId, connectionId],
      );
      if (live.length > 0) {
        throw new ConflictError("PAYMENTS_IN_FLIGHT", "Payments are still in progress on this connection. Let them finish, or cancel the batch, first.");
      }
      const rows = await tx.query(
        "update paypal_connections set status = 'revoked', secret_ciphertext = null, client_id = null, webhook_id = null, updated_at = $3 where org_id = $1 and id = $2 returning id",
        [orgId, connectionId, now.toISOString()],
      );
      if (rows.length === 0) throw new NotFoundError("PayPal connection");
      await audit(tx, { orgId, actor: { kind: "user", userId }, action: "paypal.disconnected", entityType: "paypal_connection", entityId: connectionId, at: now });
    });
    this.#providers.delete(connectionId);
  }

  /**
   * Starts PayPal's own seller onboarding (partner mode). Works only on a
   * server that holds approved partner credentials.
   */
  async startPartnerOnboarding(orgId: string, environment: "sandbox" | "live"): Promise<{ actionUrl: string }> {
    const { config, fetchImpl } = this.#deps;
    if (!config.paypalPartner) {
      throw new NotConfiguredError(
        "PARTNER_NOT_CONFIGURED",
        "Connecting through PayPal's consent screen needs PayPal to approve Make Good as a partner. That approval is not in place on this server.",
      );
    }
    const client = new PayPalRestClient({ environment, ...config.paypalPartner, allowLive: config.allowLivePayPal, fetchImpl });
    const referral = await client.createPartnerReferral({ trackingId: orgId, returnUrl: `${config.publicUrl}/settings/paypal/return` });
    if (!referral.actionUrl) throw new NotConfiguredError("PARTNER_REFERRAL_FAILED", "PayPal did not return an onboarding link.");
    return { actionUrl: referral.actionUrl };
  }
}
