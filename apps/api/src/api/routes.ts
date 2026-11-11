// Every HTTP route. Each declares who may call it and what it accepts; the
// work itself lives in the modules.

import { z } from "zod";
import type { Container } from "../container.ts";
import { DAY } from "../platform/clock.ts";
import { ConflictError, NotFoundError, ValidationError } from "../platform/errors.ts";
import { enqueue } from "../platform/jobs/queue.ts";
import { BatchImport, OrderImport, upsertBatch, upsertOrder } from "../modules/commerce/ingest.ts";
import { seedDemoData } from "../modules/demo/seed.ts";
import { convertDetection, DETECTORS, runDetectors, setDetectionStatus } from "../modules/detection/service.ts";
import { cancelBatch, createBatch, decideBatch, pauseBatch, previewBatch, resumeBatch, startBatch, submitBatch } from "../modules/execution/batches.ts";
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
import { addRuleVersion, createIncident, decideCandidates, NewIncident, NewRuleVersion, runIncidentMatch } from "../modules/incidents/service.ts";
import { receivePayPalWebhook } from "../modules/paypal/webhooks.ts";
import * as reports from "../modules/reporting/queries.ts";
import { linkOrdersToPayments, lookupPaymentsByReference } from "../modules/transactions/sync.ts";
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
        aiConfigured: c.config.anthropicApiKey !== null,
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
    method: "POST", path: "/api/orgs/:orgId/paypal/lookup-payments", summary: "Fetch from PayPal, by ID, the payments that orders name and we do not hold yet", tag: "PayPal",
    auth: { permission: "data.import" }, params: OrgParams,
    handler: async ({ org }) => {
      const active = await c.connections.active(org.orgId);
      if (!active) throw new ConflictError("NO_PAYPAL_CONNECTION", "Connect a PayPal account first.");
      const provider = await c.connections.resolve(org.orgId, active.id);
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
      return runIncidentMatch(c.deps, { orgId: org.orgId, incidentId: params.incidentId, userId: user.id, payoutsAvailable: active?.capabilities.payouts === true });
    },
  });
  route({
    method: "GET", path: "/api/orgs/:orgId/incidents/:incidentId/candidates", summary: "Affected customers, with classification and amount", tag: "Incidents",
    auth: { permission: "org.read" }, params: Incident,
    query: Paging.extend({ classification: z.string().max(40).optional(), status: z.string().max(20).optional(), search: z.string().max(200).optional() }),
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
    body: z.object({ candidateIds: z.array(uuid).min(1).max(1000), decision: z.enum(["confirm", "decline"]) }),
    handler: async ({ body, params, org, user }) => decideCandidates(c.deps, { ...body, orgId: org.orgId, incidentId: params.incidentId, userId: user.id }),
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
    auth: { permission: "org.read" }, params: Incident,
    handler: async ({ params, org }) => previewBatch(c.db, org.orgId, params.incidentId),
  });
  route({
    method: "POST", path: "/api/orgs/:orgId/incidents/:incidentId/batches", summary: "Create a batch from the confirmed customers", tag: "Batches",
    auth: { permission: "batch.create" }, params: Incident, body: z.object({ name: z.string().trim().min(2).max(120) }),
    handler: async ({ body, params, org, user }) => createBatch(c.deps, { orgId: org.orgId, incidentId: params.incidentId, userId: user.id, name: body.name }),
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
