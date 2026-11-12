// Every HTTP route. Each declares who may call it and what it accepts; the
// work itself lives in the modules.

import { z } from "zod";
import type { Container } from "../container.ts";
import { DAY } from "../platform/clock.ts";
import { ConflictError, NotConfiguredError, NotFoundError, ValidationError } from "../platform/errors.ts";
import { emailConfirmLink, listNotices, notifyPaidCustomers } from "../modules/notify/notices.ts";
import { enqueue } from "../platform/jobs/queue.ts";
import { CSV_COLUMNS, ordersFromCsv } from "../modules/commerce/csv.ts";
import { BatchImport, OrderImport, upsertBatch, upsertOrder } from "../modules/commerce/ingest.ts";
import { seedDemoData, seedRecallScenario } from "../modules/demo/seed.ts";
import { convertDetection, DETECTORS, runDetectors, setDetectionStatus } from "../modules/detection/service.ts";
import { evaluateIncident } from "../modules/evaluation/service.ts";
import { AcceptExtraction, acceptExtraction, addDocument, decideAlias, explainCandidate, extractDocument, listEvidence, NewDocument, suggestAliases } from "../modules/evidence/service.ts";
import { cancelBatch, createBatch, decideBatch, pauseBatch, previewBatch, resumeBatch, reviseBatch, startBatch, submitBatch } from "../modules/execution/batches.ts";
import { currentManifest, manifestByVersion, manifestCsv } from "../modules/execution/manifests.ts";
import {
  createOrganisation,
  Credentials,
  listMembers,
  MemberChange,
  membershipsOf,
  NewOrganisation,
  OrgSettings,
  permissionsOf,
  registerUser,
  Registration,
  setMember,
  signIn,
  signOut,
  updateOrgSettings,
} from "../modules/identity/service.ts";
import { addRuleVersion, createIncident, decideCandidates, DecisionBasis, NewIncident, NewRuleVersion, reconcilePayment, runIncidentMatch } from "../modules/incidents/service.ts";
import { answerConfirm, confirmQuestion, createConfirmLink } from "../modules/incidents/confirm.ts";
import { receivePayPalWebhook } from "../modules/paypal/webhooks.ts";
import { comparePolicies, PolicyInput, recoveryMap } from "../modules/recovery/map.ts";
import * as reports from "../modules/reporting/queries.ts";
import { linkOrdersToPayments, lookupPaymentsByIds, lookupPaymentsByReference, refreshDisputeStates } from "../modules/transactions/sync.ts";
import { createRouter, OrgParams, Paging, parseCookies, SESSION_COOKIE, sessionCookie, uuid, type Router } from "./http.ts";

const Incident = OrgParams.extend({ incidentId: uuid });
const Batch = OrgParams.extend({ batchId: uuid });

export function buildApp(c: Container): Router {
  const router = createRouter({ config: c.config, identity: c.identity, now: () => c.clock.now() });
  const { route, app } = router;
  const secure = c.config.env === "production";

  // ---------- service ----------

  route({
    method: "GET", path: "/api/health", summary: "Liveness and database check", tag: "Service", auth: "public",
    handler: async () => {
      await c.db.query("select 1");
      return { ok: true, database: c.db.kind, time: c.clock.now().toISOString() };
    },
  });
  route({ method: "GET", path: "/api/openapi.json", summary: "This API, described in OpenAPI 3.1", tag: "Service", auth: "public", handler: async () => router.openapi() });

  // ---------- sign-in ----------

  route({
    method: "POST", path: "/api/auth/register", summary: "Create an account", tag: "Auth", auth: "public", body: Registration,
    rateLimit: { max: 10, windowMs: 60 * 60_000 },
    handler: async ({ body, reply, ip, req }) => {
      await registerUser(c.identity, body);
      const session = await signIn(c.identity, { email: body.email, password: body.password, ip, userAgent: req.headers["user-agent"] });
      reply.header("Set-Cookie", sessionCookie(session.token, session.expiresAt, secure));
      return { user: session.user };
    },
  });
  route({
    method: "POST", path: "/api/auth/login", summary: "Sign in", tag: "Auth", auth: "public", body: Credentials.extend({ password: z.string().min(1).max(200) }),
    rateLimit: { max: 10, windowMs: 10 * 60_000 },
    handler: async ({ body, reply, ip, req }) => {
      const session = await signIn(c.identity, { ...body, ip, userAgent: req.headers["user-agent"] });
      reply.header("Set-Cookie", sessionCookie(session.token, session.expiresAt, secure));
      return { user: session.user };
    },
  });
  route({
    method: "POST", path: "/api/auth/logout", summary: "Sign out", tag: "Auth", auth: "public",
    handler: async ({ req, reply }) => {
      await signOut(c.identity, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      reply.header("Set-Cookie", sessionCookie(null, null, secure));
      return { ok: true };
    },
  });
  route({
    method: "GET", path: "/api/me", summary: "The signed-in user, their organisations and what this server can do", tag: "Auth", auth: "user",
    handler: async ({ user }) => ({
      user,
      organisations: (await membershipsOf(c.identity, user.id)).map((m) => ({ ...m, permissions: permissionsOf(m.role) })),
      server: {
        simulatorAllowed: c.config.allowSimulator,
        livePayPalAllowed: c.config.allowLivePayPal,
        partnerOnboardingAvailable: c.config.paypalPartner !== null,
        aiConfigured: c.ai !== null,
        aiModel: c.ai?.model ?? null,
        emailTransport: c.config.email.transport,
        environment: c.config.env,
      },
    }),
  });

  // ---------- organisations ----------

  route({
    method: "POST", path: "/api/orgs", summary: "Create an organisation. The creator becomes its owner.", tag: "Organisation", auth: "user", body: NewOrganisation,
    handler: async ({ body, user }) => createOrganisation(c.identity, { ...body, userId: user.id }),
  });
  route({
    method: "GET", path: "/api/orgs/:orgId", summary: "Organisation, role and settings", tag: "Organisation", auth: { permission: "org.read" }, params: OrgParams,
    handler: async ({ org }) => ({ ...org, permissions: permissionsOf(org.role) }),
  });
  route({
    method: "PATCH", path: "/api/orgs/:orgId/settings", summary: "Change approval rules and other settings", tag: "Organisation",
    auth: { permission: "org.manage" }, params: OrgParams, body: OrgSettings.partial(),
    handler: async ({ body, org, user }) => updateOrgSettings(c.identity, { orgId: org.orgId, actorId: user.id, patch: body }),
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/members", summary: "Staff and their roles", tag: "Organisation", auth: { permission: "org.read" }, params: OrgParams,
    handler: async ({ org }) => listMembers(c.identity, org.orgId),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/members", summary: "Add a registered user, or change a role", tag: "Organisation",
    auth: { permission: "members.manage" }, params: OrgParams, body: MemberChange,
    handler: async ({ body, org, user }) => {
      await setMember(c.identity, { ...body, orgId: org.orgId, actorId: user.id, actorRole: org.role });
      return listMembers(c.identity, org.orgId);
    },
  });

  // ---------- PayPal connection ----------

  route({
    method: "GET", path: "/api/orgs/:orgId/paypal", summary: "PayPal connections and what each can do", tag: "PayPal", auth: { permission: "org.read" }, params: OrgParams,
    handler: async ({ org }) => ({ connections: await c.connections.list(org.orgId), active: await c.connections.active(org.orgId) }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/paypal/simulator", summary: "Use the built-in simulator instead of PayPal (no real calls)", tag: "PayPal",
    auth: { permission: "connections.manage" }, params: OrgParams,
    handler: async ({ org, user }) => c.connections.connectSimulator(org.orgId, user.id),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/paypal/credentials", summary: "Connect with the merchant's own PayPal REST app", tag: "PayPal",
    auth: { permission: "connections.manage" }, params: OrgParams,
    body: z.object({
      environment: z.enum(["sandbox", "live"]).default("sandbox"),
      clientId: z.string().min(1).max(200),
      clientSecret: z.string().min(1).max(200),
      webhookId: z.string().max(100).nullable().optional(),
    }),
    handler: async ({ body, org, user }) => c.connections.connectFirstParty(org.orgId, user.id, body),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/paypal/partner-onboarding", summary: "Start PayPal's own consent flow (needs partner approval)", tag: "PayPal",
    auth: { permission: "connections.manage" }, params: OrgParams, body: z.object({ environment: z.enum(["sandbox", "live"]).default("sandbox") }),
    handler: async ({ body, org }) => c.connections.startPartnerOnboarding(org.orgId, body.environment),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/paypal/:connectionId/verify", summary: "Ask PayPal whether the connection still works", tag: "PayPal",
    auth: { permission: "connections.manage" }, params: OrgParams.extend({ connectionId: uuid }),
    handler: async ({ params, org }) => c.connections.verify(org.orgId, params.connectionId),
  });
  route({
    method: "DELETE", path: "/api/orgs/:orgId/paypal/:connectionId", summary: "Disconnect and wipe the stored secret", tag: "PayPal",
    auth: { permission: "connections.manage" }, params: OrgParams.extend({ connectionId: uuid }),
    handler: async ({ params, org, user }) => {
      await c.connections.disconnect(org.orgId, params.connectionId, user.id);
      return { ok: true };
    },
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/paypal/sync", summary: "Copy PayPal transactions for a period (runs in the background)", tag: "PayPal",
    auth: { permission: "data.import" }, params: OrgParams,
    body: z.object({ days: z.number().int().min(1).max(1095).default(90) }),
    handler: async ({ body, org }) => {
      const active = await c.connections.active(org.orgId);
      if (!active) throw new ConflictError("NO_PAYPAL_CONNECTION", "Connect a PayPal account first.");
      if (active.capabilities.transactionSearch === false) {
        throw new ConflictError(
          "TRANSACTION_SEARCH_NOT_ENABLED",
          "PayPal has not given this app the Transaction Search permission. Switch it on for the app in the PayPal developer dashboard, then check the connection again. Until then, payments that orders name can still be fetched one by one.",
        );
      }
      const now = c.clock.now();
      const jobId = await enqueue(c.db, {
        type: "paypal.sync", orgId: org.orgId, dedupeKey: `paypal.sync:${org.orgId}`,
        payload: { connectionId: active.id, from: new Date(now.getTime() - body.days * DAY).toISOString(), to: now.toISOString() },
      }, now);
      return { queued: jobId !== null, alreadyRunning: jobId === null };
    },
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/paypal/lookup-payments", summary: "Fetch from PayPal, by ID, the payments that orders name (or the IDs given) and we do not hold yet", tag: "PayPal",
    auth: { permission: "data.import" }, params: OrgParams,
    body: z.object({ captureIds: z.array(z.string().min(5).max(40)).max(200).optional() }),
    handler: async ({ body, org }) => {
      const active = await c.connections.active(org.orgId);
      if (!active) throw new ConflictError("NO_PAYPAL_CONNECTION", "Connect a PayPal account first.");
      const provider = await c.connections.resolve(org.orgId, active.id);
      if (body.captureIds && body.captureIds.length > 0) {
        return lookupPaymentsByIds(c.deps, { orgId: org.orgId, connectionId: active.id, provider, captureIds: body.captureIds });
      }
      return lookupPaymentsByReference(c.deps, { orgId: org.orgId, connectionId: active.id, provider });
    },
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/sync-runs", summary: "Recent synchronisation runs", tag: "PayPal", auth: { permission: "org.read" }, params: OrgParams,
    handler: async ({ org }) =>
      c.db.query("select id, source, status, window_start, window_end, stats, error, started_at, finished_at from sync_runs where org_id = $1 order by started_at desc limit 30", [org.orgId]),
  });

  // ---------- stores and their data ----------

  route({
    method: "GET", path: "/api/orgs/:orgId/stores", summary: "Connected stores", tag: "Commerce", auth: { permission: "org.read" }, params: OrgParams,
    handler: async ({ org }) =>
      c.db.query(
        `select s.id, s.kind, s.name, s.base_url, s.status, s.last_synced_at, s.last_error,
                (select count(*)::int from orders o where o.org_id = s.org_id and o.connection_id = s.id) as orders
           from commerce_connections s where s.org_id = $1 order by s.created_at`,
        [org.orgId],
      ),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/stores", summary: "Add a store that sends orders through the import API", tag: "Commerce",
    auth: { permission: "connections.manage" }, params: OrgParams,
    body: z.object({ name: z.string().trim().min(2).max(120), kind: z.enum(["custom", "csv"]).default("custom") }),
    handler: async ({ body, org }) => {
      const rows = await c.db.query<{ id: string }>(
        "insert into commerce_connections (org_id, kind, name) values ($1, $2, $3) on conflict (org_id, name) do nothing returning id",
        [org.orgId, body.kind, body.name],
      );
      if (!rows[0]) throw new ConflictError("STORE_EXISTS", "A store with this name already exists.");
      return { id: rows[0].id };
    },
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/stores/:storeId/orders", summary: "Import or update up to 500 orders", tag: "Commerce",
    auth: { permission: "data.import" }, params: OrgParams.extend({ storeId: uuid }), body: z.object({ orders: z.array(OrderImport).min(1).max(500) }),
    handler: async ({ body, params, org }) => {
      const store = await c.db.query("select 1 from commerce_connections where org_id = $1 and id = $2", [org.orgId, params.storeId]);
      if (store.length === 0) throw new NotFoundError("Store");
      const out = { created: 0, updated: 0, warnings: [] as string[], links: { exact: 0, heuristic: 0 } };
      await c.db.tx(async (tx) => {
        for (const order of body.orders) {
          const result = await upsertOrder(tx, org.orgId, params.storeId, order);
          if (result.created) out.created++;
          else out.updated++;
          out.warnings.push(...result.warnings);
        }
        out.links = await linkOrdersToPayments(tx, org.orgId);
        await tx.query("update commerce_connections set last_synced_at = $3 where org_id = $1 and id = $2", [org.orgId, params.storeId, c.clock.now().toISOString()]);
      });
      return out;
    },
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/stores/:storeId/orders/csv", summary: "Import orders from CSV text (one row per order line). With dryRun, only checks the file.", tag: "Commerce",
    auth: { permission: "data.import" }, params: OrgParams.extend({ storeId: uuid }),
    body: z.object({ csv: z.string().min(1).max(4_000_000), dryRun: z.boolean().default(false) }),
    handler: async ({ body, params, org }) => {
      const store = await c.db.query("select 1 from commerce_connections where org_id = $1 and id = $2", [org.orgId, params.storeId]);
      if (store.length === 0) throw new NotFoundError("Store");
      const parsed = ordersFromCsv(body.csv);
      const out = { rows: parsed.rows, orders: parsed.orders.length, errors: parsed.errors, columns: CSV_COLUMNS, imported: false, created: 0, updated: 0, warnings: [] as string[], links: { exact: 0, heuristic: 0 } };
      // A file with unreadable rows is not half-imported: fix the file, then send it again.
      if (body.dryRun || parsed.errors.length > 0 || parsed.orders.length === 0) return out;
      await c.db.tx(async (tx) => {
        for (const order of parsed.orders) {
          const result = await upsertOrder(tx, org.orgId, params.storeId, order);
          if (result.created) out.created++;
          else out.updated++;
          out.warnings.push(...result.warnings);
        }
        out.links = await linkOrdersToPayments(tx, org.orgId);
        await tx.query("update commerce_connections set last_synced_at = $3 where org_id = $1 and id = $2", [org.orgId, params.storeId, c.clock.now().toISOString()]);
      });
      out.imported = true;
      return out;
    },
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/inventory-batches", summary: "Import stock batches with their shipping periods", tag: "Commerce",
    auth: { permission: "data.import" }, params: OrgParams, body: z.object({ batches: z.array(BatchImport).min(1).max(1000) }),
    handler: async ({ body, org }) => {
      await c.db.tx(async (tx) => {
        for (const b of body.batches) await upsertBatch(tx, org.orgId, b);
      });
      return { imported: body.batches.length };
    },
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/orders", summary: "Orders, searchable by number, email or product code", tag: "Commerce",
    auth: { permission: "org.read" }, params: OrgParams, query: Paging.extend({ search: z.string().max(200).optional() }),
    handler: async ({ query, org }) => reports.listOrders(c.db, org.orgId, query, reports.pageOf(query.page, query.size)),
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/payments", summary: "PayPal transactions as last copied", tag: "PayPal",
    auth: { permission: "org.read" }, params: OrgParams, query: Paging.extend({ search: z.string().max(200).optional(), kind: z.enum(["payment", "refund", "other"]).optional() }),
    handler: async ({ query, org }) => reports.listPayments(c.db, org.orgId, query, reports.pageOf(query.page, query.size)),
  });

  // ---------- incidents ----------

  route({
    method: "GET", path: "/api/orgs/:orgId/incidents", summary: "All incidents with progress counts", tag: "Incidents", auth: { permission: "org.read" }, params: OrgParams,
    handler: async ({ org }) => reports.listIncidents(c.db, org.orgId),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/incidents", summary: "Open an incident", tag: "Incidents", auth: { permission: "incident.write" }, params: OrgParams, body: NewIncident,
    handler: async ({ body, org, user }) => createIncident(c.deps, { ...body, orgId: org.orgId, userId: user.id }),
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/incidents/:incidentId", summary: "Incident, its rule versions and summary", tag: "Incidents", auth: { permission: "org.read" }, params: Incident,
    handler: async ({ params, org }) => {
      const detail = await reports.incidentDetail(c.db, org.orgId, params.incidentId);
      if (!detail) throw new NotFoundError("Incident");
      return detail;
    },
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/incidents/:incidentId/rules", summary: "Save a new version of the rules (who is affected, what they are owed)", tag: "Incidents",
    auth: { permission: "incident.write" }, params: Incident, body: NewRuleVersion,
    handler: async ({ body, params, org, user }) => addRuleVersion(c.deps, { ...body, orgId: org.orgId, incidentId: params.incidentId, userId: user.id }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/incidents/:incidentId/match", summary: "Find affected customers under the latest rules and calculate what each is owed", tag: "Incidents",
    auth: { permission: "incident.write" }, params: Incident,
    handler: async ({ params, org, user }) => {
      const active = await c.connections.active(org.orgId);
      const run = () => runIncidentMatch(c.deps, { orgId: org.orgId, incidentId: params.incidentId, userId: user.id, payoutsAvailable: active?.capabilities.payouts === true });
      const first = await run();
      if (!active) return { ...first, disputes: null };
      // A refund on a payment that is in a dispute could pay the customer twice, so PayPal is asked before anyone is called payable.
      const provider = await c.connections.resolve(org.orgId, active.id);
      const disputes = await refreshDisputeStates(c.deps, { orgId: org.orgId, incidentId: params.incidentId, provider });
      return { ...(disputes.changed > 0 ? await run() : first), disputes };
    },
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/incidents/:incidentId/candidates", summary: "Customer records with both answers (payment identity, eligibility), where each stands, and the amount", tag: "Incidents",
    auth: { permission: "org.read" }, params: Incident,
    query: Paging.extend({
      classification: z.string().max(40).optional(), status: z.string().max(20).optional(), search: z.string().max(200).optional(),
      disposition: z.string().max(40).optional(), decision: z.string().max(40).optional(), paymentIdentity: z.string().max(20).optional(),
      eligibility: z.string().max(20).optional(), includeCleared: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
    }),
    handler: async ({ params, query, org }) => reports.listCandidates(c.db, org.orgId, params.incidentId, query, reports.pageOf(query.page, query.size)),
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/candidates/:candidateId", summary: "One customer: evidence, calculation steps, order and payment", tag: "Incidents",
    auth: { permission: "org.read" }, params: OrgParams.extend({ candidateId: uuid }),
    handler: async ({ params, org }) => {
      const detail = await reports.candidateDetail(c.db, org.orgId, params.candidateId);
      if (!detail) throw new NotFoundError("Customer");
      return detail;
    },
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/incidents/:incidentId/candidates/decide", summary: "Confirm or decline customers that needed a decision", tag: "Incidents",
    auth: { permission: "candidate.decide" }, params: Incident,
    body: z.object({
      candidateIds: z.array(uuid).min(1).max(1000), decision: z.enum(["confirm", "decline"]),
      /** What the person relied on. Stored as evidence in their name and shown on the payment list. */
      basis: DecisionBasis.optional(), note: z.string().trim().max(1000).optional(),
    }),
    handler: async ({ body, params, org, user }) => decideCandidates(c.deps, { ...body, orgId: org.orgId, incidentId: params.incidentId, userId: user.id }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/candidates/:candidateId/reconcile-payment", summary: "A named person settles which PayPal payment paid for the order, then the match runs again", tag: "Incidents",
    auth: { permission: "candidate.decide" }, params: OrgParams.extend({ candidateId: uuid }),
    body: z.object({ paymentTransactionId: uuid, note: z.string().trim().min(3).max(500) }),
    handler: async ({ body, params, org, user }) => {
      const settled = await reconcilePayment(c.deps, { orgId: org.orgId, candidateId: params.candidateId, userId: user.id, ...body });
      const active = await c.connections.active(org.orgId);
      const match = await runIncidentMatch(c.deps, { orgId: org.orgId, incidentId: settled.incidentId, userId: user.id, payoutsAvailable: active?.capabilities.payouts === true });
      return { ...settled, match };
    },
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/candidates/:candidateId/explain", summary: "Gemini explains, from the stored evidence only, why this record is held (needs an API key)", tag: "Evidence",
    auth: { permission: "org.read" }, params: OrgParams.extend({ candidateId: uuid }),
    handler: async ({ params, org }) => explainCandidate({ ...c.deps, ai: c.ai }, { orgId: org.orgId, candidateId: params.candidateId }),
  });

  route({
    method: "POST", path: "/api/orgs/:orgId/candidates/:candidateId/confirm-link", summary: "Make a link to send to the customer, asking for the batch code on their unit", tag: "Incidents",
    auth: { permission: "candidate.decide" }, params: OrgParams.extend({ candidateId: uuid }),
    handler: async ({ params, org, user }) => {
      const { token } = await createConfirmLink(c.deps, { orgId: org.orgId, candidateId: params.candidateId, userId: user.id });
      return { url: `${c.config.publicUrl}/confirm/${token}` };
    },
  });
  const mailer = () => {
    if (!c.mailer) throw new NotConfiguredError("EMAIL_NOT_SET_UP", "Only EMAIL_TRANSPORT=file is built: emails are saved to files in the outbox, not sent.");
    return c.mailer;
  };
  route({
    method: "POST", path: "/api/orgs/:orgId/candidates/:candidateId/confirm-email", summary: "Make the customer link and email it to the customer (saved to the outbox file; not sent over the internet)", tag: "Incidents",
    auth: { permission: "candidate.decide" }, params: OrgParams.extend({ candidateId: uuid }),
    handler: async ({ params, org, user }) =>
      emailConfirmLink(c.deps, mailer(), { orgId: org.orgId, candidateId: params.candidateId, userId: user.id, publicUrl: c.config.publicUrl }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/incidents/:incidentId/notices/paid", summary: "Email every customer whose payment PayPal confirmed and who has not been told yet", tag: "Incidents",
    auth: { permission: "batch.execute" }, params: Incident,
    handler: async ({ params, org, user }) => notifyPaidCustomers(c.deps, mailer(), { orgId: org.orgId, incidentId: params.incidentId, userId: user.id }),
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/incidents/:incidentId/notices", summary: "Every email sent to customers for this incident, word for word", tag: "Incidents",
    auth: { permission: "org.read" }, params: Incident,
    handler: async ({ params, org }) => ({ transport: c.mailer?.transport ?? null, items: await listNotices(c.db, org.orgId, params.incidentId) }),
  });
  route({
    method: "GET", path: "/api/public/confirm/:token", summary: "What a customer is asked through a confirmation link", tag: "Public", auth: "public",
    params: z.object({ token: z.string().min(20).max(80) }), rateLimit: { max: 30, windowMs: 10 * 60_000 },
    handler: async ({ params }) => confirmQuestion(c.deps, params.token),
  });
  route({
    method: "POST", path: "/api/public/confirm/:token", summary: "A customer's answer. Stored as evidence; a member of staff still decides.", tag: "Public", auth: "public",
    params: z.object({ token: z.string().min(20).max(80) }), body: z.object({ batchCode: z.string().trim().min(1).max(60) }),
    rateLimit: { max: 10, windowMs: 10 * 60_000 },
    handler: async ({ body, params }) => answerConfirm(c.deps, { token: params.token, batchCode: body.batchCode }),
  });

  // ---------- the Recovery Map ----------

  route({
    method: "GET", path: "/api/orgs/:orgId/incidents/:incidentId/recovery-map", summary: "Everyone who bought the product: where each record stands, why, and what is owed", tag: "Recovery Map",
    auth: { permission: "org.read" }, params: Incident,
    handler: async ({ params, org }) => recoveryMap(c.db, org.orgId, params.incidentId),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/incidents/:incidentId/policies/compare", summary: "Price compensation policies against the records. A dry calculation: nothing is saved or paid.", tag: "Recovery Map",
    auth: { permission: "org.read" }, params: Incident, body: z.object({ policies: z.array(PolicyInput).max(6).optional() }),
    handler: async ({ body, params, org }) => {
      const active = await c.connections.active(org.orgId);
      return comparePolicies(c.deps, { orgId: org.orgId, incidentId: params.incidentId, policies: body.policies, payoutsAvailable: active?.capabilities.payouts === true });
    },
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/incidents/:incidentId/evaluation", summary: "Accuracy against known answers. Only available for sample data whose right answers are stored.", tag: "Recovery Map",
    auth: { permission: "org.read" }, params: Incident,
    handler: async ({ params, org }) => evaluateIncident(c.db, org.orgId, params.incidentId),
  });

  // ---------- incident evidence ----------

  route({
    method: "GET", path: "/api/orgs/:orgId/incidents/:incidentId/evidence", summary: "Documents attached to the incident and what was read from them", tag: "Evidence",
    auth: { permission: "org.read" }, params: Incident,
    handler: async ({ params, org }) => listEvidence({ ...c.deps, ai: c.ai }, org.orgId, params.incidentId),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/incidents/:incidentId/documents", summary: "Attach a document, such as a supplier's recall notice, as text", tag: "Evidence",
    auth: { permission: "incident.write" }, params: Incident, body: NewDocument,
    handler: async ({ body, params, org, user }) => addDocument({ ...c.deps, ai: c.ai }, { ...body, orgId: org.orgId, incidentId: params.incidentId, userId: user.id }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/incidents/:incidentId/documents/:documentId/extract", summary: "Read products, batches, dates and remedy out of a document. Every field quotes the document. Nothing is applied.", tag: "Evidence",
    auth: { permission: "incident.write" }, params: Incident.extend({ documentId: uuid }),
    body: z.object({ method: z.enum(["auto", "pattern_rules", "ai"]).default("auto") }),
    handler: async ({ body, params, org, user }) =>
      extractDocument({ ...c.deps, ai: c.ai }, { orgId: org.orgId, incidentId: params.incidentId, documentId: params.documentId, userId: user.id, method: body.method }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/incidents/:incidentId/extractions/:extractionId/accept", summary: "A person saves rules after checking what was read from a document", tag: "Evidence",
    auth: { permission: "incident.write" }, params: Incident.extend({ extractionId: uuid }), body: AcceptExtraction,
    handler: async ({ body, params, org, user }) =>
      acceptExtraction({ ...c.deps, ai: c.ai }, { ...body, orgId: org.orgId, incidentId: params.incidentId, extractionId: params.extractionId, userId: user.id }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/incidents/:incidentId/aliases/suggest", summary: "Find order lines whose product code looks like one in scope but is not matched. Suggestions change nothing.", tag: "Evidence",
    auth: { permission: "incident.write" }, params: Incident, body: z.object({ withAi: z.boolean().default(true) }),
    handler: async ({ body, params, org }) => suggestAliases({ ...c.deps, ai: c.ai }, { orgId: org.orgId, incidentId: params.incidentId, withAi: body.withAi }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/aliases/:aliasId/decision", summary: "A person confirms or rejects a product-code alias", tag: "Evidence",
    auth: { permission: "incident.write" }, params: OrgParams.extend({ aliasId: uuid }), body: z.object({ decision: z.enum(["confirm", "reject"]) }),
    handler: async ({ body, params, org, user }) => decideAlias({ ...c.deps, ai: c.ai }, { orgId: org.orgId, aliasId: params.aliasId, userId: user.id, decision: body.decision }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/incidents/:incidentId/status", summary: "Close or cancel an incident", tag: "Incidents",
    auth: { permission: "incident.write" }, params: Incident, body: z.object({ status: z.enum(["closed", "cancelled"]) }),
    handler: async ({ body, params, org }) => {
      const live = await c.db.query(
        `select 1 from payment_operations op join batches b on b.org_id = op.org_id and b.id = op.batch_id
          where op.org_id = $1 and b.incident_id = $2 and op.state in ('queued','submitting','unknown','pending_provider') limit 1`,
        [org.orgId, params.incidentId],
      );
      if (live.length > 0) throw new ConflictError("PAYMENTS_IN_FLIGHT", "Payments for this incident are still in progress.");
      const now = c.clock.now().toISOString();
      const rows = await c.db.query("update incidents set status = $3, closed_at = $4, updated_at = $4, claims_open = false where org_id = $1 and id = $2 returning id", [org.orgId, params.incidentId, body.status, now]);
      if (rows.length === 0) throw new NotFoundError("Incident");
      return { ok: true };
    },
  });

  // ---------- batches ----------

  route({
    method: "GET", path: "/api/orgs/:orgId/incidents/:incidentId/preview", summary: "Dry run: what a batch would pay, with no money moved and nothing saved", tag: "Batches",
    auth: { permission: "org.read" }, params: Incident, query: z.object({ kind: z.enum(["refund", "payout"]).default("refund") }),
    handler: async ({ params, query, org }) => previewBatch(c.db, org.orgId, params.incidentId, { kind: query.kind }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/incidents/:incidentId/batches", summary: "Create a batch from the confirmed customers", tag: "Batches",
    auth: { permission: "batch.create" }, params: Incident,
    body: z.object({ name: z.string().trim().min(2).max(120), kind: z.enum(["refund", "payout"]).default("refund") }),
    handler: async ({ body, params, org, user }) => createBatch(c.deps, { orgId: org.orgId, incidentId: params.incidentId, userId: user.id, name: body.name, kind: body.kind }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/batches/:batchId/revise", summary: "Build the next version of a draft batch's payment list from the records as they are now", tag: "Batches",
    auth: { permission: "batch.create" }, params: Batch,
    handler: async ({ params, org, user }) => reviseBatch(c.deps, { orgId: org.orgId, batchId: params.batchId, userId: user.id }),
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/batches/:batchId/manifest", summary: "The exact payment list an approval covers: recipients, amounts, PayPal references, rules and evidence", tag: "Batches",
    auth: { permission: "org.read" }, params: Batch,
    query: z.object({ version: z.coerce.number().int().min(1).optional(), format: z.enum(["json", "csv"]).default("json") }),
    handler: async ({ params, query, org, reply }) => {
      const manifest = query.version
        ? await manifestByVersion(c.db, org.orgId, params.batchId, query.version)
        : await currentManifest(c.db, org.orgId, params.batchId);
      if (!manifest) throw new NotFoundError(query.version ? "That version of the payment list" : "A payment list in force for this batch");
      if (query.format === "csv") {
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", `attachment; filename="payment-list-v${manifest.version}-${manifest.content_hash.slice(0, 12)}.csv"`);
        return manifestCsv(manifest.content, manifest.content_hash);
      }
      return {
        id: manifest.id, version: manifest.version, status: manifest.status, contentHash: manifest.content_hash, itemCount: manifest.item_count,
        createdAt: manifest.created_at, invalidatedAt: manifest.invalidated_at, invalidatedBecause: manifest.invalidated_reason, content: manifest.content,
      };
    },
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/ledger", summary: "The refund-intent ledger: every planned movement of money, why, under which approval, and what PayPal said", tag: "Batches",
    auth: { permission: "org.read" }, params: OrgParams,
    query: Paging.extend({ incidentId: uuid.optional(), captureId: z.string().max(40).optional(), state: z.string().max(30).optional() }),
    handler: async ({ query, org }) => reports.ledger(c.db, org.orgId, query, reports.pageOf(query.page, query.size)),
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/ledger/captures/:captureId", summary: "One PayPal payment across every incident: refunded, reserved and still available", tag: "Batches",
    auth: { permission: "org.read" }, params: OrgParams.extend({ captureId: z.string().min(5).max(40) }),
    handler: async ({ params, org }) => {
      const balance = await reports.captureBalance(c.db, org.orgId, params.captureId);
      if (!balance) throw new NotFoundError("PayPal payment");
      return balance;
    },
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/batches", summary: "Batches and their progress", tag: "Batches", auth: { permission: "org.read" }, params: OrgParams,
    handler: async ({ org }) => reports.listBatches(c.db, org.orgId),
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/batches/:batchId", summary: "One batch: approvals, totals and each payment", tag: "Batches",
    auth: { permission: "org.read" }, params: Batch, query: Paging,
    handler: async ({ params, query, org }) => {
      const detail = await reports.batchDetail(c.db, org.orgId, params.batchId, reports.pageOf(query.page, query.size ?? 100));
      if (!detail) throw new NotFoundError("Batch");
      return detail;
    },
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/batches/:batchId/submit", summary: "Send a batch for approval", tag: "Batches", auth: { permission: "batch.create" }, params: Batch,
    handler: async ({ params, org, user }) => {
      await submitBatch(c.deps, { orgId: org.orgId, batchId: params.batchId, userId: user.id });
      return { ok: true };
    },
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/batches/:batchId/decision", summary: "Approve or reject a batch", tag: "Batches",
    auth: { permission: "batch.approve" }, params: Batch, body: z.object({ decision: z.enum(["approve", "reject"]), comment: z.string().max(1000).optional() }),
    handler: async ({ body, params, org, user }) => decideBatch(c.deps, { ...body, orgId: org.orgId, batchId: params.batchId, userId: user.id, role: org.role }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/batches/:batchId/start", summary: "Start paying an approved batch", tag: "Batches", auth: { permission: "batch.execute" }, params: Batch,
    handler: async ({ params, org, user }) => startBatch(c.deps, { orgId: org.orgId, batchId: params.batchId, userId: user.id }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/batches/:batchId/pause", summary: "Pause: nothing more is sent until resumed", tag: "Batches", auth: { permission: "batch.execute" }, params: Batch,
    handler: async ({ params, org, user }) => ({
      paused: await c.db.tx((tx) => pauseBatch(tx, { orgId: org.orgId, batchId: params.batchId, reason: "Paused by a member of staff.", actor: { kind: "user", userId: user.id }, now: c.clock.now() })),
    }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/batches/:batchId/resume", summary: "Resume a paused batch", tag: "Batches", auth: { permission: "batch.execute" }, params: Batch,
    handler: async ({ params, org, user }) => resumeBatch(c.deps, { orgId: org.orgId, batchId: params.batchId, userId: user.id }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/batches/:batchId/cancel", summary: "Cancel what has not been sent. Payments already with PayPal are followed to their end.", tag: "Batches",
    auth: { permission: "batch.execute" }, params: Batch,
    handler: async ({ params, org, user }) => cancelBatch(c.deps, { orgId: org.orgId, batchId: params.batchId, userId: user.id }),
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/operations/:operationId/attempts", summary: "Every call made to PayPal for one payment", tag: "Batches",
    auth: { permission: "org.read" }, params: OrgParams.extend({ operationId: uuid }),
    handler: async ({ params, org }) => reports.operationAttempts(c.db, org.orgId, params.operationId),
  });

  // ---------- monitoring ----------

  route({
    method: "GET", path: "/api/orgs/:orgId/dashboard", summary: "Today's picture: volume, exposure, open problems, recent activity", tag: "Monitoring", auth: { permission: "org.read" }, params: OrgParams,
    handler: async ({ org }) => reports.dashboard(c.db, org.orgId, c.clock.now()),
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/detections", summary: "Findings from monitoring", tag: "Monitoring", auth: { permission: "org.read" }, params: OrgParams,
    query: z.object({ status: z.enum(["open", "acknowledged", "converted", "dismissed"]).optional() }),
    handler: async ({ query, org }) => ({ detectors: DETECTORS, findings: await reports.listDetections(c.db, org.orgId, query.status) }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/detections/run", summary: "Run all detectors now", tag: "Monitoring", auth: { permission: "detection.manage" }, params: OrgParams,
    handler: async ({ org }) => runDetectors(c.deps, org.orgId),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/detections/:detectionId/status", summary: "Acknowledge, dismiss or reopen a finding", tag: "Monitoring",
    auth: { permission: "detection.manage" }, params: OrgParams.extend({ detectionId: uuid }), body: z.object({ status: z.enum(["open", "acknowledged", "dismissed"]) }),
    handler: async ({ body, params, org, user }) => {
      await setDetectionStatus(c.deps, { orgId: org.orgId, detectionId: params.detectionId, userId: user.id, status: body.status });
      return { ok: true };
    },
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/detections/:detectionId/convert", summary: "Open an incident from a double-charge finding", tag: "Monitoring",
    auth: { permission: "incident.write" }, params: OrgParams.extend({ detectionId: uuid }),
    handler: async ({ params, org, user }) => convertDetection(c.deps, { orgId: org.orgId, detectionId: params.detectionId, userId: user.id }),
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/reconciliation", summary: "Differences found between our records and PayPal's", tag: "Monitoring", auth: { permission: "org.read" }, params: OrgParams,
    handler: async ({ org }) => reports.listReconciliation(c.db, org.orgId),
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/audit", summary: "The audit trail, with a check that it has not been altered", tag: "Monitoring",
    auth: { permission: "audit.read" }, params: OrgParams, query: Paging,
    handler: async ({ query, org }) => reports.auditPage(c.db, org.orgId, reports.pageOf(query.page, query.size)),
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/analytics", summary: "Results by incident, payment outcomes, timings and failure reasons", tag: "Monitoring", auth: { permission: "org.read" }, params: OrgParams,
    handler: async ({ org }) => reports.analytics(c.db, org.orgId),
  });

  // ---------- currencies ----------

  route({
    method: "GET", path: "/api/orgs/:orgId/fx/exposure", summary: "What is owed by currency, with an indicative value in the organisation's currency", tag: "FX", auth: { permission: "org.read" }, params: OrgParams,
    handler: async ({ org }) => c.fx.exposure(org.orgId, org.defaultCurrency, org.settings.fxAssumedSpreadBps),
  });
  route({
    method: "GET", path: "/api/fx/history", summary: "Daily reference rates (European Central Bank). Indicative, not PayPal's rate.", tag: "FX", auth: "user",
    query: z.object({ base: z.string().regex(/^[A-Z]{3}$/), quote: z.string().regex(/^[A-Z]{3}$/), days: z.coerce.number().int().min(7).max(366).default(90) }),
    handler: async ({ query }) => {
      if (query.base === query.quote) throw new ValidationError("Choose two different currencies.");
      let refreshError: string | null = null;
      try {
        await c.fx.refreshHistory(query.base, query.quote, query.days);
      } catch (err) {
        refreshError = err instanceof Error ? err.message : "The rate source could not be reached.";
      }
      return {
        base: query.base, quote: query.quote, source: "European Central Bank reference rates, via the Frankfurter API",
        disclaimer: "Indicative daily rates. Not the rate PayPal applies to a payment.", refreshError,
        points: await c.fx.history(query.base, query.quote, query.days),
      };
    },
  });

  // ---------- sample data ----------

  route({
    method: "POST", path: "/api/orgs/:orgId/demo/seed", summary: "Load sample data (simulator connections only)", tag: "Demo", auth: { permission: "org.manage" }, params: OrgParams,
    handler: async ({ org, user }) => seedDemoData({ db: c.db, clock: c.clock, connections: c.connections }, { orgId: org.orgId, userId: user.id }),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/demo/recall-scenario", summary: "Load the HM-300 batch-recall case: untidy synthetic records with known answers (simulator connections only)", tag: "Demo",
    auth: { permission: "org.manage" }, params: OrgParams,
    handler: async ({ org, user }) => seedRecallScenario({ db: c.db, clock: c.clock, connections: c.connections }, { orgId: org.orgId, userId: user.id }),
  });

  route({
    method: "POST", path: "/api/orgs/:orgId/demo/faults", summary: "Simulator only: make the next PayPal reply get lost, or refund a payment as if in the PayPal dashboard", tag: "Demo",
    auth: { permission: "org.manage" }, params: OrgParams,
    body: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("lose_next_reply") }),
      z.object({ kind: z.literal("refund_elsewhere"), captureId: z.string().min(5).max(40) }),
    ]),
    handler: async ({ body, org }) => {
      const active = await c.connections.active(org.orgId);
      if (!active || active.environment !== "simulator") {
        throw new ConflictError("NOT_SIMULATOR", "Faults can only be staged on the simulator. On PayPal's sandbox, use `npm run sandbox:recall`, which stages them around real calls.");
      }
      const sim = await c.connections.simulatorFor(org.orgId);
      if (body.kind === "lose_next_reply") {
        // PayPal will act on the next refund, and its reply will not arrive.
        sim.failNext({ on: "refund", when: "after", kind: "timeout" });
        return { staged: "The reply to the next refund request will be lost after the simulator has made the refund." };
      }
      // As if a member of staff refunded it in the PayPal dashboard. Our records do not learn of it until the next sync.
      const refund = await sim.refundCapture(body.captureId, { requestId: `dashboard-${body.captureId}` });
      return { staged: `Payment ${body.captureId} was refunded in full at the simulator, outside Make Good (${refund.id}).` };
    },
  });

  // ---------- PayPal webhooks ----------
  // In its own scope, so the body can be kept exactly as PayPal sent it for the signature check.

  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      (req as unknown as { rawBody: string }).rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(new ValidationError("The webhook body is not JSON."), undefined);
      }
    });
    scope.post("/api/webhooks/paypal/:connectionId", async (req, reply) => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      const result = await receivePayPalWebhook(
        { db: c.db, clock: c.clock, connections: c.connections },
        { connectionId: (req.params as { connectionId: string }).connectionId, headers, rawBody: (req as unknown as { rawBody: string }).rawBody ?? "", event: req.body },
      );
      // Always 200 for a stored event, verified or not: PayPal should not keep retrying, and we tell callers nothing.
      return reply.code(200).send({ received: true, duplicate: !result.stored });
    });
  });

  return router;
}
