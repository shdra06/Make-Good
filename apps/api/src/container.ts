// Wires the application together. Explicit construction, no reflection: you
// can read this file and see every dependency each part has.

import path from "node:path";
import { systemClock, type Clock } from "./platform/clock.ts";
import type { Config } from "./platform/config.ts";
import { SecretBox, type ScryptCost } from "./platform/crypto.ts";
import { openDb, type Db } from "./platform/db/db.ts";
import { migrate } from "./platform/db/migrate.ts";
import { JobRunner, type Job, type JobHandler } from "./platform/jobs/queue.ts";
import { runDetectors } from "./modules/detection/service.ts";
import { ClaudeEvidenceAi, type EvidenceAi } from "./modules/evidence/ai.ts";
import { OperationExecutor } from "./modules/execution/executor.ts";
import { FxService } from "./modules/fx/service.ts";
import type { Deps as IdentityDeps } from "./modules/identity/service.ts";
import { PayPalConnections } from "./modules/paypal/connections.ts";
import { processProviderEvent } from "./modules/paypal/webhooks.ts";
import { syncTransactions } from "./modules/transactions/sync.ts";

export type Container = {
  config: Config;
  db: Db;
  clock: Clock;
  deps: { db: Db; clock: Clock };
  /** Claude, for reading evidence. Null when no API key is set: every AI step then says so and the rest works. */
  ai: EvidenceAi | null;
  identity: IdentityDeps;
  secrets: SecretBox;
  connections: PayPalConnections;
  executor: OperationExecutor;
  fx: FxService;
  runner: JobRunner;
  handlers: Record<string, JobHandler>;
};

export type Overrides = { db?: Db; clock?: Clock; fetchImpl?: typeof fetch; passwordCost?: ScryptCost; workerId?: string; ai?: EvidenceAi | null };

export async function createContainer(config: Config, overrides: Overrides = {}): Promise<Container> {
  const clock = overrides.clock ?? systemClock;
  const db =
    overrides.db ??
    (await openDb(config.databaseUrl ? { url: config.databaseUrl } : { pglite: "file", dataDir: path.join(config.dataDir, "pg") }));
  if (!overrides.db) await migrate(db);

  const secrets = new SecretBox({ k1: config.encryptionKey }, "k1");
  const deps = { db, clock };
  const ai: EvidenceAi | null =
    overrides.ai !== undefined ? overrides.ai : config.anthropicApiKey ? new ClaudeEvidenceAi({ apiKey: config.anthropicApiKey, model: config.model }) : null;
  const connections = new PayPalConnections({ db, clock, secrets, config, fetchImpl: overrides.fetchImpl });
  const executor = new OperationExecutor({ db, clock, providers: connections.resolve });
  const fx = new FxService({ db, clock, apiUrl: config.fxApiUrl, fetchImpl: overrides.fetchImpl });

  const handlers: Record<string, JobHandler> = {
    ...executor.handlers(),
    "paypal.sync": async (job: Job) => {
      const { connectionId, from, to } = job.payload as { connectionId: string; from: string; to: string };
      const orgId = job.org_id!;
      const provider = await connections.resolve(orgId, connectionId);
      await syncTransactions(deps, { orgId, connectionId, provider, from: new Date(from), to: new Date(to) });
      await runDetectors(deps, orgId);
    },
    "provider_event.process": async (job: Job) => {
      await processProviderEvent(deps, String(job.payload.providerEventId));
    },
    "detectors.run": async (job: Job) => {
      await runDetectors(deps, job.org_id!);
    },
  };
  const runner = new JobRunner(db, handlers, {
    workerId: overrides.workerId ?? `worker-${process.pid}`,
    clock,
    onError: (job, err) => {
      if (config.logLevel !== "silent") console.error(`[jobs] ${job.type} ${job.id} failed:`, err instanceof Error ? err.message : err);
    },
  });

  return {
    config, db, clock, deps, ai, secrets, connections, executor, fx, runner, handlers,
    identity: { db, clock, passwordCost: overrides.passwordCost },
  };
}
