// The job worker as its own process: payments, reconciliation, syncs and
// webhook events. Run as many as needed; jobs are claimed with
// SELECT ... FOR UPDATE SKIP LOCKED, so two workers never take the same job.
//
// Needs DATABASE_URL: the built-in local database can be opened by one
// process only, so there the API runs the worker itself.

import { createContainer } from "./container.ts";
import { loadConfig } from "./platform/config.ts";
import { enqueue } from "./platform/jobs/queue.ts";

const config = loadConfig();
if (!config.databaseUrl) {
  console.error("The separate worker needs DATABASE_URL. Without it, start the API with WORKER_INLINE=1 instead.");
  process.exit(1);
}
const container = await createContainer(config);
container.runner.start();
const sweep = () => void enqueue(container.db, { type: "operations.sweep", dedupeKey: "operations.sweep" }, container.clock.now()).catch(() => undefined);
sweep();
const timer = setInterval(sweep, 60_000);
console.log(`Make Good worker started (${Object.keys(container.handlers).length} job types).`);

async function shutdown(): Promise<void> {
  clearInterval(timer);
  await container.runner.stop();
  await container.db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
