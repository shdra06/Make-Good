// The API process (JSON only; the web app is apps/web). In development it also
// runs the job worker, so one command starts everything. In production run `node src/worker.ts` separately and set
// WORKER_INLINE=0 here.

import { buildApp } from "./api/routes.ts";
import { createContainer } from "./container.ts";
import { loadConfig } from "./platform/config.ts";
import { enqueue } from "./platform/jobs/queue.ts";

const config = loadConfig();
const container = await createContainer(config);
const { app } = buildApp(container);

let sweepTimer: NodeJS.Timeout | null = null;
if (config.workerInline) {
  container.runner.start();
  const sweep = () => void enqueue(container.db, { type: "operations.sweep", dedupeKey: "operations.sweep" }, container.clock.now()).catch(() => undefined);
  sweep();
  sweepTimer = setInterval(sweep, 60_000);
}

await app.listen({ port: config.port, host: "0.0.0.0" });
if (!(await container.db.rowSecurity())) {
  app.log.warn("Row-level security does not apply to this database user (a superuser without the makegood_app role). Shops are still kept apart by the app's own checks.");
}
if (config.env === "production" && config.email.transport === "file") {
  app.log.warn("EMAIL_TRANSPORT is file: emails are written to the outbox folder, not sent. Set EMAIL_TRANSPORT=resend and RESEND_API_KEY to send them.");
}
if (config.encryptionKeySource === "generated-for-development") {
  app.log.warn("Using a development encryption key from the data folder. Set MAKEGOOD_ENCRYPTION_KEY for anything real.");
}

async function shutdown(): Promise<void> {
  if (sweepTimer) clearInterval(sweepTimer);
  await app.close();
  await container.runner.stop();
  await container.db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
